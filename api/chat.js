// api/chat.js
//
// Vercel serverless function. Takes a conversation history + session metadata,
// streams Claude's reply back to the client chunk-by-chunk, validates any
// recommendations against iTunes, drops anything that doesn't pass (no
// retry round-trip — see note below), and logs events.
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

// STATIC_APP_INSTRUCTIONS is identical on every single request — it doesn't
// depend on lore stage, session count, or anything per-user. Previously
// this whole block (plus the lore addendum) was ONE uncached system block,
// meaning it got fully reprocessed as fresh input tokens on every call.
// Splitting it into its own cache_control breakpoint means only the small,
// genuinely-dynamic tail (lore stage + do-not-repeat list) is ever
// processed uncached — this is likely the single biggest latency win
// available here, bigger than any amount of trimming reply length.
const STATIC_APP_INSTRUCTIONS = `# App-specific overrides for Riff Radar
This app renders recommendations as visual cards (art, preview player, real Apple
Music and Spotify links) and does not display raw links or per-song paragraphs in
the chat text. Overrides to your normal behavior, for this app only:

1. Do NOT include a Spotify or Apple Music search link anywhere in your visible reply.

2. Whenever you would give the 3-recommendation block: your VISIBLE reply text must
contain ONLY your opening reflective sentences about the moment the user shared (1-2
sentences, same warm, specific, musically-grounded voice as always). Do NOT include
song titles, artist names, per-song explanations, or your closing refinement question
in the visible text. All of that moves into the hidden metadata block below instead,
because the app renders it separately (cards, then the question underneath). This is
a significant shortening of your visible reply for this app specifically; it does not
change how much you'd normally say elsewhere.

3. The 3 recommended artists in a single response must all be DIFFERENT FROM EACH
OTHER, not just different from the bookmarked artist. Never recommend the same artist
twice across the 3 slots.

If your reply is pure conversation with no recommendations, ignore the length
restriction in #2 and respond completely normally with no length restriction.

# Machine-readable recommendation metadata (internal, never shown to the user)
Whenever your reply includes the 3-recommendation block, end your entire response
with exactly one HTML comment on its own line, after everything else, in this exact format:
<!--RIFF_RADAR_RECS:{"recs":[{"track":"Song Title","artist":"Artist Name","matchAxis":"Structural twin","genre":"Genre tag","explanation":"One single sentence, 20 words or fewer, on the musical link."},{"track":"...","artist":"...","matchAxis":"Adjacent genre","genre":"...","explanation":"..."},{"track":"...","artist":"...","matchAxis":"Surprise pick","genre":"...","explanation":"..."}],"followUpQuestion":"Your normal closing refinement question, offering two concrete directions."}-->
"matchAxis" must be exactly one of: "Structural twin", "Adjacent genre", "Surprise pick",
matching which of the 3 slots each track fills. "explanation" MUST be exactly one
sentence, 20 words or fewer, plain text, no markdown, no links. "followUpQuestion" is
plain text, no markdown. Do not include this comment if your reply does not contain
recommendations. This comment is stripped before the user sees your reply, so none of
it needs to fit your voice or formatting rules.`;

function buildDynamicBlock(loreAddendum, previousRecommendations) {
  const loreText = loreAddendum || '(No lore addendum active yet — this is a new user.)';

  let doNotRepeatText = '';
  if (Array.isArray(previousRecommendations) && previousRecommendations.length > 0) {
    const list = previousRecommendations
      .map((r) => `"${r.track}" by ${r.artist}`)
      .join(', ');
    doNotRepeatText =
      `\n\n# Tracks already recommended this session\n` +
      `Do NOT recommend any of these tracks again in this session, even if they'd ` +
      `otherwise be a great fit: ${list}. Pick different tracks instead.`;
  }

  return loreText + doNotRepeatText;
}

function buildSystemBlocks(loreAddendum, previousRecommendations) {
  return [
    {
      type: 'text',
      text: GROOVE_BASE_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: STATIC_APP_INSTRUCTIONS,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: buildDynamicBlock(loreAddendum, previousRecommendations),
      // Deliberately NOT cached — this is the one block that actually
      // changes per request (lore stage, growing do-not-repeat list), so
      // caching it would provide no benefit and would need constant
      // invalidation anyway.
    },
  ];
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

async function callAnthropicStream({ messages, loreAddendum, previousRecommendations }) {
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
      system: buildSystemBlocks(loreAddendum, previousRecommendations),
      messages,
    }),
  });
}

async function streamClaudeReply({ messages, loreAddendum, previousRecommendations, res }) {
  let anthropicRes = await callAnthropicStream({ messages, loreAddendum, previousRecommendations });

  if (!anthropicRes.ok && RETRYABLE_STATUSES.has(anthropicRes.status)) {
    console.warn(`Anthropic API returned ${anthropicRes.status}, retrying once.`);
    anthropicRes = await callAnthropicStream({ messages, loreAddendum, previousRecommendations });
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

  const { messages: rawMessages, sessionCount = 0, sessionId, previousRecommendations = [] } = req.body;

  if (!rawMessages || !Array.isArray(rawMessages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Defensive sanitization: Anthropic's API rejects any message object with
  // fields beyond {role, content}.
  const messages = rawMessages.map(({ role, content }) => ({ role, content }));

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

    const rawReplyText = await streamClaudeReply({
      messages,
      loreAddendum,
      previousRecommendations,
      res,
    });
    const { recs, followUpQuestion, cleanedReply } = extractStructuredRecs(rawReplyText);

    let replyText = cleanedReply;
    let enrichedRecs = [];

    if (recs.length > 0) {
      const validated = await validateAndEnrichRecs(recs);

      // No retry round-trip. A track that fails validation (no real artist
      // match, or no preview available) is simply dropped rather than
      // spending a full extra Claude call trying to fix it — that retry
      // was both slow (a full second generation + re-validation pass) and,
      // per testing, didn't even reliably succeed: a replacement could
      // itself fail validation and still ship broken. Showing 2 solid
      // cards instead of 3 is a better outcome than either a broken card
      // or a multi-second delay chasing a guaranteed third.
      enrichedRecs = validated.filter((r) => r.itunesValidation === 'found');
      const dropped = validated.filter((r) => r.itunesValidation === 'not_found');

      if (sessionId && dropped.length > 0) {
        logEvent(sessionId, 'itunes_validation_failed', {
          failed_tracks: dropped.map((r) => ({ track: r.track, artist: r.artist })),
          failed_count: dropped.length,
          total_recs: recs.length,
        });
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