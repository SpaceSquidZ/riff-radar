// scripts/replay.mjs
//
// Replays a scripted multi-turn conversation against /api/chat, carrying
// forward exactly what the real client carries (sourceTrack, orbitArtist,
// previousRecommendations, conversation history), and records per-turn and
// per-card metrics to CSV.
//
// This harness outlives Brief D: run it before every deploy from here to
// launch, not just for the thinking A/B it was built for.
//
// USAGE (local, spawns its own server -- no Vercel CLI or Supabase key needed)
//   GROOVE_THINKING_ARM=A node scripts/replay.mjs --script mike --label armA \
//     --repeats 3 --spawn-local 8787
//
// USAGE (against an already-running server, local or a deployment)
//   node scripts/replay.mjs --script hecker --label armB --repeats 3 \
//     --target https://your-deployment.vercel.app
//
// Flags:
//   --script       mike | hecker | control            (required)
//   --label        run label, e.g. "armA"              (required)
//   --repeats      how many independent runs            (default 1)
//   --target       base URL of an already-running server (default http://localhost:8787)
//   --spawn-local  <port>: spawn scripts/local-server.mjs on this port
//                  ourselves and read generated/validated_ok/pool_*/output_tokens
//                  etc straight from ITS console output (see "Two data
//                  sources" below), instead of --target/Supabase. Overrides
//                  --target. Inherits GROOVE_THINKING_ARM from this
//                  process's own environment.
//   --out-dir      where to write CSVs                  (default ./replay-out)
//
// Two data sources for per-turn counts (generated, validated_ok, surfaced,
// not_found_count, wrong_title_count, pool_artist_hits, pool_track_hits,
// pool_size, seed_artist, relaxation_stage, output_tokens, blank-turn
// fallbacks): these are not part of the HTTP response, only of what the
// server logs.
//   1. --spawn-local: parsed directly from the child process's own stdout
//      ([recs]/[usage]/[lastfm] lines api/chat.js and api/lib/lastfm.js
//      already print on every request), windowed per turn by request order
//      since the server handles one request at a time. Needs no credentials.
//   2. --target (external server): queried from Supabase's `events` table
//      after the run, via SUPABASE_SERVICE_ROLE_KEY. If that key is not in
//      the environment, these columns come back blank -- ttft_ms,
//      duration_ms, and the per-card CSV (from rec_ready events on the wire)
//      are unaffected either way.

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadRepoEnv } from './loadEnv.mjs';

// Must run before src/supabaseClient.js is ever imported: it reads its env
// vars into top-level consts once, at module-evaluation time, and ESM
// static imports are hoisted above everything else in a file regardless of
// where they're written -- so that import has to be dynamic (done in
// main(), after this call) rather than static, or it would always see an
// empty environment no matter what loadRepoEnv() does afterward.
loadRepoEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// NOTE on opener pairs: a real session always carries one (rendered into the
// system prompt as "# What you have on tonight", src/groovePrompt.js:690-704)
// before the user's first message. This was tried here and reverted: giving
// every run the SAME fixed, concrete opener track actively confounds the
// "mike" script, whose early turns are single ambiguous words ("MIKE") with
// no other grounding -- the model latched onto the opener's track as
// sourceTrack instead of treating "MIKE" as an artist reference, which
// zeroed out candidate generation entirely (verified via a smoke test: 0/6
// turns produced cards with the opener vs. history's 5/6). Since these
// scripts are engineered probes continuing Brief C's existing measurements
// (not literal organic-first-message simulations) and the real question in
// Part 2 is the RELATIVE gap between thinking arms under an identical
// harness, omitting the opener -- as the original Brief C sessions this
// harness continues did -- is the more faithful choice here, not a shortcut.
//
// CORRECTED 2026-08-30 (second time this exact mistake was made in one
// day): the scripts below were STILL wrong. "MIKE" / "Tim Hecker" bare were
// my own reconstruction from a terse metrics-table summary, not what was
// actually typed on 2026-08-29/30 -- the real messages were full sentences
// ("Hey, I'm listening to MIKE. can you share more songs like his?"), gotten
// directly from the person who typed them. This retroactively explains the
// "OPEN LEAD" below: a bare artist name is a materially different, harder
// input than a full sentence naming intent, so the whole "MIKE is a genuine
// coin-flip" finding two paragraphs down was real -- just an answer to a
// question nobody was asking, because the script under test was never the
// production one. Not re-verified against the corrected wording yet before
// this got fixed; treat the coin-flip claim below as retracted pending a
// fresh run, not confirmed to still hold.

