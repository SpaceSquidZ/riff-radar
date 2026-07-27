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
//                                                 metadata; recs ARE coming
//   {"type":"rec_ready","rec":{...}}            — one validated card
//   {"type":"done", ...}                        — stream finished, carries
//                                                 followUpQuestion plus the
//                                                 progress fields the client
//                                                 needs to persist
//   {"type":"error","message":"..."}            — something went wrong mid-stream
//
// ===========================================================================
// v2a CHANGES (July 2026)
//
// TWO METADATA MARKERS instead of one:
//   <!--RIFF_RADAR_RECS:{...}-->  turns that include recommendations
//   <!--RIFF_RADAR_META:{...}-->  conversational turns, no recommendations
//
// Both are stripped before the user sees the reply. Only RECS triggers the
// "Groove is pulling a few records" state.
//
// Why two: askAnswered and arcBeatDelivered have to be reportable on EVERY
// turn, and the old single marker only appeared when recommendations did. A
// conversational turn had no channel to report on.
//
// Gating is now DISTINCT DAYS (daysSeen), not sessionCount. See
// src/sessionCount.js for why.
// ===========================================================================

import {
  GROOVE_BASE_PROMPT,
  getLoreAddendum,
  getActiveStage,
  getPendingArcBeat,
  selectAsk,
} from '../src/groovePrompt.js';
import { logEvent } from '../src/supabaseClient.js';
import { validateOneTrack, lookupTrackFacts } from './lib/validateTracks.js';

export const config = {
  maxDuration: 60,
};

const MARKER_PREFIX = '<!--';
const RECS_MARKER = '<!--RIFF_RADAR_RECS:';
const META_MARKER = '<!--RIFF_RADAR_META:';
const HOLDBACK_CHARS = 24;

function extractStructuredData(replyText) {
  const empty = {
    recs: [],
    followUpQuestion: '',
    arcBeatDelivered: false,
    askOffered: false,
    askAnswered: false,
    cleanedReply: replyText,
  };

  // BUG: the model occasionally self-corrects mid-generation ("wait, let me
  // fix that, I repeated an artist") and emits a SECOND metadata block after
  // the first. A regex without the global flag returns the first match, which
  // is the abandoned draft, and everything after it (including the correction
  // text and the real block) streams through as visible text.
  //
  // Matching greedily to the LAST occurrence picks whichever block he actually
  // meant to stand by. This is a safety net, not a fix for the root cause: the
  // real fix is the instruction below telling him not to self-correct in the
  // open at all.
  const recsMatches = [...replyText.matchAll(/<!--RIFF_RADAR_RECS:(\{.*?\})-->/gs)];
  const metaMatches = [...replyText.matchAll(/<!--RIFF_RADAR_META:(\{.*?\})-->/gs)];
  const match = recsMatches.length
    ? recsMatches[recsMatches.length - 1]
    : metaMatches.length
    ? metaMatches[metaMatches.length - 1]
    : null;

  if (!match) return empty;

  let parsed = {};
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    console.error('Failed to parse metadata block:', err, match[1]);
    return { ...empty, cleanedReply: replyText.replace(match[0], '').trimEnd() };
  }

  // Strip EVERYTHING from the start of the first metadata marker onward, not
  // just the winning block's own text. If he self-corrected, the visible reply
  // otherwise still contains "Wait, let me fix that, I repeated an artist by
  // mistake" followed by a dangling JSON blob, which is exactly what leaked to
  // the user.
  const firstMarkerIdx = replyText.search(/<!--RIFF_RADAR_(RECS|META):/);
  const cleaned =
    firstMarkerIdx === -1
      ? replyText.trimEnd()
      : replyText.slice(0, firstMarkerIdx).trimEnd();

  return {
    recs: Array.isArray(parsed.recs) ? parsed.recs : [],
    followUpQuestion:
      typeof parsed.followUpQuestion === 'string' ? parsed.followUpQuestion : '',
    arcBeatDelivered: parsed.arcBeatDelivered === true,
    askOffered: parsed.askOffered === true,
    askAnswered: parsed.askAnswered === true,
    cleanedReply: cleaned,
  };
}

