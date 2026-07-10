// api/chat.js
//
// Vercel serverless function. Takes a conversation history + session metadata,
// streams Claude's reply back to the client chunk-by-chunk, validates any
// recommendations against iTunes, drops anything that doesn't pass, and
// logs events.
//
// Response protocol (newline-delimited JSON, one object per line):
//   {"type":"delta","text":"..."}              — a chunk of Groove's visible reply
//   {"type":"recs_starting"}                    — server began the hidden rec
//                                                 metadata; recs ARE coming (the
//                                                 "Groove is preparing" cue)
//   {"type":"rec_ready","rec":{...}}            — one validated card, emitted the
//                                                 moment its own iTunes lookup
//                                                 resolves (progressive reveal)
//   {"type":"done","followUpQuestion":"..."}   — stream finished
//   {"type":"error","message":"..."}            — something went wrong mid-stream
//
// Logs three event types to Supabase:
//   message_sent, rec_generated, itunes_validation_failed

import { GROOVE_BASE_PROMPT, getLoreAddendum } from '../src/groovePrompt.js';
import { logEvent } from '../src/supabaseClient.js';
import { validateOneTrack } from './lib/validateTracks.js';

// Vercel kills a serverless function outright once it exceeds its max
// execution duration — no error event, no graceful close, the connection
// just drops. That would look exactly like a reply that silently stops
// mid-stream with no error message. 60s is the max allowed on Vercel's
// Hobby tier; raising it here gives real headroom for a slow upstream
// call instead of leaving the default (much shorter) limit as an
// invisible ceiling.
export const config = {
  maxDuration: 60,
};

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

2a. CRITICAL — the closing refinement question goes ONLY in the followUpQuestion field
of the hidden metadata, NEVER in your visible reply text. Do not end your visible
reflection with the question, or any rephrasing of it. The app renders it beneath the
cards from the metadata field; if you also write it in your prose it appears TWICE to
the user. Your visible reply must simply stop after the opening reflection — no closing
question, no "here are some options" hand-off line.