// --- scripts -----------------------------------------------------------

// Verbatim, from the person who typed them into the app on 2026-08-30.
// Two prior versions of this file had paraphrases here instead ("MIKE" bare,
// then "MIKE" bare again after a first "verbatim" claim that was also
// wrong) -- see the CORRECTED note above. Do not tidy this wording.
const SCRIPT_MIKE = [
  "Hey, I'm listening to MIKE. can you share more songs like his?",
  'Can you tell me about people in his immediate circle?',
  'Can you share me a few other songs from people in his immediate circle?',
  'can you tell me more about the people in his immediate circle?',
  'Maybe share with me some songs from Slauson Malone',
  "Can you share more Slauson Malone's dongs specifically?",
];

const SCRIPT_HECKER = [
  "I'm listening to Tim Hecker. Can you share more songs like his?",
  'Actually, what about Grouper?',
];

// A third genre, chosen deliberately to be neither ambient (thin, per Test 2)
// nor underground rap (thin, per Test 1): classic Motown/soul. Extremely
// well-documented and well-catalogued, so this is a high-anchor control
// point — without it, "32% for rap" only has one comparison (an
// inconclusive ambient number, see Brief C Q2) and we are generalizing from
// two genres instead of three.
const SCRIPT_CONTROL = [
  "I've been listening to Marvin Gaye's What's Going On album",
  'What else was Motown doing around that same time?',
  'Anything more from Marvin Gaye specifically?',
];

const SCRIPTS = { mike: SCRIPT_MIKE, hecker: SCRIPT_HECKER, control: SCRIPT_CONTROL };

// --- CLI args ------------------------------------------------------------

function parseArgs(argv) {
  const out = { repeats: 1, target: 'http://localhost:8787', outDir: './replay-out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--script') out.script = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--repeats') out.repeats = Number(argv[++i]);
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--spawn-local') out.spawnLocalPort = Number(argv[++i]);
    else if (a === '--out-dir') out.outDir = argv[++i];
  }
  if (!out.script || !SCRIPTS[out.script]) {
    throw new Error(`--script must be one of: ${Object.keys(SCRIPTS).join(', ')}`);
  }
  if (!out.label) throw new Error('--label is required (e.g. "armA")');
  if (out.spawnLocalPort) out.target = `http://localhost:${out.spawnLocalPort}`;
  return out;
}

// --- CSV -------------------------------------------------------------------

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

// --- local server child process + console-log parsing -----------------

function spawnLocalServer(port) {
  const lines = [];
  const child = spawn('node', [path.join(__dirname, 'local-server.mjs'), String(port)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) lines.push(line);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('local-server did not start in time')), 10000);
    const check = setInterval(() => {
      if (lines.some((l) => l.includes('listening on'))) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 50);
    child.on('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`local-server exited early (code ${code})`));
    });
  });

  return { child, lines, ready };
}

// Parses the console lines produced by a single turn's request (see the
// windowing note at the call site: the server handles one request at a time,
// so everything logged between "turn started" and "turn's HTTP response
// fully read" belongs to that turn and no other).
function parseServerLogWindow(windowLines) {
  const text = windowLines.join('\n');

  const recsMatch = text.match(
    /\[recs\] generated=(\d+) validated_ok=(\d+) surfaced=(\d+) ranks=\[[^\]]*\] types=\[[^\]]*\] pool_artist=(\S+) pool_track=(\S+) stage=(\S+) not_found=(\d+) wrong_title=(\d+) pool_size=(\d+) seed=(\S.*)/
  );

  // Multiple [usage] lines can appear in one turn's window (e.g. one call
  // for a pure-conversation reply, or a retry after a 5xx) -- the LAST one
  // reflects the reply actually sent to the user.
  const usageMatches = [...text.matchAll(/\[usage\] output_tokens=(\d+) input_tokens=(\d+) [^\n]*?stop_reason=(\S+) reply_chars=(\d+)/g)];
  const usage = usageMatches.length ? usageMatches[usageMatches.length - 1] : null;

  const blankFired = /Groove reply rendered blank/.test(text);
  const dropsFired = /Groove recs dropped after real text streamed/.test(text);

  const parseFraction = (s) => {
    if (!s || s === 'none') return 0;
    const [num] = s.split('/');
    return Number(num) || 0;
  };

  return {
    generated: recsMatch ? Number(recsMatch[1]) : 0,
    validatedOk: recsMatch ? Number(recsMatch[2]) : 0,
    surfaced: recsMatch ? Number(recsMatch[3]) : 0,
    poolArtistHits: recsMatch ? parseFraction(recsMatch[4]) : 0,
    poolTrackHits: recsMatch ? parseFraction(recsMatch[5]) : 0,
    relaxationStage: recsMatch ? recsMatch[6] : '',
    notFoundCount: recsMatch ? Number(recsMatch[7]) : 0,
    wrongTitleCount: recsMatch ? Number(recsMatch[8]) : 0,
    poolSize: recsMatch ? Number(recsMatch[9]) : 0,
    seedArtist: recsMatch ? recsMatch[10].trim() : '',
    outputTokens: usage ? Number(usage[1]) : null,
    replyChars: usage ? Number(usage[4]) : null,
    blankTurnFallbackFired: blankFired || dropsFired,
  };
}