const STATIC_APP_INSTRUCTIONS = `# App-specific overrides for Riff Radar

# Reasoning effort
Do not overthink these replies. This is a music companion, not a math problem. You are
recalling music you already know well and writing a couple of warm, specific sentences
about it. Extended reasoning adds latency the user feels directly as a slow reply, and it
rarely improves a recommendation. Reason briefly, then answer.

This app renders recommendations as visual cards (art, preview player, real Apple
Music and Spotify links) and does not display raw links or per-song paragraphs in
the chat text. Overrides to your normal behavior, for this app only:

1. Do NOT include a Spotify or Apple Music search link anywhere in your visible reply.

2. Whenever you would give the 3-recommendation block: your VISIBLE reply text must
contain ONLY your opening reflection on what the user shared. HARD LIMIT: a MAXIMUM of
3 sentences, normal conversational ones, not long winding ones. Two is often better.
Cover what made the moment hit, plus one short beat of your own reaction. Then STOP.

This limit is absolute. Going long costs the user real waiting time before they see any
tracks. If you find yourself writing a fourth sentence, cut it.

Do NOT include song titles, artist names, per-song explanations, or your closing beat in
the visible text. All of that goes in the hidden metadata block, because the app renders
it separately.

2a. CRITICAL — your closing beat (the warm line plus the two directions) goes ONLY in the
followUpQuestion field of the hidden metadata, NEVER in your visible reply text. The app
renders it beneath the cards; if you also write it in your prose it appears TWICE.

2b. NEVER state or imply a specific NUMBER of recommendations in your visible reply.
The app may show fewer than three cards, so any number you name can be contradicted on
screen. Use count-free phrasing or no lead-in at all.

3. The 3 recommended artists in a single response must all be DIFFERENT from each other,
not just different from the source track's artist.

4. When you have asked an either/or refinement question and they reply, interpret their
answer GENEROUSLY. Treat replies like "other english is fine", "the second one", "yeah
the weirder beat", "let's go broader", "the first", "more of that" as clear, valid
selections. Do NOT tell the user they didn't pick an option, do NOT re-ask, and do NOT
stall for precision. Only ask for clarification if a reply is genuinely ambiguous between
your two options, not merely informal.

If your reply is pure conversation with no recommendations, ignore the length restriction
in #2 and respond normally.

# Hidden metadata (internal, NEVER shown to the user)
EVERY response ends with exactly ONE metadata comment on its own line, after everything
else. Which one depends on whether you gave recommendations.

## A. Turns WITH recommendations
<!--RIFF_RADAR_RECS:{"recs":[{"track":"Song Title","artist":"Artist Name","matchAxis":"Structural twin","genre":"Genre tag","region":"Country of origin","explanation":"One sentence, 20 words or fewer, on the musical link."},{"track":"...","artist":"...","matchAxis":"Adjacent genre","genre":"...","region":"...","explanation":"..."},{"track":"...","artist":"...","matchAxis":"Surprise pick","genre":"...","region":"...","explanation":"..."}],"followUpQuestion":"Your closing beat.","arcBeatDelivered":false,"askOffered":false,"askAnswered":false}-->

## B. Turns WITHOUT recommendations (pure conversation)
<!--RIFF_RADAR_META:{"arcBeatDelivered":false,"askOffered":false,"askAnswered":false}-->

Field rules:

"matchAxis" must be exactly one of: "Structural twin", "Adjacent genre", "Surprise pick".

"region" is the artist's country of origin as a plain English name ("Brazil", "Nigeria",
"Japan", "France", "USA", "UK"). This routes validation to the right regional catalog, so
be accurate. Use "USA" if unsure or the artist is American.

"explanation" MUST be exactly one sentence, 20 words or fewer, plain text, no markdown.

"followUpQuestion" is your CLOSING BEAT, not a menu. Two things in order:
  1. ONE warm or curious sentence about THE USER or THE MOMENT THEY SHARED, not about a
     specific recommended track.
  2. THEN two concrete directions, described by quality or feel.
Do NOT name any recommended track or artist here. Validation drops unverifiable tracks
AFTER you write this, so a named track may not be on screen. Refer to directions, not
titles: "the one with the groove still under it" rather than "the Kiefer track."

"arcBeatDelivered" — set true if and only if you actually worked in the personal beat
described under "Tonight, something of your own" in your context. If you decided the
conversation had no room for it, set false. Do not set true unless the beat is genuinely
present in your visible reply. A false positive means that beat is never shown again.

"askOffered" — set true if and only if you actually asked the question under "Something
you want from them" in your visible reply. Set false if there was no such question in your
context, or if you decided the conversation had no room for it.

Do NOT confuse this with your closing refinement question. A refinement question steers
the recommendations ("want it looser, or more percussive?") and is not an ask. An ask is a
question about the person's own life and circumstances, and it comes from your context
verbatim in spirit. Only that counts.

A false positive here permanently burns a question you never got to ask.

"askAnswered" — set true if and only if the user's most recent message actually answered
the question logged under "You asked something and have not been answered." Answering
partially, briefly, or sideways still counts. Changing the subject does not. If no such
question is in your context, always set false.

Both metadata blocks are stripped before the user sees your reply, so neither needs to
fit your voice or formatting rules.`;

