// src/supabaseClient.js

import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
  (typeof process !== 'undefined' && process.env?.VITE_SUPABASE_URL);

// PUBLIC key — safe for the browser.
const supabaseAnonKey =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY) ||
  (typeof process !== 'undefined' && process.env?.VITE_SUPABASE_ANON_KEY);

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// SECRET key — server only, never reaches the browser.
// Note: NO "VITE_" prefix on purpose. That prefix is what makes Vite
// leak a variable into the website, and this one must never leak.
const supabaseServiceKey =
  typeof process !== 'undefined' ? process.env?.SUPABASE_SERVICE_ROLE_KEY : undefined;

export const supabaseAdmin = supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// True when this module is running in a browser rather than in a Vercel function.
const isBrowser = typeof window !== 'undefined';

/**
 * Inserts one event row, retrying once on a TRANSPORT failure.
 *
 * WHY THE RETRY EXISTS
 * Production logs showed events being lost with:
 *   TypeError: fetch failed
 *   Caused by: SocketError: other side closed (UND_ERR_SOCKET)
 *
 * That is not latency and not a bad query. A warm serverless container holds an
 * idle keep-alive connection; Supabase closes it from its side; the next write
 * wakes up into a dead socket and fails instantly. Matching the function region
 * to the database region narrows the window but does not close it, because the
 * cause is connection age, not distance.
 *
 * A single retry gets a fresh connection and succeeds. Losing message_sent and
 * rec_generated rows silently is worse than a duplicate attempt, because the
 * funnel is the artifact and dropped rows cannot be reconstructed later.
 *
 * A PostgREST error object (bad column, RLS rejection) is NOT retried, since
 * retrying a rejected query just fails again.
 */
// --- transient rejections ---------------------------------------------------
//
// PGRST303 "JWT issued at future" is NOT a rejection of our credentials.
// PostgREST validates the token's `iat` claim against its own clock, allowing
// 30 seconds of skew. A caching defect in how PostgREST reads that clock across
// threads can make a correctly-issued token momentarily look future-dated.
//
// Diagnosed 2026-08-29: both project keys carry iat 2026-06-27 — 62 days in the
// past — so nothing about the token is wrong, and a wrong-project URL is ruled
// out too (that fails signature verification, and time claims are only checked
// AFTER the signature passes). Confirmed upstream: the same error, on the
// service_role key, across multiple Supabase regions and plans in the same week
// as our 2026-08-21 occurrences. Their mitigation was a PostgREST rollback.
// There is no application-side cause and no application-side cure.
//
// Matching on `code` rather than `message`: PostgREST error codes are stable
// contract; message strings are not.
const TRANSIENT_ERROR_CODES = new Set(['PGRST303']);

// Secondary net, in case a response shape arrives without a code.
const TRANSIENT_MESSAGE = /issued at future|jwt.*not yet valid|clock skew/i;

function isTransientRejection(error) {
  if (!error) return false;
  if (error.code && TRANSIENT_ERROR_CODES.has(error.code)) return true;
  return TRANSIENT_MESSAGE.test(error.message || '');
}

// Spacing, not just repetition. An immediate retry is likely to reuse the same
// connection and therefore the same bad clock; the defect is per-thread, so a
// spaced retry has a real chance of landing somewhere the clock reads correctly.
//
// Honest limit: a skew larger than PostgREST's own 30s tolerance will outlast
// any backoff worth putting on this path. This is mitigation, not a cure — what
// makes the residual failures survivable is the full-detail logging below.
// Every call site is fire-and-forget (logEventSafe never awaits), so the delay
// costs the user nothing.
const RETRY_BACKOFF_MS = [400, 1200];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// BUG THIS FIXES: this function used to log only `error.message`, discarding
// `code`, `details`, `hint` and the HTTP status. That one omission is why
// "JWT issued at future" read as an unexplained mystery for eight days —
// `code` would have said PGRST303 immediately, turning a multi-hour trace into
// a single search. Note the fields are read individually rather than spread:
// Error defines `message` as non-enumerable, so {...error} silently loses it.
function describeError(error, status) {
  if (!error) return {};
  return {
    code: error.code ?? null,
    message: error.message ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
    status: status ?? error.status ?? null,
  };
}

async function insertEventWithRetry(client, row, attempts = MAX_ATTEMPTS) {
  for (let i = 0; i < attempts; i++) {
    const backoff = RETRY_BACKOFF_MS[i] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
    try {
      const { error, status } = await client.from('events').insert(row);
      if (!error) return;

      // Transient upstream fault: worth another attempt, unlike a schema or RLS
      // rejection, which will fail identically forever.
      if (isTransientRejection(error) && i < attempts - 1) {
        console.warn(
          '[events] transient rejection, retrying:',
          row.event_type,
          JSON.stringify({ attempt: i + 1, ...describeError(error, status) })
        );
        await sleep(backoff);
        continue;
      }

      console.error(
        'Failed to log event:',
        row.event_type,
        JSON.stringify(describeError(error, status))
      );
      return; // real rejection, not transport. Do not retry.
    } catch (err) {
      if (i === attempts - 1) {
        console.error(
          'Failed to log event after retry:',
          row.event_type,
          err?.message || err
        );
        return;
      }
      // Fall through and try again on a fresh connection.
      await sleep(backoff);
    }
  }
}

/**
 * Logs an event.
 *
 * D-008: the browser no longer writes to Supabase directly. It POSTs to
 * /api/events, which writes server-side using the service role key. The anon
 * key is publicly visible in the bundle, so allowing browser writes meant
 * anyone could inject fake rows into the table the whole funnel depends on.
 *
 * Server callers (api/chat.js) pass useAdmin = true and still write directly,
 * which is already safe because the service key never leaves the server.
 *
 * Never throws. An analytics failure must not break the UI.
 *
 * @param {string} sessionId
 * @param {string} eventType
 * @param {object} payload
 * @param {boolean} useAdmin - true from server code, false/omitted from the browser
 */
export async function logEvent(sessionId, eventType, payload = {}, useAdmin = false) {
  // --- Server path: direct write with the service key, with one retry ---
  if (useAdmin && supabaseAdmin) {
    await insertEventWithRetry(supabaseAdmin, {
      session_id: sessionId,
      event_type: eventType,
      payload,
    });
    return;
  }

  // --- Browser path: POST to our own endpoint, never to Supabase ---
  if (isBrowser) {
    const body = JSON.stringify({
      session_id: sessionId,
      event_type: eventType,
      payload,
    });

    try {
      // outbound_click fires immediately before the browser navigates away.
      // A normal fetch can be cancelled mid-flight when that happens;
      // sendBeacon is designed to survive it.
      const isExitEvent = eventType === 'outbound_click' || eventType === 'crate_link_clicked';

      if (isExitEvent && navigator.sendBeacon) {
        navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
        return;
      }

      await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      });
    } catch (err) {
      // Swallow. Analytics must never break a user's session.
      console.error('Error logging event:', eventType, err);
    }
    return;
  }

  // --- Server code that forgot useAdmin: fall back rather than silently drop ---
  if (supabaseAdmin) {
    await insertEventWithRetry(supabaseAdmin, {
      session_id: sessionId,
      event_type: eventType,
      payload,
    });
  }
}