// --- Supabase event lookup, per session, partitioned by turn ---------------
// Used only when NOT spawning a local server (i.e. --target points at an
// already-running server, local or deployed, whose console output this
// process cannot see).
//
// Events are fire-and-forget (logEventSafe), so we query once at the end of
// the WHOLE script for a run (not after every turn) to give every write the
// most possible time to land, then partition by turn using each turn's own
// `message_sent` (role: 'user') event as the boundary marker -- turns run
// strictly sequentially in this harness (each awaits the previous turn's
// `done` before sending the next), so created_at order is turn order even
// though individual writes within a turn race each other.
async function fetchTurnEvents(supabaseAdmin, sessionId, turnCount) {
  if (!supabaseAdmin) {
    console.warn(
      '[replay] no supabaseAdmin (SUPABASE_SERVICE_ROLE_KEY unset) -- per-turn counts will be empty. Use --spawn-local instead to read them from console output.'
    );
    return Array.from({ length: turnCount }, () => []);
  }
  await new Promise((r) => setTimeout(r, 1500));

  const { data, error } = await supabaseAdmin
    .from('events')
    .select('event_type, payload, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[replay] events query failed:', error.message);
    return Array.from({ length: turnCount }, () => []);
  }

  const buckets = Array.from({ length: turnCount }, () => []);
  let turn = -1;
  for (const row of data || []) {
    if (row.event_type === 'message_sent' && row.payload?.role === 'user') {
      turn += 1;
    }
    if (turn >= 0 && turn < turnCount) buckets[turn].push(row);
  }
  return buckets;
}

function findEvent(bucket, type) {
  return bucket.find((r) => r.event_type === type)?.payload || null;
}

// --- one turn ----------------------------------------------------------

async function sendTurn({
  target,
  sessionId,
  apiMessages,
  sourceTrack,
  orbitArtist,
  previousRecommendations,
  userTurnCount,
}) {
  const start = performance.now();
  let ttftMs = null;
  let firstDeltaSeen = false;
  let visibleText = '';
  const cards = [];
  let doneEvent = null;

  const res = await fetch(`${target}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: apiMessages,
      sessionId,
      previousRecommendations,
      sourceTrack,
      orbitArtist,
      isTester: true,
      daysSeen: 0,
      daysSinceLast: null,
      deliveredArcBeats: [],
      deliveredLoreLines: [],
      offeredAsks: [],
      answeredAsks: [],
      pendingQuestion: null,
      pendingAskId: null,
      recLanguage: null,
      userTurnCount,
      openerPair: null,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`request failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'delta') {
        if (!firstDeltaSeen) {
          firstDeltaSeen = true;
          ttftMs = performance.now() - start;
        }
        visibleText += event.text;
      } else if (event.type === 'rec_ready') {
        cards.push(event.rec);
      } else if (event.type === 'done') {
        doneEvent = event;
      }
    }
  }

  const durationMs = performance.now() - start;
  return { durationMs, ttftMs, visibleText, cards, doneEvent };
}

// --- main ------------------------------------------------------------------