function buildSourceTrackBlock(sourceFacts, sourceTrack) {
  if (!sourceTrack?.track || !sourceTrack?.artist) return '';

  if (sourceFacts?.confidence === 'artist_only') {
    return (
      `\n\n# The user's source track (PARTIALLY verified)\n` +
      `They said they are listening to "${sourceTrack.track}" by ${sourceTrack.artist}.\n` +
      `The ARTIST is real and was found in the catalog. The TRACK TITLE could not be ` +
      `confirmed as one of their songs, which usually means it is misspelled, a very ` +
      `deep cut, or not on streaming.\n\n` +
      `So: you can rely on knowing the artist. Do NOT assume you know which specific ` +
      `song this is, and do NOT substitute a different, better-known song by them. If ` +
      `you genuinely know this track, use it. If you don't, lean primarily on what the ` +
      `user actually described about the moment. If the title looks like a misspelling ` +
      `of one of their real songs, you may gently check with them.`
    );
  }

  if (!sourceFacts || sourceFacts.found === false) {
    return (
      `\n\n# The user's source track\n` +
      `They are listening to "${sourceTrack.track}" by ${sourceTrack.artist}. This could ` +
      `NOT be found in the music catalog, which means it may be very obscure, very new, ` +
      `or spelled unusually. Do NOT assume it is a different, better-known song that ` +
      `happens to share the same title. If you are not confident you know THIS specific ` +
      `track by THIS specific artist, lean on what the user told you about the moment.`
    );
  }

  const lines = [
    `Track: "${sourceFacts.trackName}"`,
    `Artist (as listed in the catalog): ${sourceFacts.artistName}`,
  ];
  if (sourceFacts.genre) lines.push(`Genre: ${sourceFacts.genre}`);
  if (sourceFacts.releaseYear) lines.push(`Released: ${sourceFacts.releaseYear}`);
  if (sourceFacts.albumName) lines.push(`Album: ${sourceFacts.albumName}`);
  if (sourceFacts.storefront) lines.push(`Found in the ${sourceFacts.storefront} catalog`);

  return (
    `\n\n# The user's source track (VERIFIED against the music catalog)\n` +
    lines.join('\n') +
    `\n\nThese are hard facts, not guesses. Trust them over your own instincts about the ` +
    `title. Song titles collide constantly: a modern track can share its name with a ` +
    `famous standard, and anchoring your recommendations to the wrong song ruins the ` +
    `entire response. If the genre, year, or artist above conflicts with the song you ` +
    `assumed this was, the facts above are correct and your assumption is wrong.`
  );
}

function buildDynamicBlock(loreAddendum, sourceFacts, sourceTrack, previousRecommendations) {
  const loreText = loreAddendum || '(No addendum active yet.)';

  let doNotRepeatText = '';
  if (Array.isArray(previousRecommendations) && previousRecommendations.length > 0) {
    const list = previousRecommendations
      .map((r) => `"${r.track}" by ${r.artist}`)
      .join(', ');
    doNotRepeatText =
      `\n\n# Tracks already recommended this session\n` +
      `Do NOT recommend any of these again, even if they'd otherwise fit: ${list}.`;
  }

  return loreText + buildSourceTrackBlock(sourceFacts, sourceTrack) + doNotRepeatText;
}

const CACHE_CONTROL_1H = { type: 'ephemeral', ttl: '1h' };

