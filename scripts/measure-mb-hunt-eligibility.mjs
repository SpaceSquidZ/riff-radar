// scripts/measure-mb-hunt-eligibility.mjs
//
// §4d's measurement ask, same discipline as N-5: measure before changing
// selection behaviour. "Of current hunt-eligible candidates, how many does
// MusicBrainz confirm? High rate means cheap insurance. Low rate means we
// have been sending people after invented records at a rate worth
// knowing." This changes NOTHING about selection -- it is a read-only
// report against real historical 'not_found' candidates already logged to
// Supabase by the itunes_validation_failed event, replayed through the
// same verifyRecordingViaMusicBrainz check §4d wires into api/chat.js.
//
// Read-only against `events`, and unlike diagnose-events-jwt.mjs there is
// nothing to clean up afterward: every MusicBrainz answer this script gets
// back is written to lastfm_cache via the real verifyRecordingViaMusicBrainz
// path, which is a legitimate production cache entry (the exact answer a
// live turn would get and cache itself), not test pollution.
//
// Respects MusicBrainz's 1 req/sec courtesy limit itself, sequentially,
// with an explicit delay between calls -- verifyRecordingViaMusicBrainz
// makes no such guarantee on its own (a live turn only ever calls it once
// or twice per request by construction; this script is the one caller that
// can fan out across many distinct pairs, so the pacing has to live here).
//
// USAGE
//   set -a && source .env && set +a && node scripts/measure-mb-hunt-eligibility.mjs
//
// Flags:
//   --scan-limit   how many itunes_validation_failed rows to read from
//                  events, most recent first    (default 500)
//   --max-checks   cap on distinct track/artist pairs actually sent to
//                  MusicBrainz, so a large backlog doesn't turn into an
//                  hours-long run by surprise (default 100)
//   --delay-ms     delay between MusicBrainz requests (default 1100, i.e.
//                  just over the 1 req/sec courtesy limit)

import { loadRepoEnv } from './loadEnv.mjs';

// Same ordering requirement as replay.mjs: supabaseClient.js reads its env
// vars at module-evaluation time, and static imports are hoisted above
// everything else in the file -- so this has to run before any static
// import of it, meaning the imports that depend on it below have to be
// dynamic, done in main() after loadRepoEnv().
loadRepoEnv();

function parseArgs(argv) {
  const args = { scanLimit: 500, maxChecks: 100, delayMs: 1100 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scan-limit') args.scanLimit = Number(argv[++i]);
    else if (argv[i] === '--max-checks') args.maxChecks = Number(argv[++i]);
    else if (argv[i] === '--delay-ms') args.delayMs = Number(argv[++i]);
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeKey(name) {
  return (name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

async function main() {
  const { scanLimit, maxChecks, delayMs } = parseArgs(process.argv.slice(2));

  const { supabaseAdmin } = await import('../src/supabaseClient.js');
  const { verifyRecordingViaMusicBrainz } = await import('../api/lib/lastfm.js');

  if (!supabaseAdmin) {
    console.error(
      'supabaseAdmin is null -- VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.'
    );
    console.error('Run as: set -a && source .env && set +a && node scripts/measure-mb-hunt-eligibility.mjs');
    process.exit(1);
  }

  console.log(`Scanning up to ${scanLimit} itunes_validation_failed events for 'not_found' candidates...`);

  const { data: rows, error } = await supabaseAdmin
    .from('events')
    .select('payload, created_at')
    .eq('event_type', 'itunes_validation_failed')
    .order('created_at', { ascending: false })
    .limit(scanLimit);

  if (error) {
    console.error('Query failed:', error.message || error);
    process.exit(1);
  }

  // Dedupe by normalized track+artist: the same fabricated-sounding pair
  // can recur across sessions/turns, and re-sending it to MusicBrainz N
  // times would waste courtesy-limit budget to learn the same answer N
  // times over.
  const seen = new Map();
  for (const row of rows || []) {
    const failedTracks = row.payload?.failed_tracks;
    if (!Array.isArray(failedTracks)) continue;
    for (const t of failedTracks) {
      if (t?.reason !== 'not_found') continue;
      if (!t.track || !t.artist) continue;
      const key = `${normalizeKey(t.track)}::${normalizeKey(t.artist)}`;
      if (!seen.has(key)) seen.set(key, { track: t.track, artist: t.artist });
    }
  }

  const pairs = [...seen.values()];
  console.log(`Found ${pairs.length} distinct not_found (track, artist) pairs across ${rows?.length || 0} events.`);

  const toCheck = pairs.slice(0, maxChecks);
  if (pairs.length > toCheck.length) {
    console.log(
      `Capping at --max-checks=${maxChecks} (${pairs.length - toCheck.length} pairs left unchecked this run).`
    );
  }
  if (toCheck.length === 0) {
    console.log('Nothing to check. Done.');
    return;
  }

  const counts = { confirmed: 0, unverifiable: 0, unconfirmed: 0 };
  const confirmedPairs = [];

  for (let i = 0; i < toCheck.length; i++) {
    const { track, artist } = toCheck[i];
    const status = await verifyRecordingViaMusicBrainz(track, artist);
    counts[status] += 1;
    if (status === 'confirmed') confirmedPairs.push({ track, artist });
    console.log(`[${i + 1}/${toCheck.length}] "${track}" / "${artist}" -> ${status}`);
    if (i < toCheck.length - 1) await sleep(delayMs);
  }

  const answered = counts.confirmed + counts.unverifiable;
  const rate = answered > 0 ? ((counts.confirmed / answered) * 100).toFixed(1) : 'n/a';

  console.log('\n--- §4d MusicBrainz hunt-eligibility measurement ---');
  console.log(`checked:      ${toCheck.length}`);
  console.log(`confirmed:    ${counts.confirmed}`);
  console.log(`unverifiable: ${counts.unverifiable}`);
  console.log(`unconfirmed:  ${counts.unconfirmed}  (network/timeout -- excluded from the rate below)`);
  console.log(`confirmation rate (confirmed / (confirmed + unverifiable)): ${rate}%`);
  if (confirmedPairs.length > 0) {
    console.log('\nConfirmed pairs:');
    for (const p of confirmedPairs) console.log(`  "${p.track}" / "${p.artist}"`);
  }
}

main().catch((err) => {
  console.error('Unexpected script error:', err);
  process.exit(1);
});
