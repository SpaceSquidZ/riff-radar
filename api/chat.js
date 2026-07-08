// api/chat.js
//
// Vercel serverless function. Takes a conversation history + session metadata,
// streams Claude's reply back to the client chunk-by-chunk, then validates any
// recommendations against iTunes, retries hallucinations once, and logs events.
//
// Response protocol (newline-delimited JSON, one object per line):
//   {"type":"delta","text":"..."}   — a chunk of Groove's visible reply
//   {"type":"done","recs":[...]}    — stream finished; final validated recs
//   {"type":"error","message":"..."} — something went wrong mid-stream
//
// Logs three event types to Supabase:
//   message_sent, rec_generated, itunes_validation_failed

import { GROOVE_BASE_PROMPT, getLoreAddendum } from '../src/groovePrompt.js';
import { logEvent } from '../src/supabaseClient.js';
import { validateAndEnrichRecs } from './lib/validateTracks.js';

const RECS_MARKER_START = '<!--';

// How many trailing characters of the stream we hold back from the client
// at any given moment, in case they're the start of the hidden comment
// arriving split across multiple stream chunks. 24 comfortably covers
// "<!--RIFF_RADAR_RECS:" (20 chars) plus a small safety margin.
const HOLDBACK_CHARS = 24;

function extractStructuredRecs(replyText) {
  const match = replyText.match(/<!--RIFF_RADAR_RECS:(\[.*?\])-->/s);
  if (!match) return { recs: [], cleanedReply: replyText };

  let recs = [];
  try {
    recs = JSON.parse(match[1]);
  } catch (err) {
    console.error('Failed to parse RIFF_RADAR_RECS block:', err, match[1]);
  }

  const cleanedReply = replyText.replace(match[0], '').trimEnd();
  return { recs, cleanedReply };
}

// This addendum is appended per-request, not written into groovePrompt.js.
// It does two things beyond the lore addendum:
//   1. Overrides the base prompt's "always include a Spotify link" hard rule
//      for THIS app specifically, since RecommendationCard now renders the
//      real Apple Music + Spotify links itself. Groove's persona file keeps
//      its own rule as originally written; this is a per-integration
//      override layered on top, not an edit to that file.
//   2. Asks for a richer hidden metadata block (matchAxis, genre, a short
//      explanation) so RecommendationCard can render real song info instead
//      of just a bare track/artist pair.
function buildSystemBlocks(loreAddendum) {
  return [
    {
      type: 'text',
      text: GROOVE_BASE_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text:
        (loreAddendum || '(No lore addendum active yet — this is a new user.)') +
        `\n\n# App-specific override: no inline search links\n` +
        `This app (Riff Radar) renders a real Apple Music link and Spotify search link ` +
        `automatically underneath each recommendation card. Do NOT include a Spotify or ` +
        `Apple Music search link in your visible reply text for any recommendation. Simply ` +
        `end each recommendation's explanation naturally, without a link. This overrides the ` +
        `link-inclusion instruction elsewhere in your instructions for this app specifically.\n\n` +
        `# Machine-readable recommendation metadata (internal, never shown to the user)\n` +
        `Whenever your reply includes the 3-recommendation block, end your entire response ` +
        `with exactly one HTML comment on its own line, after everything else, in this exact format:\n` +
        `<!--RIFF_RADAR_RECS:[{"track":"Song Title","artist":"Artist Name","matchAxis":"Structural twin","genre":"Genre tag","explanation":"One short sentence on the musical link, no timestamp callout needed here."},{"track":"...","artist":"...","matchAxis":"Adjacent genre","genre":"...","explanation":"..."},{"track":"...","artist":"...","matchAxis":"Surprise pick","genre":"...","explanation":"..."}]-->\n` +
        `This must contain exactly the 3 tracks you just recommended, in the same order, with ` +
        `exact track and artist names (not URL-encoded, not abbreviated). "matchAxis" must be ` +
        `exactly one of: "Structural twin", "Adjacent genre", "Surprise pick", matching which of ` +
        `the 3 recommendation slots each track fills. "explanation" should be a single short ` +
        `sentence, plain text, no markdown. Do not include this comment if your reply does not ` +
        `contain recommendations. This comment is stripped before the user sees your reply, so ` +
        `it does not need to fit your voice or formatting rules.`,
    },
  ];
}