2b. NEVER state or imply a specific NUMBER of recommendations in your visible reply.
Do not write "here are three directions", "three picks", "a trio", or any counted
lead-in — the app may show fewer than three cards (some can't be verified), so any
number you name can be contradicted on screen. Either use count-free phrasing ("here
are a few directions from there") or let the cards simply follow your reflection with
no lead-in at all.

3. The 3 recommended artists in a single response must all be DIFFERENT FROM EACH
OTHER, not just different from the bookmarked artist. Never recommend the same artist
twice across the 3 slots.

4. When you have asked the user an either/or refinement question and they reply,
interpret their answer GENEROUSLY. Users answer casually and partially, not by
quoting your exact options. Treat replies like "other english is fine", "the second
one", "yeah the weirder beat", "let's go broader", "stay put", "the first", "more of
that" as clear, valid selections — map them to whichever option they most plausibly
mean and act on it. Do NOT tell the user they didn't pick an option, do NOT re-ask the
same question, and do NOT stall for a more precise answer. Only ask for clarification
if a reply is genuinely ambiguous between your two options (not merely informal). When
in doubt, pick the more likely reading and proceed — moving forward with a reasonable
guess is far better than making the user feel they answered wrong.

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

// Both static blocks now use a 1-HOUR cache TTL instead of the 5-minute
// default. Rationale: this is a conversational app where a real person
// reads a reply, thinks, maybe listens to a preview, then responds — gaps
// between actual API calls of more than 5 minutes are normal human
// behavior, not an edge case. Under the 5-minute default, most real
// conversational turns would miss the cache entirely and pay full
// uncached processing cost (which is also the slow path) on nearly every
// message. The 1-hour TTL costs more on the first write in a given
// window (2x base price vs 1.25x) but every read within that hour is the
// same 90%-cheaper, faster cached path — worth it for this usage pattern.
const CACHE_CONTROL_1H = { type: 'ephemeral', ttl: '1h' };

function buildSystemBlocks(loreAddendum, previousRecommendations) {
  return [
    {
      type: 'text',
      text: GROOVE_BASE_PROMPT,
      cache_control: CACHE_CONTROL_1H,
    },
    {
      type: 'text',
      text: STATIC_APP_INSTRUCTIONS,
      cache_control: CACHE_CONTROL_1H,
    },
    {
      type: 'text',
      text: buildDynamicBlock(loreAddendum, previousRecommendations),
      // Deliberately uncached — the one block that actually changes per
      // request (lore stage, growing do-not-repeat list).
    },
  ];
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

// Coarse language sniff from the user's own words, used only to widen which
// iTunes storefronts we search during validation. This is deliberately
// simple (script-range heuristics, not a full language model) because it
// only needs to answer "should we also look in the Korean / Chinese /
// Japanese store?" — a wrong guess just means an extra store search or a
// missed one, never a broken reply. If the client ever passes an explicit
// franc-derived code, that takes precedence over this.
function detectLanguageHint(messages) {
  const userText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' ');

  // Script ranges are the strongest signal when present.
  if (/[\uac00-\ud7af]/.test(userText)) return 'ko'; // Hangul
  if (/[\u3040-\u30ff]/.test(userText)) return 'ja'; // kana (hiragana/katakana)
  if (/[\u4e00-\u9fff]/.test(userText)) return 'zh'; // CJK ideographs
  if (/[\u0e00-\u0e7f]/.test(userText)) return 'th'; // Thai

  return null; // no strong signal — validation falls back to script + US
}

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
      max_tokens: 3072,
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
  let announcedRecsStarting = false;
  let stopReason = null;

  function processDeltaText(deltaText) {
    fullText += deltaText;

    if (commentStartIdx === -1) {
      commentStartIdx = fullText.indexOf(RECS_MARKER_START);
    }

    if (commentStartIdx !== -1) {
      if (!announcedRecsStarting) {
        announcedRecsStarting = true;
        res.write(JSON.stringify({ type: 'recs_starting' }) + '\n');
      }

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
    // Carry enough context to actually identify WHICH reply hit the ceiling
    // when scanning Vercel logs — length and a short prefix of the reply.
    console.warn(
      `Groove reply truncated by max_tokens (length ${fullText.length}). ` +
        `First 120 chars: ${JSON.stringify(fullText.slice(0, 120))}`
    );
  }

  return fullText;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages: rawMessages, sessionCount = 0, sessionId, previousRecommendations = [], languageHint: clientLanguageHint } = req.body;

  if (!rawMessages || !Array.isArray(rawMessages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

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
      const languageHint = clientLanguageHint || detectLanguageHint(messages);

      // Progressive validation (Option 3): instead of validating all three
      // tracks, waiting for the slowest, then sending them together, each
      // track is validated in parallel and its card is emitted the moment
      // ITS OWN iTunes lookup returns. The frontend appends cards as they
      // arrive, so the grid grows 0 -> 1 -> 2 -> 3 rather than appearing all
      // at once after a dead pause. Growing never looks like the "dwindling"
      // a fixed 3-skeleton grid did, because cards are only ever added.
      const kept = [];
      const dropped = [];

      await Promise.all(
        recs.map(async (rec) => {
          const { status, enriched } = await validateOneTrack(rec, languageHint);
          const enrichedRec = {
            ...rec,
            itunesValidation: status,
            previewUrl: enriched?.previewUrl ?? null,
            artworkUrl: enriched?.artworkUrl ?? null,
            trackViewUrl: enriched?.trackViewUrl ?? null,
            releaseYear: enriched?.releaseYear ?? null,
          };

          if (status !== 'not_found') {
            // Real track (or unconfirmed network failure) — show it now.
            kept.push(enrichedRec);
            res.write(JSON.stringify({ type: 'rec_ready', rec: enrichedRec }) + '\n');
          } else {
            // Hold confirmed hallucinations; whether they show at all depends
            // on whether ANYTHING else survived (see fallback below).
            dropped.push(enrichedRec);
          }
        })
      );

      if (sessionId && dropped.length > 0) {
        logEvent(sessionId, 'itunes_validation_failed', {
          failed_tracks: dropped.map((r) => ({ track: r.track, artist: r.artist })),
          failed_count: dropped.length,
          total_recs: recs.length,
        });
      }

      // Last-resort fallback: if EVERY track failed validation, don't leave
      // the user with a lead-in and no tracks — emit the dropped ones now as
      // minimal cards (Groove's text + a Spotify search link, which works in
      // any language and can't present fabricated preview/artwork/Apple data
      // as real). Only reached when nothing else survived.
      if (kept.length === 0 && dropped.length > 0) {
        for (const rec of dropped) {
          res.write(JSON.stringify({ type: 'rec_ready', rec }) + '\n');
        }
        enrichedRecs = dropped;
      } else {
        enrichedRecs = kept;
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

    res.write(JSON.stringify({ type: 'done', followUpQuestion }) + '\n');
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