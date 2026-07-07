// api/chat.js
//
// Vercel serverless function. Takes a conversation history + session metadata,
// streams Claude's reply back to the client chunk-by-chunk (Week 5 addition —
// previously this buffered the entire response before returning anything),
// then validates any recommendations against iTunes, retries hallucinations
// once, and logs events.
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
// "<!--RIFF_RADAR_RECS:" (20 chars) plus a small safety margin. This adds
// no perceptible delay — it's a rolling few-character lag, not a pause.
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
        `\n\n# Machine-readable recommendation metadata (internal, never shown to the user)\n` +
        `Whenever your reply includes the 3-recommendation block, end your entire response ` +
        `with exactly one HTML comment on its own line, after everything else, in this exact format:\n` +
        `<!--RIFF_RADAR_RECS:[{"track":"Song Title","artist":"Artist Name"},{"track":"...","artist":"..."},{"track":"...","artist":"..."}]-->\n` +
        `This must contain exactly the 3 tracks you just recommended, in the same order, with the ` +
        `exact track and artist names (not URL-encoded, not abbreviated). Do not include this comment ` +
        `if your reply does not contain recommendations. This comment is stripped before the user sees ` +
        `your reply, so it does not need to fit your voice or formatting rules.`,
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

  let sseBuffer = '';    // holds partial SSE event text across chunk boundaries
  let fullText = '';     // the complete raw reply, including the hidden comment
  let emittedLength = 0; // how much of fullText we've already sent to the client
  let commentStartIdx = -1; // index in fullText where "<!--" was first seen, once found
  let stopReason = null;

  function processDeltaText(deltaText) {
    fullText += deltaText;

    if (commentStartIdx === -1) {
      commentStartIdx = fullText.indexOf(RECS_MARKER_START);
    }

    if (commentStartIdx !== -1) {
      // Once we've seen the start of a comment, emit everything up to it
      // (if not already emitted) and never emit anything after it.
      if (emittedLength < commentStartIdx) {
        const safe = fullText.slice(emittedLength, commentStartIdx);
        if (safe) res.write(JSON.stringify({ type: 'delta', text: safe }) + '\n');
        emittedLength = commentStartIdx;
      }
      return;
    }

    // No comment marker seen yet — emit everything except the last
    // HOLDBACK_CHARS, which might be the start of "<!--" split across
    // the next chunk.
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

    // SSE events are separated by a blank line.
    const events = sseBuffer.split('\n\n');
    sseBuffer = events.pop(); // last piece may be incomplete, keep it buffered

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

  // Flush anything still held back (only relevant if no comment marker
  // ever appeared — a reply with no recommendations at all).
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
    'X-Accel-Buffering': 'no', // disables proxy buffering some hosts apply to chunked responses
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
        // Note: this retry can only correct the recommendation CARDS sent
        // in the final 'done' event below — it cannot retroactively edit
        // the prose already streamed to the screen above. If Groove's
        // visible text named the hallucinated track, that text stays as
        // written; only the card underneath reflects the validated
        // replacement. This is a known tradeoff of combining live
        // streaming with the silent hallucination-retry safety net.
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
    // The response is already chunked and may be partially sent, so we
    // can't fall back to res.status(500).json(...) here — write an error
    // event in the same NDJSON protocol instead so the client can show
    // something honest rather than hanging.
    try {
      res.write(JSON.stringify({ type: 'error', message: 'Internal server error' }) + '\n');
    } catch {
      // response may already be closed; nothing more we can do
    }
    res.end();
  }
}

// Re-prompts Claude to replace only the tracks that failed iTunes validation.
// This one stays non-streaming (buffered) — it's a silent, invisible-to-the-
// user correction pass, not something that needs to render live.
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