async function runOnce({ target, label, script, scriptName, runIndex, serverLog, supabaseAdmin }) {
  const sessionId = `replay-${label}-${scriptName}-${runIndex}-${randomUUID().slice(0, 8)}`;
  let messages = [];
  let sourceTrack = null;
  let orbitArtist = null;
  let previousRecommendations = [];
  const turnRows = [];
  const cardRows = [];

  for (let turnIndex = 0; turnIndex < script.length; turnIndex++) {
    const userMessage = script[turnIndex];
    messages.push({ role: 'user', content: userMessage });

    const logCursor = serverLog ? serverLog.length : 0;

    const { durationMs, ttftMs, visibleText, cards, doneEvent } = await sendTurn({
      target,
      sessionId,
      apiMessages: messages,
      sourceTrack,
      orbitArtist,
      previousRecommendations,
      // Matches src/App.jsx: userTurnCountRef starts at 0 and is incremented
      // to 1 before the first send, so turn index 0 carries userTurnCount 1.
      // Sending a large constant here (e.g. 99) wrongly unlocks
      // extrasAllowed() lore/arc-beat content on turn 1 that the real app
      // gates off until turn 2 (MIN_USER_TURNS_FOR_EXTRAS).
      userTurnCount: turnIndex + 1,
    });

    const logWindow = serverLog ? serverLog.slice(logCursor) : [];
    if (process.env.REPLAY_DEBUG_LOG) {
      console.error(`--- log window for turn ${turnIndex} ---\n${logWindow.join('\n')}\n--- end window ---`);
    }

    messages.push({ role: 'assistant', content: visibleText });

    if (doneEvent?.inputTrack) {
      const isSame =
        sourceTrack &&
        doneEvent.inputTrack.track === sourceTrack.track &&
        doneEvent.inputTrack.artist === sourceTrack.artist;
      if (!isSame) {
        sourceTrack = { track: doneEvent.inputTrack.track, artist: doneEvent.inputTrack.artist };
      }
    }
    if (doneEvent?.orbitArtist) orbitArtist = doneEvent.orbitArtist;

    for (const rec of cards) {
      previousRecommendations.push({ track: rec.track, artist: rec.artist });
      cardRows.push({
        card_id: randomUUID(),
        run_label: label,
        script: scriptName,
        turn_index: turnIndex,
        artist: rec.artist,
        track: rec.track,
        connection_type: rec.connectionType,
        novelty_tier: rec.tier,
        reasoning_text: rec.explanation,
      });
    }

    turnRows.push({
      turnIndex,
      userMessage,
      durationMs,
      ttftMs,
      cardsThisTurn: cards,
      logWindow,
      sessionId,
    });

    console.log(
      `  turn ${turnIndex + 1}/${script.length}: "${userMessage.slice(0, 40)}${userMessage.length > 40 ? '…' : ''}" -> ` +
        `${cards.length} cards, ttft=${ttftMs ? Math.round(ttftMs) : 'n/a'}ms, duration=${Math.round(durationMs)}ms`
    );
  }

  const supabaseBuckets = serverLog ? null : await fetchTurnEvents(supabaseAdmin, sessionId, script.length);

  const perTurnOutputRows = turnRows.map((t, i) => {
    let counts;
    if (serverLog) {
      counts = parseServerLogWindow(t.logWindow);
    } else {
      const bucket = supabaseBuckets[i];
      const recGen = findEvent(bucket, 'rec_candidates_generated');
      const msgSent = bucket.find(
        (r) => r.event_type === 'message_sent' && r.payload?.role === 'assistant'
      )?.payload;
      counts = {
        generated: recGen?.generated ?? 0,
        validatedOk: recGen?.validated_ok ?? 0,
        surfaced: recGen?.surfaced ?? t.cardsThisTurn.length,
        notFoundCount: recGen?.not_found_count ?? 0,
        wrongTitleCount: recGen?.wrong_title_count ?? 0,
        poolArtistHits: recGen?.pool_artist_hits ?? 0,
        poolTrackHits: recGen?.pool_track_hits ?? 0,
        poolSize: recGen?.pool_size ?? 0,
        seedArtist: recGen?.seed_artist ?? '',
        relaxationStage: recGen?.relaxation_stage ?? '',
        outputTokens: msgSent?.output_tokens ?? null,
        replyChars: msgSent?.raw_reply_chars ?? null,
        blankTurnFallbackFired:
          !!findEvent(bucket, 'empty_reply_recovered') || !!findEvent(bucket, 'recs_dropped_after_reply'),
      };
    }

    // DERIVED, not measured: the Anthropic API does not separately report
    // thinking vs. text token counts in `usage`. text_tokens is estimated
    // from reply_chars (prose + the stripped metadata JSON, i.e. everything
    // the model produced that was NOT thinking) at a rough ~4 chars/token
    // English-text ratio; thinking_tokens is the remainder. Treat both as
    // approximate.
    const textTokensEstimate =
      counts.replyChars != null ? Math.round(counts.replyChars / 4) : null;
    const thinkingTokensEstimate =
      counts.outputTokens != null && textTokensEstimate != null
        ? Math.max(0, counts.outputTokens - textTokensEstimate)
        : null;

    const tierCounts = {};
    for (const c of t.cardsThisTurn) {
      tierCounts[c.tier] = (tierCounts[c.tier] || 0) + 1;
    }
    const noveltyTiers = Object.entries(tierCounts)
      .map(([tier, n]) => `${tier}:${n}`)
      .join(';');

    return {
      run_label: label,
      run_index: runIndex,
      script: scriptName,
      turn_index: t.turnIndex,
      user_message: t.userMessage,
      duration_ms: Math.round(t.durationMs),
      ttft_ms: t.ttftMs != null ? Math.round(t.ttftMs) : '',
      output_tokens: counts.outputTokens,
      thinking_tokens: thinkingTokensEstimate,
      text_tokens: textTokensEstimate,
      generated: counts.generated,
      validated_ok: counts.validatedOk,
      surfaced: counts.surfaced,
      not_found_count: counts.notFoundCount,
      wrong_title_count: counts.wrongTitleCount,
      pool_artist_hits: counts.poolArtistHits,
      pool_track_hits: counts.poolTrackHits,
      pool_size: counts.poolSize,
      seed_artist: counts.seedArtist,
      relaxation_stage: counts.relaxationStage,
      blank_turn_fallback_fired: counts.blankTurnFallbackFired,
      novelty_tiers: noveltyTiers,
    };
  });

  return { perTurnOutputRows, cardRows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const script = SCRIPTS[args.script];

  mkdirSync(args.outDir, { recursive: true });

  // Dynamic on purpose -- see the loadRepoEnv() note above the static
  // imports at the top of this file. Only needed for the --target (external
  // server) path; --spawn-local's child does its own loading independently.
  const { supabaseAdmin } = await import('../src/supabaseClient.js');

  let serverHandle = null;
  if (args.spawnLocalPort) {
    console.log(
      `[replay] spawning local-server.mjs on port ${args.spawnLocalPort} (GROOVE_THINKING_ARM=${
        process.env.GROOVE_THINKING_ARM || '(unset, arm A default)'
      })`
    );
    serverHandle = spawnLocalServer(args.spawnLocalPort);
    await serverHandle.ready;
  }

  const allTurnRows = [];
  const allCardRows = [];

  try {
    for (let runIndex = 1; runIndex <= args.repeats; runIndex++) {
      console.log(`\n=== ${args.label} / ${args.script} / run ${runIndex} of ${args.repeats} ===`);
      const { perTurnOutputRows, cardRows } = await runOnce({
        target: args.target,
        label: args.label,
        script,
        scriptName: args.script,
        runIndex,
        serverLog: serverHandle ? serverHandle.lines : null,
        supabaseAdmin,
      });
      allTurnRows.push(...perTurnOutputRows);
      allCardRows.push(...cardRows);
    }
  } finally {
    if (serverHandle) serverHandle.child.kill();
  }

  const turnColumns = [
    'run_label', 'run_index', 'script', 'turn_index', 'user_message',
    'duration_ms', 'ttft_ms', 'output_tokens', 'thinking_tokens', 'text_tokens',
    'generated', 'validated_ok', 'surfaced', 'not_found_count', 'wrong_title_count',
    'pool_artist_hits', 'pool_track_hits', 'pool_size', 'seed_artist',
    'relaxation_stage', 'blank_turn_fallback_fired', 'novelty_tiers',
  ];
  const cardColumns = [
    'card_id', 'run_label', 'script', 'turn_index',
    'artist', 'track', 'connection_type', 'novelty_tier', 'reasoning_text',
  ];

  const turnPath = `${args.outDir}/turns-${args.label}-${args.script}.csv`;
  const cardPath = `${args.outDir}/cards-${args.label}-${args.script}.csv`;
  writeFileSync(turnPath, toCsv(allTurnRows, turnColumns));
  writeFileSync(cardPath, toCsv(allCardRows, cardColumns));
  console.log(`\nWrote ${allTurnRows.length} turn rows to ${turnPath}`);
  console.log(`Wrote ${allCardRows.length} card rows to ${cardPath}`);
}

main().catch((err) => {
  console.error('[replay] fatal:', err);
  process.exit(1);
});
