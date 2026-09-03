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
import { validateOneTrack, lookupTrackFacts, titlesMatch } from './lib/validateTracks.js';
import { flushCacheWrites } from './lib/itunesCache.js';
import { getCandidatePool, resolveSeedArtist } from './lib/lastfm.js';

export const config = {
  maxDuration: 60,
};

const MARKER_PREFIX = '<!--';
const RECS_MARKER = '<!--RIFF_RADAR_RECS:';
const META_MARKER = '<!--RIFF_RADAR_META:';
const HOLDBACK_CHARS = 24;

// Change 1 (Brief A, D-026: locked slots read as reception failure, never
// permission denial — static, not padlocks). A blank turn is the same
// failure mode as a mid-sentence dropout, so it gets the same voice: the
// SIGNAL went missing, not Groove. Never an apology, never anything
// technical. Several options so a user who hits this twice in one session
// does not see the same line twice.
//
// This is the ONLY place that picks this line. salvage() below deliberately
// does NOT pick one itself — it returns a true empty string when there is
// nothing salvageable, so the blank-reply guard in the handler (which
// already picks, logs, counts, AND STREAMS the fallback) is the single path
// a user's screen can ever show one through. salvage() picking its own text
// here used to be exactly the bug: it filled cleanedReply with a placeholder
// string ("Sorry, I got tangled up putting that together...", apologetic
// and explanatory — precisely what this rule forbids), which made
// cleanedReply non-empty and silently defeated the handler's blank check
// below, so NEITHER that apology NOR this fallback ever actually reached the
// client as a delta — the user saw nothing at all, same as before Change 1
// existed. Confirmed live on 2026-08-29 19:49:24, a JSON parse failure with
// nothing before the marker: the log shows the parse error, but nothing was
// ever written to the response.
const EMPTY_REPLY_FALLBACKS = [
  'Lost you for a second there — the line went quiet. Say that again?',
  "Static on my end just then. What was that?",
  "That one got away from me mid-thought. One more time?",
  "Something cut out before I could get it to you. Try me again?",
];

function pickEmptyReplyFallback() {
  return EMPTY_REPLY_FALLBACKS[Math.floor(Math.random() * EMPTY_REPLY_FALLBACKS.length)];
}

// Change 1, follow-up (Brief A, D-033: a shortfall is never unexplained).
// DIFFERENT failure from a blank turn: real text already streamed — Groove's
// opening reflection went through fine — and only THEN did the recs
// metadata break (a parse failure, or a self-correction that never closed
// its replacement block; see recsFailureReason in salvage() below). The user
// already has a real, coherent reply. What is missing is just the picks that
// should have followed it, so EMPTY_REPLY_FALLBACKS' "say that again" framing
// is the wrong content here even though the register is right: the user does
// not need to repeat themselves, and asking them to reads as Groove not
// having heard something he plainly did (confirmed live: a tester repeated
// the same question four times in a row against this exact gap). This pool
// acknowledges the PICKS going missing specifically — same rules as Change 4
// (D-026: reception failure, not permission denial) — still no apology, no
// explanation, nothing technical.
const RECS_DROPPED_FALLBACKS = [
  'Reception dropped right as I was reaching for the picks. Try me again in a second.',
  'Lost the feed right at the good part. One more go?',
  'Static ate the rest of that. Give it another shot?',
  'The signal cut out right as those were coming through. Try again in a moment?',
];

function pickRecsDroppedFallback() {
  return RECS_DROPPED_FALLBACKS[Math.floor(Math.random() * RECS_DROPPED_FALLBACKS.length)];
}

function salvage(replyText, empty, matchText, recsFailureReason) {
  const markerStart = replyText.indexOf(matchText);
  const salvageableText = markerStart > 0 ? replyText.slice(0, markerStart).trim() : '';
  return {
    ...empty,
    cleanedReply: salvageableText,
    // null unless the block that broke was specifically a RECS attempt (not
    // a META one — a pure-conversation turn breaking has no picks to miss,
    // so it must not trigger the handler's recs-dropped recovery below).
    // 'parse_error' or 'superseded_block' identifies WHICH of the two
    // salvage() call sites this came from, for the distinct event/log.
    recsFailureReason: recsFailureReason || null,
  };
}

