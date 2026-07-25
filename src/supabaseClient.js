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
async function insertEventWithRetry(client, row, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      const { error } = await client.from('events').insert(row);
      if (!error) return;
      console.error('Failed to log event:', row.event_type, error.message);
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
      // Fall through and try once more on a fresh connection.
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