function buildSystemBlocks(loreAddendum, sourceFacts, sourceTrack, previousRecommendations) {
  return [
    { type: 'text', text: GROOVE_BASE_PROMPT, cache_control: CACHE_CONTROL_1H },
    { type: 'text', text: STATIC_APP_INSTRUCTIONS, cache_control: CACHE_CONTROL_1H },
    {
      type: 'text',
      text: buildDynamicBlock(loreAddendum, sourceFacts, sourceTrack, previousRecommendations),
      // Deliberately uncached. This is the block that changes per request.
    },
  ];
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

function detectLanguageHint(messages) {
  const userText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' ');

  if (/[\uac00-\ud7af]/.test(userText)) return 'ko';
  if (/[\u3040-\u30ff]/.test(userText)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(userText)) return 'zh';
  if (/[\u0e00-\u0e7f]/.test(userText)) return 'th';

  return null;
}

async function callAnthropicStream({ messages, systemBlocks }) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      output_config: { effort: 'low' },
      stream: true,
      system: systemBlocks,
      messages,
    }),
  });
}

async function streamClaudeReply({ messages, systemBlocks, res }) {
  let anthropicRes = await callAnthropicStream({ messages, systemBlocks });

  if (!anthropicRes.ok && RETRYABLE_STATUSES.has(anthropicRes.status)) {
    console.warn(`Anthropic API returned ${anthropicRes.status}, retrying once.`);
    anthropicRes = await callAnthropicStream({ messages, systemBlocks });
  }

  if (!anthropicRes.ok || !anthropicRes.body) {
    const errorBody = await anthropicRes.text().catch(() => '');
    console.error('Anthropic API error after retry:', anthropicRes.status, errorBody);
    throw new Error(`Claude API request failed (${anthropicRes.status})`);
  }

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();

  let sseBuffer = '';
  let fullText = '';
  let emittedLength = 0;
  let markerStart = -1;
  let markerEnd = -1;
  let markerResolved = false;
  let stopReason = null;
  const usage = { input: null, output: null, cacheRead: null, cacheWrite: null };
  const blockTypesSeen = new Set();

  function flushRange(from, to) {
    if (to <= from) return;
    const safe = fullText.slice(from, to);
    if (safe) res.write(JSON.stringify({ type: 'delta', text: safe }) + '\n');
  }

  // BUG THIS FIXES: the previous version assumed the metadata comment was the
  // LAST thing in the reply. It found '<!--', flushed everything before it, and
  // treated the entire remainder as metadata. When the model put the block
  // first or mid-reply, every visible character after it was silently dropped,
  // producing an assistant turn with no text at all.
  //
  // v2a made this much more likely, because a metadata block is now required on
  // EVERY turn including pure conversation, so there is no longer a strong
  // positional convention holding it at the end.
  //
  // This version tracks the marker's start AND its '-->' close, and emits text
  // on both sides of it.
  function processDeltaText(deltaText) {
    fullText += deltaText;

    if (markerStart === -1) {
      markerStart = fullText.indexOf(MARKER_PREFIX);
    }

    // No marker seen yet. Emit with a holdback so a partial '<!-' never ships.
    if (markerStart === -1) {
      const safeEnd = Math.max(0, fullText.length - HOLDBACK_CHARS);
      if (safeEnd > emittedLength) {
        flushRange(emittedLength, safeEnd);
        emittedLength = safeEnd;
      }
      return;
    }

    // Everything before the marker is real text. Flush it once.
    if (emittedLength < markerStart) {
      flushRange(emittedLength, markerStart);
      emittedLength = markerStart;
    }

    // Only the RECS marker means cards are coming. META is a quiet
    // conversational turn and must not trigger the loading state.
    if (!markerResolved && fullText.length >= markerStart + RECS_MARKER.length) {
      markerResolved = true;
      const candidate = fullText.slice(markerStart, markerStart + RECS_MARKER.length);
      if (candidate === RECS_MARKER) {
        res.write(JSON.stringify({ type: 'recs_starting' }) + '\n');
      }
    }

    if (markerEnd === -1) {
      const closeIdx = fullText.indexOf('-->', markerStart);
      if (closeIdx !== -1) markerEnd = closeIdx + 3;
    }

    // Marker has closed. Skip past it and resume emitting anything after.
    if (markerEnd !== -1) {
      if (emittedLength < markerEnd) emittedLength = markerEnd;
      const safeEnd = Math.max(markerEnd, fullText.length - HOLDBACK_CHARS);
      if (safeEnd > emittedLength) {
        flushRange(emittedLength, safeEnd);
        emittedLength = safeEnd;
      }
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

      if (payload.type === 'content_block_start') {
        blockTypesSeen.add(payload.content_block?.type || 'unknown');
      } else if (
        payload.type === 'content_block_delta' &&
        payload.delta?.type === 'text_delta'
      ) {
        processDeltaText(payload.delta.text);
      } else if (payload.type === 'message_start' && payload.message?.usage) {
        usage.input = payload.message.usage.input_tokens ?? null;
        usage.cacheRead = payload.message.usage.cache_read_input_tokens ?? null;
        usage.cacheWrite = payload.message.usage.cache_creation_input_tokens ?? null;
      } else if (payload.type === 'message_delta') {
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
        if (payload.usage?.output_tokens != null) usage.output = payload.usage.output_tokens;
      } else if (payload.type === 'error') {
        console.error('Anthropic in-stream error event:', payload.error);
      }
    }
  }

  // Final flush. Emit whatever is left that is not inside the marker.
  if (emittedLength < fullText.length) {
    const noMarker = markerStart === -1;
    const pastMarker = markerEnd !== -1 && emittedLength >= markerEnd;
    if (noMarker || pastMarker) {
      flushRange(emittedLength, fullText.length);
    }
    emittedLength = fullText.length;
  }

  console.log(
    `[usage] output_tokens=${usage.output} input_tokens=${usage.input} ` +
      `cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite} ` +
      `stop_reason=${stopReason} reply_chars=${fullText.length} ` +
      `block_types=[${[...blockTypesSeen].join(',')}]`
  );

  if (stopReason === 'max_tokens') {
    console.warn(
      `Groove reply TRUNCATED by max_tokens. The metadata block was likely cut off, ` +
        `so no cards rendered and no progress was reported.`
    );
  }

  return fullText;
}