function extractStructuredData(replyText) {
  const empty = {
    candidates: [],
    followUpQuestion: '',
    arcBeatDelivered: false,
    askOffered: false,
    askAnswered: false,
    inputTrack: null,
    requestedArtists: [],
    recsFailureReason: null,
    cleanedReply: replyText,
  };

  // The model occasionally self-corrects mid-generation ("wait, let me fix
  // that, I repeated an artist") and emits a SECOND metadata block after the
  // first. STATIC_APP_INSTRUCTIONS now explicitly forbids this (see "EXACTLY
  // ONE, no exceptions"), and the streaming layer in streamClaudeReply never
  // shows the user anything from the first marker onward regardless of what
  // follows it. This matching is the last line of defense for CARD DATA if
  // that prompt rule is ever violated anyway: matching greedily to the LAST
  // *closed* occurrence picks whichever block he actually meant to stand by,
  // rather than the abandoned draft a non-global regex would return.
  const recsMatches = [...replyText.matchAll(/<!--RIFF_RADAR_RECS:(\{.*?\})-->/gs)];
  const metaMatches = [...replyText.matchAll(/<!--RIFF_RADAR_META:(\{.*?\})-->/gs)];
  // Whether the block on the table is a RECS attempt at all. A META turn
  // breaking has no picks to miss, so its salvage() calls below must pass no
  // recsFailureReason — only a broken RECS block should ever tell the
  // handler to append a recs-dropped recovery line.
  const isRecsAttempt = recsMatches.length > 0;
  const match = isRecsAttempt
    ? recsMatches[recsMatches.length - 1]
    : metaMatches.length
    ? metaMatches[metaMatches.length - 1]
    : null;

  if (!match) return empty;

  // BUG THIS GUARDS AGAINST: self-correcting means writing the metadata block
  // TWICE inside the same fixed max_tokens budget. If the corrected block gets
  // cut off before its own closing "-->", it never appears in recsMatches at
  // all, and `match` above silently falls back to the ABANDONED draft — the
  // one carrying whatever mistake (e.g. a repeated artist) triggered the
  // correction in the first place. Its candidates then survive validation
  // fine (they're real, just poorly chosen) and dedup logic collapses them
  // down to a lone card, which reads as "5 of 6 valid recommendations vanished"
  // even though nothing downstream actually did anything wrong.
  //
  // A marker START appearing anywhere after the block we are about to use
  // means the model was still mid-correction when the reply ended and never
  // got to stand behind THIS block either. Treat that as an unrecoverable
  // turn rather than silently shipping the discarded draft.
  const tailAfterMatch = replyText.slice(match.index + match[0].length);
  if (/<!--RIFF_RADAR_(RECS|META):/.test(tailAfterMatch)) {
    console.error('Metadata block was superseded by a later, unclosed block:', match[0]);
    return salvage(replyText, empty, match[0], isRecsAttempt ? 'superseded_block' : null);
  }

  let parsed = {};
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    // BUG THIS GUARDS AGAINST: Groove occasionally narrates a self-correction
    // INSIDE a JSON string value, e.g. "explanation":"Not allowed, replacing."
    // That breaks the JSON structure. Previously a parse failure here meant the
    // ENTIRE reply broke — no cards, no follow-up, nothing rendered — on top
    // of an uncaught-looking error in the Vercel logs during a live session.
    //
    // The prompt has an explicit rule against this (see groovePrompt.js,
    // "Decide before you write JSON, never while writing it"), but a prompt
    // rule is guidance, not a guarantee. This is the code-level backstop:
    // salvage whatever plain conversational text existed before the broken
    // block, so the user gets SOMETHING instead of a dead turn.
    console.error('Failed to parse metadata block:', err, match[1]);
    return salvage(replyText, empty, match[0], isRecsAttempt ? 'parse_error' : null);
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
    // v2b: six ranked candidates. Array order is Groove's own ranking.
    candidates: Array.isArray(parsed.candidates)
      ? parsed.candidates
      : Array.isArray(parsed.recs)
      ? parsed.recs // tolerate the v2a shape during rollout
      : [],
    followUpQuestion:
      typeof parsed.followUpQuestion === 'string' ? parsed.followUpQuestion : '',
    arcBeatDelivered: parsed.arcBeatDelivered === true,
    askOffered: parsed.askOffered === true,
    askAnswered: parsed.askAnswered === true,
    inputTrack:
      parsed.inputTrack?.track && parsed.inputTrack?.artist
        ? { track: parsed.inputTrack.track, artist: parsed.inputTrack.artist }
        : null,
    // Change 2 (Brief A, rule 5): artists the user named by name this turn,
    // exempting them from the no-repeat check in selectSurfaced. Filtered to
    // strings so a malformed value never reaches normalizeArtistKey downstream.
    requestedArtists: Array.isArray(parsed.requestedArtists)
      ? parsed.requestedArtists.filter((a) => typeof a === 'string' && a.trim())
      : [],
    // Extraction succeeded (whether or not candidates ended up empty — a
    // legitimate META turn has no picks to miss either), so there is no
    // recs failure to report here. Only salvage() ever sets this non-null.
    recsFailureReason: null,
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

2c. Every turn opens with at least one sentence of your own before any recommendations.
No exceptions. This holds when the listener's message is short — "more", "anything else",
"keep going" — and it holds when you have already said something similar earlier in the
conversation. A short request is still a request, and answering it with records alone is
not answering it. Never return recommendations with no words in front of them.

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

EXACTLY ONE, no exceptions, even if you spot a mistake after finishing it — a repeated
artist, a wrong connection type, anything. Do NOT write a second metadata comment to
replace the first, and do NOT narrate the mistake in your visible reply ("wait, let me
give you real picks instead", "actually, let me fix that"). Both failures leak straight
into the chat window verbatim; the user has seen raw JSON and mid-sentence corrections
because of this before. If you notice a problem after the block is closed, it is too
late to fix in this turn. Leave the block as written and let validation silently drop
whatever does not hold up. A single flawed block is invisible to the user. A visible
correction is not.

## A. Turns WITH recommendations
Exactly SIX candidates, ranked best first. Array order IS the ranking.
<!--RIFF_RADAR_RECS:{"candidates":[{"track":"Song Title","artist":"Artist Name","connectionType":"same_hand","distant":false,"tier":"scene","genre":"Genre tag","region":"Country of origin","explanation":"One sentence, 20 words or fewer, naming the connection concretely."}],"inputTrack":{"track":"What they named","artist":"Artist"},"requestedArtists":[],"followUpQuestion":"Your closing beat.","arcBeatDelivered":false,"askOffered":false,"askAnswered":false}-->

## B. Turns WITHOUT recommendations (pure conversation)
<!--RIFF_RADAR_META:{"inputTrack":{"track":"What they named","artist":"Artist"},"requestedArtists":[],"arcBeatDelivered":false,"askOffered":false,"askAnswered":false}-->

Field rules:

"candidates" MUST contain exactly six objects, in your own order of preference, best first. The app validates all six and surfaces the best three that survive. Rank honestly: ordering is logged and tested against engagement.

"connectionType" must be exactly one of: "same_hand", "lineage", "same_move", "same_scene", "same_mechanism". Spread the six across at least FOUR different types so the app can pick three distinct ones after validation drops some.

"distant" is a boolean tag, not a type. True when the track is far in language, geography, or era. It must still carry a real connection type underneath.

"tier" is "scene" or "wide". At least four of six must be "scene". No more than two "wide". Judge the TRACK, not the artist: a famous artist's overlooked record is "scene", a standard covered by everyone is "wide" regardless of who performed it.

"region" is the artist's country of origin as a plain English name ("Brazil", "Nigeria", "Japan", "France", "USA", "UK"). This routes validation to the right regional catalog, so be accurate. Use "USA" if unsure.

"explanation" MUST be exactly one sentence, 20 words or fewer, plain text, no markdown. Name the connection concretely: who the shared producer is, which move recurs, what the mechanism does. Never name a technique without saying what it does to the sound. "Collage approach" is not acceptable; "buries the vocal under the loop instead of on top of it" is.

"inputTrack" — include this on ANY turn where the user names or clearly refers to a specific song of their own, whether or not you are giving recommendations. Format: {"track":"Song Title","artist":"Artist Name"}. Omit the field entirely if they have not named one.

Give your best reading of what they meant, in the catalog's likely spelling. "that bolden track" becomes {"track":"Talk to me.","artist":"Bolden."} if that is what you believe they mean. The app verifies it against a real catalog and shows the user a small card so they can correct you, so a confident guess is more useful than omitting the field. Do NOT include a track they are only discussing in the abstract, and do NOT include one of your own recommendations.

"requestedArtists" — array of artist names, e.g. ["Slauson Malone"]. Include an artist here whenever the user's current message names them specifically — asking to hear them again, asking what you think of them, or simply steering the conversation toward them ("what about Grouper?", "I've been on a Grouper kick"). This is NOT limited to turns where you are giving recommendations: include it on a pure-conversation turn too, the moment they name someone specific. Two things depend on it: it is what lets you repeat an artist already recommended this session (see "Set rules for the six" and "Tracks already recommended this session" above) — without it, the app has no way to distinguish a deliberate repeat from a mistake — and it is also how the app knows who the conversation is currently about, which shapes what it looks up for you next turn. Do NOT list an artist here just because you are recommending them yourself, and do NOT list someone mentioned only in passing about a THIRD party ("my roommate loves Grouper" names no orbit shift). Omit or leave empty otherwise — most turns will.

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
      `Do NOT recommend any of these again, even if they'd otherwise fit: ${list}. ` +
      `EXCEPTION: if the user's current message names one of these artists again by ` +
      `name, asking for them specifically, the repeat is allowed — list that artist in ` +
      `"requestedArtists" in your metadata so the app knows it is intentional.`;
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

// Brief D, Part 2. Extended thinking was running on every turn with nobody
// having chosen it: the request never set `thinking` at all, and on
// claude-sonnet-5 specifically, omitting it does NOT mean "off" (that was
// true on Opus 4.7/4.8) — it silently runs adaptive thinking, the same as
// explicitly sending {type: "adaptive"}. That is not a deliberate choice
// recorded anywhere; it is inheriting whatever the model's default happens to
// be on this one model. The fix is to say what we mean.
//
// Checked against the current SDK/API surface before writing these: on
// claude-sonnet-5, {type: "adaptive"} is the only "on" mode (there is no
// numeric thinking-budget dial — `budget_tokens` is REMOVED and returns a
// 400), and {type: "disabled"} is accepted. So only two genuinely distinct
// arms exist for the A/B: Arm A (adaptive) and Arm B (off). A third
// "bounded, smallest budget" arm was requested but is not expressible on
// this model: there is no token-budget parameter to shrink, and the only
// other lever (`effort`) is already at its floor ("low") in Arm A.
// Explicitly enabling adaptive thinking at effort "low" IS Arm A — it is not
// a distinct third point. Ran two arms per the brief's own contingency for
// exactly this case.
//
// RESULT (Decision Log entry pending ID confirmation): arm B blind-rated
// 2.20 vs. arm A's 2.17-2.18 across two independent samples, plus a 34%
// output-token reduction in production (1112 -> 729 mean). Arm B ships as
// the default. The env var stays for future experiments, but its
// unrecognized-value fallback now lands on the SHIPPED arm rather than the
// experimental one — an env var that silently falls back to whichever arm
// happens to be the default is only a trap when the default is the risky
// choice. Opt into the adaptive-thinking arm explicitly with
// GROOVE_THINKING_ARM=A; anything else (unset, a typo, 'off') now safely
// gets B.
const THINKING_ARM = process.env.GROOVE_THINKING_ARM === 'A' ? 'A' : 'B';

function thinkingConfigForArm(arm) {
  if (arm === 'A') return { type: 'adaptive' };
  return { type: 'disabled' };
}

// Brief D, Part 2. Raised from 4096 regardless of the A/B outcome — this
// ceiling is the direct, confirmed cause of the blank turns Brief A had to
// patch around defensively (Change 1): adaptive thinking has no fixed budget
// of its own, so on an unlucky turn it can consume the entire max_tokens
// ceiling before emitting a single visible character, leaving nothing for
// prose or the candidate JSON. Observed max across the Part 2 A/B run
// (18 sessions, both thinking arms): 2284 output_tokens on one turn. 8000
// leaves that turn ~3.5x headroom while still capping a runaway turn at
// something a person would actually wait through, rather than sizing for
// Part 3's not-yet-built 12-candidate case pre-emptively. Already streaming
// (stream: true), so there is no SDK-timeout concern at this size.
const MAX_TOKENS = 8000;

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
      max_tokens: MAX_TOKENS,
      thinking: thinkingConfigForArm(THINKING_ARM),
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
  let markerResolved = false;
  let stopReason = null;
  const usage = { input: null, output: null, cacheRead: null, cacheWrite: null };
  const blockTypesSeen = new Set();

  function flushRange(from, to) {
    if (to <= from) return;
    const safe = fullText.slice(from, to);
    if (safe) res.write(JSON.stringify({ type: 'delta', text: safe }) + '\n');
  }

  // The v2a protocol guarantees the metadata comment is the LAST thing in the
  // reply, on every turn (see the header comment above). So once the first
  // '<!--' is seen, nothing legitimate follows it — everything before the
  // marker is real visible text, and everything from the marker onward is
  // metadata and must never be streamed to the client.
  //
  // BUG THIS FIXES: an earlier version of this function tracked the marker's
  // '-->' close and RESUMED streaming anything after it, on the theory that
  // Groove might still have visible text trailing the block. He should not,
  // under the current protocol — but when he malformed a reply by
  // self-correcting mid-generation (narrating "wait, let me fix that" and
  // emitting a SECOND metadata block), that resume logic streamed the
  // narration and the raw second block straight to the user as if it were
  // normal prose. This version never resumes: once markerStart is found, the
  // only thing further processing does is detect RECS vs META (for the
  // recs_starting event) and keep buffering fullText for the final extraction
  // extractStructuredData runs on the complete text.
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

    // Everything before the marker is real text. Flush it once, and never
    // flush anything from the marker onward.
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

  // Final flush. Only when no marker ever appeared — anything from the
  // marker onward is metadata (or a malformed self-correction) and must
  // never reach the client, no matter how the stream ended.
  if (emittedLength < fullText.length && markerStart === -1) {
    flushRange(emittedLength, fullText.length);
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

  // usage/blockTypesSeen/stopReason ride along so the handler can log them if
  // the turn ends up rendering blank (see the empty-reply guard below) — the
  // 08-29 Test 1 session that surfaced this had reply_chars=0 with
  // block_types=[thinking,text], meaning the model spent its whole budget on
  // the thinking block and never emitted a text delta at all. That is a
  // different failure than a marker sitting at position 0 with a full reply
  // behind it, and telling them apart later requires these fields, not just
  // the final text.
  return { fullText, usage, blockTypesSeen, stopReason };
}


// ---------------------------------------------------------------------------
// CANDIDATE SELECTION (D-023)
//
// Walks Groove's own ranking top-down and takes a candidate unless it violates
// a set constraint. "Best" is his editorial judgment, not a score we computed.
//
// Deliberately NOT a scoring heuristic. A heuristic would be quietly rebuilding
// a ranking algorithm, which is precisely what D-009 says this product does not
// do. The constraints are a filter that guarantees variety; the taste is his.
//
// Auditable by design: rank is logged alongside engagement, so we can later test
// whether rank-1 picks actually outperform rank-3. If they do not, ordering is
// noise and this whole function collapses to "take the first three that
// validate." That test is a strong candidate for the documented data-driven
// iteration the case study needs.
// ---------------------------------------------------------------------------

const MAX_SURFACED = 3;
const MAX_WIDE_SURFACED = 1;

// Validation outcomes that must never reach a normal card. 'wrong_title'
// joins 'not_found' here: the artist is real but the recommended TRACK could
// not be confirmed, so the enrichment we would attach (preview, artwork,
// year, store link) belongs to a different song. Roadmap v2 R2 treats one
// misattributed track as a trust cliff, not a slope, which is why this fails
// closed.
//
// BUG THIS FIXES (found by F2's own test suite, Brief I): 'unconfirmed' was
// missing from this set entirely. validateOneTrack returns enriched: null
// for 'unconfirmed' exactly like 'not_found' does, so a candidate that hit a
// transient iTunes network failure was passing isUnshippable() and surfacing
// as an ordinary RecommendationCard with no artwork, no preview, and no
// Apple Music link -- silently broken-looking, not excluded. It also is not
// a 'not_found' EITHER, so it was never eligible for the new hunt-card path
// (correctly -- a network blip is not evidence a track is real, just
// evidence we don't know, see the hunt-eligibility comment below). It needs
// to be excluded from both paths, not fall through a gap between them.
//
// Brief N, N-5: 'misattributed' joins the set the same way. iTunes confirmed
// the TITLE exists, just under a different artist than Groove named -- the
// enrichment validateOneTrack would attach belongs to that other artist's
// recording, not the one being recommended, so it's exactly as unshippable
// as wrong_title for the same reason. It also fails the hunt-card check
// below on its own: that check requires itunesValidation === 'not_found'
// exactly, and 'misattributed' never satisfies that, so no separate change
// is needed there -- the hunt card's promise is that the record is out
// there under the recommended name, and a misattributed candidate is
// evidence it isn't.
const UNSHIPPABLE_VALIDATION = new Set([
  'not_found',
  'wrong_title',
  'unconfirmed',
  'misattributed',
]);

function isUnshippable(candidate) {
  return UNSHIPPABLE_VALIDATION.has(candidate.itunesValidation);
}

function normalizeArtistKey(name) {
  return (name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Brief A: what bends, and in what order, when Groove cannot fill three
// slots. Higher-numbered rules yield to lower-numbered ones:
//   1. Verification never bends (isUnshippable, checked in every stage).
//   2. (Speech never bends — handled in the handler, not here.)
//   3. Three-different-types bends FIRST. Stage 2 below drops takenTypes.
//   4. The WIDE-tier quota (D-021) never bends silently. It stays active in
//      every stage this function has. There is no stage 3.
//   5. An explicit request is exempt from the no-repeat rule entirely,
//      in every stage — see isExemptRepeat.
//
// BUG THIS REPLACES: the old relaxation pass dropped BOTH the type-spread
// check AND the WIDE quota at once, checking only validation and
// artist-repeat. The type drop is the intended, visible relaxation (rule 3).
// The quota drop was never intended and was invisible: a struggling turn
// could silently surface three mainstream (WIDE) picks, which is D-021 — the
// entire novelty objective — quietly suspended on exactly the turns where a
// user most needed the "good, but overlooked" answer instead of "safe."
function isExemptRepeat(artistKey, takenArtists, requestedKeys) {
  return takenArtists.has(artistKey) && !requestedKeys.has(artistKey);
}

/**
 * @param {Array} validated - candidates in Groove's rank order, each carrying
 *   `itunesValidation` and a `_rank` index.
 * @param {string[]} priorArtists - artists already recommended this conversation
 * @param {object|null} sourceTrack - what the user brought
 * @param {string[]} requestedArtists - artists the user named BY NAME this
 *   turn (Brief A, rule 5). Exempt from the no-repeat check even if they are
 *   in priorArtists or are the source track's own artist.
 */
function selectSurfaced(validated, priorArtists = [], sourceTrack = null, requestedArtists = []) {
  const takenTypes = new Set();
  const takenArtists = new Set(priorArtists.map(normalizeArtistKey));
  if (sourceTrack?.artist) takenArtists.add(normalizeArtistKey(sourceTrack.artist));
  const requestedKeys = new Set(
    (requestedArtists || []).map(normalizeArtistKey).filter(Boolean)
  );

  const surfaced = [];
  const skipped = [];
  let wideCount = 0;

  // Stage 1 — every rule active.
  for (const c of validated) {
    if (surfaced.length >= MAX_SURFACED) break;

    const artistKey = normalizeArtistKey(c.artist);
    let reason = null;
    if (isUnshippable(c)) reason = 'validation_failed';
    else if (isExemptRepeat(artistKey, takenArtists, requestedKeys)) reason = 'artist_repeat';
    else if (takenTypes.has(c.connectionType)) reason = 'type_taken';
    else if (c.tier === 'wide' && wideCount >= MAX_WIDE_SURFACED) reason = 'wide_quota';

    if (reason) {
      skipped.push({ track: c.track, artist: c.artist, rank: c._rank, reason });
      continue;
    }

    surfaced.push(c);
    takenTypes.add(c.connectionType);
    takenArtists.add(artistKey);
    if (c.tier === 'wide') wideCount += 1;
  }

  // Stage 2 — relax the connection-type rule ONLY (rule 3). Verification,
  // the repeat exemption, and the WIDE quota (rule 4) all carry over
  // unchanged from stage 1's accumulated state. If this still leaves fewer
  // than three, that is the correct, final answer — there is no stage 3.
  let stage = 1;
  if (surfaced.length < MAX_SURFACED) {
    stage = 2;
    for (const c of validated) {
      if (surfaced.length >= MAX_SURFACED) break;
      if (surfaced.includes(c)) continue;

      const artistKey = normalizeArtistKey(c.artist);
      if (isUnshippable(c)) continue;
      if (isExemptRepeat(artistKey, takenArtists, requestedKeys)) continue;
      if (c.tier === 'wide' && wideCount >= MAX_WIDE_SURFACED) continue;
      // type_taken deliberately NOT checked here — this is the one relaxation.

      surfaced.push(c);
      takenArtists.add(artistKey);
      if (c.tier === 'wide') wideCount += 1;
    }
  }

  // D-037. A track we cannot play is a find, not a failure -- but only
  // 'not_found' qualifies. 'wrong_title' means iTunes confirmed the ARTIST
  // is real but no result's TITLE matched, which is the exact signature
  // Bug 3 (2026-09-01) traced to Groove inventing titles for real artists
  // when the pool is empty -- presenting one of those as "worth the dig"
  // would misrepresent a likely-fabricated track as a genuine rare find.
  // 'unconfirmed' (a transient iTunes network failure) is excluded for the
  // same reason: it is not evidence the track is real, just evidence we
  // don't know. Only 'not_found' -- artist and title both unmatched in
  // every searched store -- fits the premise, which the whole feature is
  // built on the measured 32% Apple Music hit rate for underground rap.
  //
  // At most one, ever, per the brief: two hunt cards reads as a broken
  // product, one reads as a lead. Only added when stages 1-2 left room --
  // never on top of three already-playable cards.
  let huntAdded = false;
  if (surfaced.length < MAX_SURFACED) {
    for (const c of validated) {
      if (huntAdded) break;
      if (c.itunesValidation !== 'not_found') continue;
      const artistKey = normalizeArtistKey(c.artist);
      if (isExemptRepeat(artistKey, takenArtists, requestedKeys)) continue;
      surfaced.push({ ...c, isHunt: true });
      takenArtists.add(artistKey);
      huntAdded = true;
    }
  }

  return { surfaced, skipped, stage };
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
    // Brief B, Change 1. The single "what is the user currently orbiting"
    // signal for pool seeding — see resolveSeedArtist in lastfm.js. Distinct
    // from sourceTrack: sourceTrack only updates on a full track confirmation
    // and still drives the "ON THE TABLE" card and source-track grounding
    // block, both unrelated to pool seeding and left untouched here.
    orbitArtist = null,

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

  // Brief D, Part 5. One array, request-scoped (never module-level -- Vercel
  // can serve concurrent requests from one warm instance, and a shared
  // global queue would risk mixing turns). Every cacheSet call site in this
  // turn pushes into it instead of writing immediately; flushed once, near
  // the end of the handler, well after the response has been sent. See
  // api/lib/itunesCache.js for why (the batching+waitUntil rationale lives
  // there, not duplicated here).
  const cacheWriteBatch = [];

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
          languageHintForSource,
          cacheWriteBatch
        );
        console.log(
          `[source] "${sourceTrack.track}" by ${sourceTrack.artist} -> ` +
            `${sourceFacts?.confidence || 'none'}`
        );
      } catch (err) {
        console.error('Source track lookup failed (non-fatal):', err?.message || err);
      }
    }

    // --- Last.fm candidate pool ---------------------------------------------
    //
    // Seeded from orbitArtist: whatever artist or track the user named most
    // recently, as of the end of the PREVIOUS turn (see the "next turn's
    // orbit" comment near the done payload below for how it updates). Brief
    // B, Change 1 replaced the old sourceTrack/previousRecommendations
    // priority here — sourceTrack still exists and is still used elsewhere
    // in this function, just no longer for this.
    //
    // Fails open by design: null pool means Groove generates from memory
    // exactly as before. Never let an optimisation break a reply.
    let candidatePool = null;
    const seedArtist = resolveSeedArtist(orbitArtist, previousRecommendations);
    if (seedArtist) {
      try {
        candidatePool = await getCandidatePool(seedArtist);
      } catch (err) {
        console.error('Candidate pool fetch failed (non-fatal):', err?.message || err);
      }
      // Brief I: a console.log alone does not survive to next week --
      // Vercel discards runtime logs within the hour (see the
      // rec_candidates_generated comment in this file for the same lesson
      // learned once already). This is the durable form: UAT traffic on the
      // 8th/9th gives a real distribution of how often resolution fails,
      // instead of reasoning from a sample of ten hand-picked artists.
      if (!candidatePool) {
        logEventSafe(sessionId, 'lastfm_pool_unresolved', { seed_artist: seedArtist }, isTester);
      }
    }

    // Rebuild the addendum now that the pool is known. getLoreAddendum is pure,
    // so calling it twice is cheap, and this keeps the pool fetch off the path
    // of everything that does not depend on it.
    const loreAddendumWithPool = getLoreAddendum(daysSeen, {
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
      candidatePool,
      // Brief I. Distinct from "no seed artist yet" (turn 1, nothing named
      // yet -- candidatePool is null there too, but nothing is wrong): this
      // is specifically true when a seed WAS resolved and the pool fetch
      // still came back empty (see Bug 3's table -- Groove inventing titles
      // when the pool is empty, not just thinner).
      poolAttemptedButEmpty: Boolean(seedArtist) && !candidatePool,
    });

    const systemBlocks = buildSystemBlocks(
      loreAddendumWithPool,
      sourceFacts,
      sourceTrack,
      previousRecommendations
    );

    const {
      fullText: rawReplyText,
      usage: streamUsage,
      blockTypesSeen: streamBlockTypes,
      stopReason: streamStopReason,
    } = await streamClaudeReply({ messages, systemBlocks, res });

    const extracted = extractStructuredData(rawReplyText);
    const {
      candidates,
      followUpQuestion,
      arcBeatDelivered,
      askOffered,
      askAnswered,
      inputTrack,
      requestedArtists,
      recsFailureReason,
    } = extracted;
    // `let`, not `const`: the empty-reply guard below may need to replace this
    // with a fallback line.
    let { cleanedReply } = extracted;

    // Change 1 (Brief A). Three distinct upstream causes all land here as an
    // empty cleanedReply, and this is the ONLY place any of them gets a
    // user-visible recovery:
    //   - the marker sits at position 0 (nothing precedes it);
    //   - the text delta never arrived at all (budget spent entirely on a
    //     thinking block; see the 08-29 Test 1 evidence, reply_chars=0 with
    //     block_types=[thinking,text]);
    //   - salvage() had nothing salvageable before a malformed or superseded
    //     block (see salvage()'s own comment — it deliberately does NOT pick
    //     a fallback itself, so it cannot silently defeat this check the way
    //     the old apology string did).
    // In every case the model produced *something* server-side, but the user
    // sees nothing and has no way to tell the difference from a hung
    // request. Speech never bends (rule 2), so this is caught
    // unconditionally, regardless of which cause produced it.
    // Brief K, §2. `isBlank` no longer immediately writes a fallback to the
    // client -- it used to, which is exactly what produced the contradiction
    // this fixes: the apology streamed before candidate validation had even
    // started, so it was blind to whether real cards were about to surface.
    // A blank-prose turn that also validated real candidates showed
    // "Something cut out... try me again?" directly above three valid
    // cards -- telling the user the turn failed while proving otherwise
    // underneath. The diagnostic logging below still fires immediately
    // (this is real, worth tracking regardless of outcome); the DECISION
    // about what the user sees is deferred to after `surfaced` is known,
    // near the end of this function.
    const isBlank = !cleanedReply || !cleanedReply.trim();
    if (isBlank) {
      console.warn(
        `Groove reply rendered blank. output_tokens=${streamUsage.output} ` +
          `block_types=[${[...streamBlockTypes].join(',')}] stop_reason=${streamStopReason}`
      );
      if (process.env.BRIEF_K_DEBUG) {
        console.warn(
          `[brief-k-debug] raw API response, first 200 chars: ${JSON.stringify(rawReplyText.slice(0, 200))}`
        );
      }
      if (sessionId) {
        logEventSafe(
          sessionId,
          'empty_reply_recovered',
          {
            output_tokens: streamUsage.output,
            block_types: [...streamBlockTypes],
            stop_reason: streamStopReason,
          },
          isTester
        );
      }
    } else if (recsFailureReason) {
      // Change 1, follow-up (Brief A, D-033). Different shape of the same
      // family: cleanedReply is NOT blank here (real text already streamed
      // above, via processDeltaText, before the marker) but the recs
      // metadata behind it broke server-side (see recsFailureReason —
      // salvage() only sets this for a RECS-type block, never a META one).
      // candidates is [] in this branch (salvage() always returns empty
      // candidates), so the block below never runs and no cards would ever
      // appear — the turn would otherwise read as an opening reflection
      // with no follow-through. Logged distinctly from empty_reply_recovered:
      // this is a different failure (breakage after a real reply, not
      // silence) and the frequencies need to stay separable.
      const closer = pickRecsDroppedFallback();
      console.warn(
        `Groove recs dropped after real text streamed. reason=${recsFailureReason} ` +
          `output_tokens=${streamUsage.output} block_types=[${[...streamBlockTypes].join(',')}] ` +
          `stop_reason=${streamStopReason}`
      );
      if (sessionId) {
        logEventSafe(
          sessionId,
          'recs_dropped_after_reply',
          {
            reason: recsFailureReason,
            output_tokens: streamUsage.output,
            block_types: [...streamBlockTypes],
            stop_reason: streamStopReason,
          },
          isTester
        );
      }
      res.write(JSON.stringify({ type: 'delta', text: `\n\n${closer}` }) + '\n');
      cleanedReply = `${cleanedReply}\n\n${closer}`;
    }

    let enrichedRecs = [];
    // Declared outside the block below so the deferred isBlank resolution
    // (after this block) can see it regardless of whether candidates.length
    // was 0 to begin with -- an empty candidates list trivially means
    // surfaced stays [].
    let surfaced = [];

    if (candidates.length > 0) {
      const languageHint = clientLanguageHint || detectLanguageHint(messages);

      // Validate ALL candidates in parallel, then select.
      //
      // This costs the progressive card reveal that v2a had, where each card
      // appeared the moment its own lookup resolved. Selection needs the whole
      // set: a lower-ranked candidate resolving first must not take a slot the
      // higher-ranked one deserves. The wait is now bounded by the slowest of
      // six rather than the slowest of three, which the Supabase-backed iTunes
      // cache should mostly absorb.
      const validated = await Promise.all(
        candidates.map(async (c, i) => {
          const { status, enriched, misattributedArtist } = await validateOneTrack(
            c,
            languageHint,
            cacheWriteBatch
          );
          return {
            ...c,
            _rank: i + 1,
            itunesValidation: status,
            previewUrl: enriched?.previewUrl ?? null,
            artworkUrl: enriched?.artworkUrl ?? null,
            trackViewUrl: enriched?.trackViewUrl ?? null,
            releaseYear: enriched?.releaseYear ?? null,
            // Diagnostic only -- not surfaced on any card. Brief N, N-5: lets
            // the itunes_validation_failed log line below say who iTunes
            // actually credits the title to, not just that it was someone else.
            misattributedArtist: misattributedArtist ?? null,
          };
        })
      );

      const priorArtists = previousRecommendations.map((r) => r.artist).filter(Boolean);
      const selection = selectSurfaced(validated, priorArtists, sourceTrack, requestedArtists);
      surfaced = selection.surfaced;
      const { skipped, stage } = selection;

      const failed = validated.filter(isUnshippable);
      // Brief B, Change 3: separated so both events below can report them
      // independently — this is the pair that tells us whether Change 2
      // (real track grounding) actually worked. not_found means the model
      // named a track that plain does not exist; wrong_title means the
      // ARTIST was real but the TRACK was not the one recommended (the
      // 0829-patch failure mode). Change 2 should drive not_found down
      // sharply; if wrong_title rises instead, titles are arriving from the
      // pool but arriving dirty, which is a titlesMatch problem, not this one.
      const notFoundCount = failed.filter((r) => r.itunesValidation === 'not_found').length;
      const wrongTitleCount = failed.filter((r) => r.itunesValidation === 'wrong_title').length;
      // Brief N, N-5's measurement ask: how big is this failure mode. Counted
      // the same way notFoundCount/wrongTitleCount already are, so it slots
      // into the existing before/after read on this log line rather than
      // needing a separate one-off query.
      const misattributedCount = failed.filter(
        (r) => r.itunesValidation === 'misattributed'
      ).length;

      if (sessionId && failed.length > 0) {
        logEventSafe(
          sessionId,
          'itunes_validation_failed',
          {
            failed_tracks: failed.map((r) => ({
              track: r.track,
              artist: r.artist,
              reason: r.itunesValidation,
              ...(r.itunesValidation === 'misattributed'
                ? { misattributed_artist: r.misattributedArtist }
                : {}),
            })),
            failed_count: failed.length,
            wrong_title_count: wrongTitleCount,
            misattributed_count: misattributedCount,
            total_candidates: validated.length,
          },
          isTester
        );
      }

      for (const rec of surfaced) {
        res.write(JSON.stringify({ type: 'rec_ready', rec }) + '\n');
      }

      // Rank alongside what was shown is the whole point of logging this: it is
      // what makes the "does rank-1 beat rank-3" test possible in September.
      if (sessionId) {
        for (const rec of surfaced) {
          logEventSafe(
            sessionId,
            'rec_shown',
            {
              track: rec.track,
              artist: rec.artist,
              connection_type: rec.connectionType,
              tier: rec.tier,
              distant: !!rec.distant,
              rank: rec._rank,
            },
            isTester
          );
        }
        if (skipped.length > 0) {
          logEventSafe(sessionId, 'rec_candidates_skipped', { skipped }, isTester);
        }
      }

      enrichedRecs = surfaced;

      // Brief D, Part 4. BUG THIS FIXES: the old single `pool=N/6` counted
      // artist-name overlap only, so `pool=4/6` with `validated_ok=1` was
      // unreadable — it could mean either "he used our data and Apple Music
      // doesn't have it" or "he took our artist and invented a title anyway,"
      // two different problems with two different fixes. Splitting into
      // pool_artist (artist name matches a pool entry) and pool_track
      // (the SAME candidate's track also matches one of that artist's real
      // getTopTracks titles, via titlesMatch — not a naive exact-string
      // compare, since minor formatting drift between what Groove writes and
      // what Last.fm stored is expected and not itself a grounding failure)
      // makes the diagnosis read off the log line directly: pool_artist=6/6
      // pool_track=1/6 means grounding is being ignored; pool_artist=6/6
      // pool_track=6/6 means grounding worked and the catalogue is the limit.
      let poolArtistHits = 0;
      let poolTrackHits = 0;
      if (candidatePool) {
        for (const c of candidates) {
          const poolArtist = candidatePool.artists.find(
            (a) =>
              (a.name || '').toLowerCase().trim() === (c.artist || '').toLowerCase().trim()
          );
          if (!poolArtist) continue;
          poolArtistHits += 1;
          if ((poolArtist.topTracks || []).some((t) => titlesMatch(t, c.track))) {
            poolTrackHits += 1;
          }
        }
      }

      // Brief B, Change 3. BUG THIS FIXES: this used to fire (as
      // rec_candidates_generated) immediately after `if (candidates.length >
      // 0)`, before validation or selection had run — so its payload could
      // only ever carry pre-validation facts (count, types, tiers, pool
      // size). validated_ok, surfaced, skip reasons, and relaxation stage
      // did not exist yet at that point in the code, so they were never
      // recorded anywhere queryable: only console.log saw them, and Vercel's
      // free tier discards runtime logs within the hour. Of Test 1's seven
      // turns, the two that surfaced nothing left almost no trace in
      // Supabase, and "1 turn in 7 delivered three cards" was not
      // recomputable from the database — exactly the funnel gap Roadmap v2's
      // v1 definition-of-done requires closed.
      //
      // Moved here (same event NAME, same firing condition — still gated by
      // the enclosing `if (candidates.length > 0)`, so this remains the
      // unconditional one-event-per-recs-turn Brief B asked for; a turn with
      // NO recs attempted at all correctly logs nothing here) so the payload
      // can report the full outcome in one row instead of a fact half of it.
      if (sessionId) {
        const skipReasonCounts = skipped.reduce((acc, s) => {
          acc[s.reason] = (acc[s.reason] || 0) + 1;
          return acc;
        }, {});

        logEventSafe(
          sessionId,
          'rec_candidates_generated',
          {
            generated: candidates.length,
            validated_ok: validated.length - failed.length,
            surfaced: surfaced.length,
            not_found_count: notFoundCount,
            wrong_title_count: wrongTitleCount,
            misattributed_count: misattributedCount,
            types: candidates.map((c) => c.connectionType),
            tiers: candidates.map((c) => c.tier),
            distant_count: candidates.filter((c) => c.distant).length,
            seed_artist: seedArtist,
            pool_size: candidatePool?.artists?.length || 0,
            pool_artist_hits: poolArtistHits,
            pool_track_hits: poolTrackHits,
            relaxation_stage: stage,
            skip_reason_counts: skipReasonCounts,
          },
          isTester
        );
      }

      console.log(
        `[recs] generated=${candidates.length} validated_ok=${
          validated.length - failed.length
        } surfaced=${surfaced.length} ranks=[${surfaced
          .map((r) => r._rank)
          .join(',')}] types=[${surfaced.map((r) => r.connectionType).join(',')}]` +
          ` pool_artist=${candidatePool ? `${poolArtistHits}/${candidates.length}` : 'none'}` +
          ` pool_track=${candidatePool ? `${poolTrackHits}/${candidates.length}` : 'none'}` +
          // Brief A, Change 3: stage=1 means every rule held; stage=2 means the
          // type-spread rule (D-022) was relaxed to reach this count. Never
          // stage 3 — the WIDE quota (D-021) has no relaxed stage to log.
          ` stage=${stage}` +
          // Brief D, Part 1: not_found/wrong_title weren't in this line before —
          // only in the itunes_validation_failed event — so a console-log-based
          // harness (replay.mjs, run where Supabase creds aren't available)
          // couldn't recover them. Not otherwise used by this line's readers.
          ` not_found=${notFoundCount} wrong_title=${wrongTitleCount} misattributed=${misattributedCount}` +
          ` pool_size=${candidatePool?.artists?.length || 0} seed=${seedArtist || 'none'}`
      );
    }

    // Brief K, §2. The deferred half of the isBlank branch above: now that
    // `surfaced` is known, decide what the user actually sees. This is the
    // fix for the contradiction regardless of why the prose came back
    // blank in the first place -- rule 2c is what SHOULD prevent isBlank
    // from ever being true, this is the backstop for when it doesn't.
    if (isBlank) {
      if (surfaced.length > 0) {
        // Say nothing rather than something that contradicts the cards
        // underneath it. The client already renders a contentless message
        // correctly as long as recs exist (see the hasNothing check in
        // App.jsx, which OR's in msg.recs.length > 0) -- this needs no
        // client-side change to work.
        console.warn(
          `Groove reply blank but ${surfaced.length} card(s) surfaced anyway -- ` +
            `suppressing the "try again" fallback so it does not contradict what is on screen.`
        );
        if (sessionId) {
          logEventSafe(
            sessionId,
            'empty_reply_recovered_with_cards',
            { surfaced_count: surfaced.length },
            isTester
          );
        }
        // cleanedReply stays '' -- intentionally, not overwritten.
      } else {
        const fallback = pickEmptyReplyFallback();
        res.write(JSON.stringify({ type: 'delta', text: fallback }) + '\n');
        cleanedReply = fallback;
      }
    }

    // --- progress logging -------------------------------------------------

    if (sessionId) {
      // Brief D, Part 1. Fields beyond content_length added so replay.mjs can
      // derive thinking-token share on EVERY turn, including ones with no
      // candidates at all (a pure-conversation turn, or one that hit
      // salvage()) — those never reach rec_candidates_generated, but this
      // event already fires unconditionally for every turn regardless.
      // rawReplyText.length is the FULL text (prose + stripped metadata
      // block), unlike content_length which is visible-only; the harness
      // uses it plus output_tokens to estimate the split, since the API does
      // not separately report thinking-vs-text token counts.
      logEventSafe(
        sessionId,
        'message_sent',
        {
          role: 'assistant',
          content_length: cleanedReply.length,
          raw_reply_chars: rawReplyText.length,
          output_tokens: streamUsage.output,
          input_tokens: streamUsage.input,
          stop_reason: streamStopReason,
        },
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

    // --- input track: verify what Groove thought they meant -----------------
    //
    // RESTORES A REGRESSION. Deleting the form removed the only thing that set
    // sourceTrack, so lookupTrackFacts stopped running and title-collision
    // grounding went dead. That guard exists because of a real failure: given
    // "Blue in Green" by a modern Japanese artist, Groove pattern-matched the
    // 1959 Miles Davis standard and anchored all three recommendations to the
    // wrong song.
    //
    // Extraction happens in his reply, so the FIRST turn of a conversation is
    // still ungrounded. Verifying here means the card shows the catalog's
    // answer rather than his guess, and the next turn is grounded.
    let verifiedInputTrack = null;
    if (inputTrack?.track && inputTrack?.artist) {
      const hint = clientLanguageHint || detectLanguageHint(messages);
      let facts = null;
      try {
        facts = await lookupTrackFacts(inputTrack.track, inputTrack.artist, hint, cacheWriteBatch);
      } catch (err) {
        console.error('Input track lookup failed (non-fatal):', err?.message || err);
      }

      verifiedInputTrack = {
        // What Groove read, kept so the client can show a correction affordance
        // against the thing the user actually typed about.
        track: facts?.trackName || inputTrack.track,
        artist: facts?.artistName || inputTrack.artist,
        confidence: facts?.confidence || 'unverified',
        genre: facts?.genre || null,
        year: facts?.releaseYear || null,
      };

      console.log(
        `[input] "${inputTrack.track}" by ${inputTrack.artist} -> ${verifiedInputTrack.confidence}`
      );

      if (sessionId) {
        logEventSafe(
          sessionId,
          'input_track_identified',
          {
            track: verifiedInputTrack.track,
            artist: verifiedInputTrack.artist,
            confidence: verifiedInputTrack.confidence,
          },
          isTester
        );
      }
    }

    // Brief B, Change 1: next turn's orbit. Chose approach (a) from the
    // brief — reuse what Groove already reports rather than adding a model
    // call or a server-side message-parsing step. requestedArtists wins when
    // present: it is the most direct "this is who I want" signal Brief A
    // already added (populated on META turns too, so a bare artist mention
    // with no recs asked for still updates it). inputTrack.artist is the
    // fallback: a full track confirmation implies its artist just as much,
    // and covers the case where the user names a track but the model does
    // not also echo the artist into requestedArtists. If NEITHER fired this
    // turn, orbitArtist carries forward unchanged rather than resetting to
    // null — silence this turn does not mean the user stopped orbiting
    // whatever they last named.
    const nextOrbitArtist =
      requestedArtists[requestedArtists.length - 1] || verifiedInputTrack?.artist || orbitArtist;

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
        inputTrack: verifiedInputTrack,
        orbitArtist: nextOrbitArtist,
      }) + '\n'
    );
    res.end();
    // Brief D, Part 5. AFTER res.end() on purpose: the client already has its
    // response by this point (zero perceived latency), but the handler's own
    // promise has not resolved yet, so Vercel has no reason to freeze the
    // instance before this await settles -- that is what actually fixes the
    // lost-write bug, not waitUntil alone. waitUntil (used inside
    // flushCacheWrites when a live context is available) is the further
    // optimization that lets Vercel stop billing/holding the invocation open
    // for this tail write; awaiting it here is still correct and safe either
    // way, since in that branch the promise is already resolved.
    await flushCacheWrites(cacheWriteBatch);
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
    // Whatever candidates got validated before the error still deserve their
    // cache write -- don't let a failed turn also waste the iTunes lookups
    // it already paid for. flushCacheWrites never throws, but this is the
    // last-resort error path, so guard it anyway rather than trust that.
    try {
      await flushCacheWrites(cacheWriteBatch);
    } catch (flushErr) {
      console.error('[itunes_cache] flush after error failed:', flushErr?.message || flushErr);
    }
  }
}