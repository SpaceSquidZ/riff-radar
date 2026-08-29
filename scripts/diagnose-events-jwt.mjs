// scripts/diagnose-events-jwt.mjs
//
// Standalone diagnostic for the "JWT issued at future" (PGRST303) failures
// seen in Vercel logs around 2026-08-21, e.g.:
//   [error] Failed to log event: message_sent JWT issued at future
//
// Uses the EXACT same client + credential as api/chat.js's server-side path
// (supabaseAdmin, built from VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY —
// see src/supabaseClient.js), so a failure here reproduces the real failure
// mode rather than a different one.
//
// Unlike insertEventWithRetry in src/supabaseClient.js, this logs the FULL
// error object on failure — code, details, hint, and the HTTP status/
// statusText from the response — not just error.message. PGRST303 is an
// infra-level clock-skew error between GoTrue and PostgREST (see
// https://github.com/orgs/supabase/discussions/48123), not something the app
// can fix, but the code/status distinguish it from a credential or RLS
// problem if this ever needs re-diagnosing.
//
// Cleans up every row it inserts (by session_id prefix, scoped to this run),
// whether attempts succeed or fail.
//
// USAGE
//   VITE_SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//     node scripts/diagnose-events-jwt.mjs [count] [delayMs]
//
//   count   - number of insert attempts (default 20)
//   delayMs - delay between attempts, in ms (default 500)
//
// Both env vars already exist in .env for local dev — you can also run:
//   set -a && source .env && set +a && node scripts/diagnose-events-jwt.mjs

import { createClient } from '@supabase/supabase-js';

const COUNT = Number(process.argv[2]) || 20;
const DELAY_MS = Number(process.argv[3]) || 500;

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.');
  console.error('Run as:');
  console.error('  VITE_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/diagnose-events-jwt.mjs');
  process.exit(1);
}

const admin = createClient(url, key);

// Not one of ALLOWED_EVENTS in api/events.js on purpose — this script talks
// directly to Supabase, bypassing that endpoint entirely, so the allowlist
// does not apply. The distinct type and session_id prefix just make these
// rows unmistakable and easy to clean up.
const runId = `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attempt(i) {
  const row = {
    session_id: `${runId}-${i}`,
    event_type: 'diagnostic_probe',
    payload: { run_id: runId, attempt: i, sent_at: new Date().toISOString() },
  };

  const startedAt = Date.now();
  const { error, status, statusText } = await admin.from('events').insert(row);
  const elapsedMs = Date.now() - startedAt;

  if (error) {
    console.error(`[attempt ${i}] FAILED after ${elapsedMs}ms -- HTTP ${status} ${statusText}`);
    console.error(
      JSON.stringify(
        {
          name: error.name,
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
        },
        null,
        2
      )
    );
    return false;
  }

  console.log(`[attempt ${i}] ok (${elapsedMs}ms, HTTP ${status})`);
  return true;
}

async function main() {
  console.log(`Running ${COUNT} insert attempts against 'events', ${DELAY_MS}ms apart.`);
  console.log(`run_id=${runId}\n`);

  let failures = 0;
  for (let i = 0; i < COUNT; i++) {
    const ok = await attempt(i);
    if (!ok) failures += 1;
    if (i < COUNT - 1) await sleep(DELAY_MS);
  }

  console.log(`\nDone. ${failures}/${COUNT} attempts failed (${((failures / COUNT) * 100).toFixed(1)}%).`);

  console.log(`\nCleaning up rows for run_id=${runId}...`);
  const { error: cleanupError } = await admin.from('events').delete().like('session_id', `${runId}%`);
  if (cleanupError) {
    console.error('Cleanup failed -- delete these rows manually, e.g.:');
    console.error(`  delete from events where session_id like '${runId}%';`);
    console.error(JSON.stringify(cleanupError, null, 2));
  } else {
    console.log('Cleanup done.');
  }
}

main().catch((err) => {
  console.error('Unexpected script error:', err);
  process.exit(1);
});