function logEventSafe(sessionId, eventType, payload, isTester = false) {
  if (!sessionId) return;
  const withFlag = isTester ? { ...payload, is_tester: true } : payload;
  try {
    Promise.resolve(logEvent(sessionId, eventType, withFlag, true)).catch((err) => {
      console.error(`Non-fatal: failed to log ${eventType}:`, err?.message || err);
    });
  } catch (err) {
    console.error(`Non-fatal: failed to log ${eventType}:`, err?.message || err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    messages: rawMessages,
    sessionId,
    isTester = false,
    sourceTrack,
    previousRecommendations = [],
    languageHint: clientLanguageHint,

    // v2a progress fields
    daysSeen = 0,
    daysSinceLast = null,
    deliveredArcBeats = [],
    deliveredLoreLines = [],
    offeredAsks = [],
    answeredAsks = [],
    pendingQuestion = null,
    pendingAskId = null,
    recLanguage = null,
    // Arc beats and pool asks are suppressed until the user has spoken twice.
    // Turn one already carries the opener plus a first real exchange.
    userTurnCount = 99,
    // The two records Groove had on when the user arrived. Session context, not
    // conversation: their titles render as cards and so never appear in any
    // message's text.
    openerPair = null,
  } = req.body;

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
      logEventSafe(
        sessionId,
        'message_sent',
        { role: 'user', content_length: lastUserMessage.content.length },
        isTester
      );
    }

    const artistsThisConvo = previousRecommendations.map((r) => r.artist).filter(Boolean);

    const loreAddendum = getLoreAddendum(daysSeen, {
      deliveredArcBeats,
      deliveredLoreLines,
      offeredAsks,
      answeredAsks,
      daysSinceLast,
      pendingQuestion,
      artistsThisConvo,
      recLanguage,
      userTurnCount,
      openerPair,
    });

    // Recompute what the addendum offered, so we can tell the client what to
    // persist and log what was made available. selectAsk must be called with
    // the SAME arguments the addendum used, or the server will report an ask
    // that Groove was never given.
    const stage = getActiveStage(daysSeen);
    const offeredArcBeat = getPendingArcBeat(daysSeen, deliveredArcBeats, userTurnCount);
    const offeredAsk = selectAsk({
      offeredAsks,
      pendingQuestion,
      hasArcBeat: !!offeredArcBeat,
      userTurnCount,
    });

    if (sessionId && stage) {
      logEventSafe(
        sessionId,
        'lore_stage_available',
        { stage: stage.stage, days_seen: daysSeen },
        isTester
      );
    }

    const languageHintForSource = clientLanguageHint || detectLanguageHint(messages);
    let sourceFacts = null;
    if (sourceTrack?.track && sourceTrack?.artist) {
      try {
        sourceFacts = await lookupTrackFacts(
          sourceTrack.track,
          sourceTrack.artist,
          languageHintForSource
        );
        console.log(
          `[source] "${sourceTrack.track}" by ${sourceTrack.artist} -> ` +
            `${sourceFacts?.confidence || 'none'}`
        );
      } catch (err) {
        console.error('Source track lookup failed (non-fatal):', err?.message || err);
      }
    }

    const systemBlocks = buildSystemBlocks(
      loreAddendum,
      sourceFacts,
      sourceTrack,
      previousRecommendations
    );

    const rawReplyText = await streamClaudeReply({ messages, systemBlocks, res });

    const {
      recs,
      followUpQuestion,
      arcBeatDelivered,
      askOffered,
      askAnswered,
      cleanedReply,
    } = extractStructuredData(rawReplyText);

    let enrichedRecs = [];

    if (recs.length > 0) {
      const languageHint = clientLanguageHint || detectLanguageHint(messages);
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
            kept.push(enrichedRec);
            res.write(JSON.stringify({ type: 'rec_ready', rec: enrichedRec }) + '\n');
          } else {
            dropped.push(enrichedRec);
          }
        })
      );

      if (sessionId && dropped.length > 0) {
        logEventSafe(
          sessionId,
          'itunes_validation_failed',
          {
            failed_tracks: dropped.map((r) => ({ track: r.track, artist: r.artist })),
            failed_count: dropped.length,
            total_recs: recs.length,
          },
          isTester
        );
      }

      if (kept.length === 0 && dropped.length > 0) {
        for (const rec of dropped) {
          res.write(JSON.stringify({ type: 'rec_ready', rec }) + '\n');
        }
        enrichedRecs = dropped;
      } else {
        enrichedRecs = kept;
      }
    }

    // --- progress logging -------------------------------------------------

    if (sessionId) {
      logEventSafe(
        sessionId,
        'message_sent',
        { role: 'assistant', content_length: cleanedReply.length },
        isTester
      );

      if (enrichedRecs.length > 0) {
        logEventSafe(
          sessionId,
          'rec_generated',
          {
            recommendation_count: enrichedRecs.length,
            tracks: enrichedRecs.map((r) => `${r.track} - ${r.artist}`),
          },
          isTester
        );
      }

      if (arcBeatDelivered && offeredArcBeat) {
        logEventSafe(
          sessionId,
          'arc_beat_delivered',
          { beat_id: offeredArcBeat.id, days_seen: daysSeen },
          isTester
        );
      }

      if (askOffered && offeredAsk) {
        logEventSafe(
          sessionId,
          'daily_ask_offered',
          { ask_id: offeredAsk.id, days_seen: daysSeen },
          isTester
        );
      }

      if (askAnswered && pendingAskId) {
        logEventSafe(
          sessionId,
          'daily_ask_answered',
          { ask_id: pendingAskId, days_seen: daysSeen },
          isTester
        );
      }
    }

    // The client persists progress from these fields. An ask id is only sent
    // when Groove CONFIRMS he asked it, not merely because the server put it in
    // his context. Reporting it on offer alone burned six asks across two test
    // conversations in which none were actually asked.
    res.write(
      JSON.stringify({
        type: 'done',
        followUpQuestion,
        arcBeatId: arcBeatDelivered && offeredArcBeat ? offeredArcBeat.id : null,
        askOfferedId: askOffered && offeredAsk ? offeredAsk.id : null,
        askOfferedText: askOffered && offeredAsk ? offeredAsk.text : null,
        askAnsweredId: askAnswered && pendingAskId ? pendingAskId : null,
      }) + '\n'
    );
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
      /* response may already be closed */
    }
    res.end();
  }
}