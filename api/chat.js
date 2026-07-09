// api/chat.js
//
// Vercel serverless function. Takes a conversation history + session metadata,
// streams Claude's reply back to the client chunk-by-chunk, then validates any
// recommendations against iTunes, retries hallucinations once, and logs events.
//
// Response protocol (newline-delimited JSON, one object per line):
//   {"type":"delta","text":"..."}                          — a chunk of Groove's visible reply
//   {"type":"done","recs":[...],"followUpQuestion":"..."}  — stream finished
//   {"type":"error","message":"..."}                        — something went wrong mid-stream
//
// Logs three event types to Supabase:
//   message_sent, rec_generated, itunes_validation_failed

import { GROOVE_BASE_PROMPT, getLoreAddendum } from '../src/groovePrompt.js';
import { logEvent } from '../src/supabaseClient.js';
import { validateAndEnrichRecs } from './lib/validateTracks.js';

const RECS_MARKER_START = '<!--';
const HOLDBACK_CHARS = 24;

function extractStructuredRecs(replyText) {
  const match = replyText.match(/<!--RIFF_RADAR_RECS:(\{.*?\})-->/s);
  if (!match) return { recs: [], followUpQuestion: '', cleanedReply: replyText };

  let parsed = {};
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    console.error('Failed to parse RIFF_RADAR_RECS block:', err, match[1]);
  }

  const cleanedReply = replyText.replace(match[0], '').trimEnd();
  return {
    recs: Array.isArray(parsed.recs) ? parsed.recs : [],
    followUpQuestion: typeof parsed.followUpQuestion === 'string' ? parsed.followUpQuestion : '',
    cleanedReply,
  };
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
        `\n\n# App-specific overrides for Riff Radar\n` +
        `This app renders recommendations as visual cards (art, preview player, real Apple ` +
        `Music and Spotify links) and does not display raw links or per-song paragraphs in ` +
        `the chat text. Two overrides to your normal behavior, for this app only:\n\n` +
        `1. Do NOT include a Spotify or Apple Music search link anywhere in your visible reply.\n\n` +
        `2. Whenever you would give the 3-recommendation block: your VISIBLE reply text must ` +
        `contain ONLY your opening reflective sentences about the moment the user shared (1-2 ` +
        `sentences, same warm, specific, musically-grounded voice as always). Do NOT include ` +
        `song titles, artist names, per-song explanations, or your closing refinement question ` +
        `in the visible text. All of that moves into the hidden metadata block below instead, ` +
        `because the app renders it separately (cards, then the question underneath). This is ` +
        `a significant shortening of your visible reply for this app specifically; it does not ` +
        `change how much you'd normally say elsewhere.\n\n` +
        `If your reply is pure conversation with no recommendations, ignore both overrides above ` +
        `and respond completely normally with no length restriction.\n\n` +
        `# Machine-readable recommendation metadata (internal, never shown to the user)\n` +
        `Whenever your reply includes the 3-recommendation block, end your entire response ` +
        `with exactly one HTML comment on its own line, after everything else, in this exact format:\n` +
        `<!--RIFF_RADAR_RECS:{"recs":[{"track":"Song Title","artist":"Artist Name","matchAxis":"Structural twin","genre":"Genre tag","explanation":"One single sentence, 20 words or fewer, on the musical link."},{"track":"...","artist":"...","matchAxis":"Adjacent genre","genre":"...","explanation":"..."},{"track":"...","artist":"...","matchAxis":"Surprise pick","genre":"...","explanation":"..."}],"followUpQuestion":"Your normal closing refinement question, offering two concrete directions."}-->\n` +
        `"matchAxis" must be exactly one of: "Structural twin", "Adjacent genre", "Surprise pick", ` +
        `matching which of the 3 slots each track fills. "explanation" MUST be exactly one ` +
        `sentence, 20 words or fewer, plain text, no markdown, no links. "followUpQuestion" is ` +
        `plain text, no markdown. Do not include this comment if your reply does not contain ` +
        `recommendations. This comment is stripped before the user sees your reply, so none of ` +
        `it needs to fit your voice or formatting rules.`,
    },
  ];
}

// Anthropic occasionally returns a transient 5xx (overloaded, momentary
// upstream issue) that has nothing to do with the request itself. This
// wraps the streaming call with exactly one retry on those specific
// statuses, since a mid-conversation "Internal server error" with no
// obvious cause in our own code is the most likely explanation for that —
// though if it recurs, Vercel's function logs for that request will show
// the actual status code and body, which this retry can't fully replace
// as a debugging tool.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

async function callAnthropicStream({ messages, loreAddendum }) {
  return fetch('https://api.anthropic.com/v1/messages', {
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
}

async function streamClaudeReply({ messages, loreAddendum, res }) {
  let anthropicRes = await callAnthropicStream({ messages, loreAddendum });

  if (!anthropicRes.ok && RETRYABLE_STATUSES.has(anthropicRes.status)) {
    console.warn(`Anthropic API returned ${anthropicRes.status}, retrying once.`);
    anthropicRes = await callAnthropicStream({ messages, loreAddendum });
  }

  if (!anthropicRes.ok || !anthropicRes.body) {
    const errorBody = await anthropicRes.text().catch(() => '');
    console.error('Anthropic API error after retry:', anthropicRes.status, errorBody);
    throw new Error(`Claude API request failed (${anthropicRes.status}): ${errorBody.slice(0, 500)}`);
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
      } else if (payload.type === 'error') {
        console.error('Anthropic in-stream error event:', payload.error);
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
    const { recs, followUpQuestion, cleanedReply } = extractStructuredRecs(rawReplyText);

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

    res.write(JSON.stringify({ type: 'done', recs: enrichedRecs, followUpQuestion }) + '\n');
    res.end();
  } catch (err) {
    console.error('Error in /api/chat:', err);
    try {
      res.write(
        JSON.stringify({
          type: 'error',
          message: 'Groove hit a snag putting that together. Mind trying that message again?',
        }) + '\n'
      );
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