// Streams one Claude call and relays visible text to res as NDJSON deltas,
// withholding anything from the hidden RIFF_RADAR_RECS comment onward.
// Returns the full raw text (including the hidden comment) once done, so
// the caller can extract structured recs after the stream finishes.
async function streamClaudeReply({ messages, loreAddendum, res }) {
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2500,
      stream: true,
      system: buildSystemBlocks(loreAddendum),
      messages,
    }),
  });

  if (!anthropicRes.ok || !anthropicRes.body) {
    const errorBody = await anthropicRes.text().catch(() => '');
    console.error('Anthropic API error:', anthropicRes.status, errorBody);
    throw new Error(`Claude API request failed (${anthropicRes.status})`);
  }

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();

  let sseBuffer = '';
  let fullText = '';
  let emittedLength = 0;
  let commentStartIdx = -1;
  let stopReason = null;

  function processDeltaText(deltaText) {
    fullText += deltaText;

    if (commentStartIdx === -1) {
      commentStartIdx = fullText.indexOf(RECS_MARKER_START);
    }

    if (commentStartIdx !== -1) {
      if (emittedLength < commentStartIdx) {
        const safe = fullText.slice(emittedLength, commentStartIdx);
        if (safe) res.write(JSON.stringify({ type: 'delta', text: safe }) + '\n');
        emittedLength = commentStartIdx;
      }
      return;
    }

    const safeEnd = Math.max(0, fullText.length - HOLDBACK_CHARS);
    if (safeEnd > emittedLength) {
      const safe = fullText.slice(emittedLength, safeEnd);
      if (safe) res.write(JSON.stringify({ type: 'delta', text: safe }) + '\n');
      emittedLength = safeEnd;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });

    const events = sseBuffer.split('\n\n');
    sseBuffer = events.pop();

    for (const rawEvent of events) {
      const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;

      let payload;
      try {
        payload = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }

      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        processDeltaText(payload.delta.text);
      } else if (payload.type === 'message_delta' && payload.delta?.stop_reason) {
        stopReason = payload.delta.stop_reason;
      }
    }
  }

  if (commentStartIdx === -1 && emittedLength < fullText.length) {
    res.write(JSON.stringify({ type: 'delta', text: fullText.slice(emittedLength) }) + '\n');
    emittedLength = fullText.length;
  }

  if (stopReason === 'max_tokens') {
    console.warn('Groove reply was truncated by max_tokens. Consider raising the limit further.');
  }

  return fullText;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, sessionCount = 0, sessionId } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  try {
    const lastUserMessage = messages[messages.length - 1];
    if (sessionId && lastUserMessage?.role === 'user') {
      logEvent(sessionId, 'message_sent', {
        role: 'user',
        content_length: lastUserMessage.content.length,
      });
    }

    const loreAddendum = getLoreAddendum(sessionCount);

    const rawReplyText = await streamClaudeReply({ messages, loreAddendum, res });
    const { recs, cleanedReply } = extractStructuredRecs(rawReplyText);

    let replyText = cleanedReply;
    let enrichedRecs = [];

    if (recs.length > 0) {
      enrichedRecs = await validateAndEnrichRecs(recs);
      const failed = enrichedRecs.filter((r) => r.itunesValidation === 'not_found');

      if (sessionId && failed.length > 0) {
        logEvent(sessionId, 'itunes_validation_failed', {
          failed_tracks: failed.map((r) => ({ track: r.track, artist: r.artist })),
          failed_count: failed.length,
          total_recs: recs.length,
        });
      }

      if (failed.length > 0) {
        const retryResult = await retryFailedRecs({
          messages,
          loreAddendum,
          failed,
          goodRecs: enrichedRecs.filter((r) => r.itunesValidation !== 'not_found'),
        });
        if (retryResult) {
          enrichedRecs = retryResult;
        }
      }
    }

    if (sessionId) {
      logEvent(sessionId, 'message_sent', {
        role: 'assistant',
        content_length: replyText.length,
      });

      if (enrichedRecs.length > 0) {
        logEvent(sessionId, 'rec_generated', {
          recommendation_count: enrichedRecs.length,
          tracks: enrichedRecs.map((r) => `${r.track} - ${r.artist}`),
        });
      }
    }

    res.write(JSON.stringify({ type: 'done', recs: enrichedRecs }) + '\n');
    res.end();
  } catch (err) {
    console.error('Error in /api/chat:', err);
    try {
      res.write(JSON.stringify({ type: 'error', message: 'Internal server error' }) + '\n');
    } catch {
      // response may already be closed
    }
    res.end();
  }
}

async function retryFailedRecs({ messages, loreAddendum, failed, goodRecs }) {
  try {
    const retryInstruction = {
      role: 'user',
      content:
        `[internal, do not mention this message to the user] The following recommendations ` +
        `could not be verified against a real music catalog and must be replaced with different, ` +
        `real, existing tracks that fit the same match axis: ` +
        failed.map((r) => `"${r.track}" by ${r.artist}`).join(', ') +
        `. Keep these existing recommendations as-is: ` +
        goodRecs.map((r) => `"${r.track}" by ${r.artist}`).join(', ') +
        `. Respond with the full corrected 3-recommendation block in your normal voice and format, ` +
        `ending with the RIFF_RADAR_RECS metadata comment as instructed.`,
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2500,
        system: buildSystemBlocks(loreAddendum),
        messages: [...messages, retryInstruction],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const rawReplyText = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const { recs: retriedRecs } = extractStructuredRecs(rawReplyText);
    if (retriedRecs.length === 0) return null;

    return await validateAndEnrichRecs(retriedRecs);
  } catch (err) {
    console.error('Retry-for-hallucination pass failed:', err);
    return null;
  }
}