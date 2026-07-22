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
  // --- Server path: unchanged, writes directly with the service key ---
  if (useAdmin && supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin
        .from('events')
        .insert({ session_id: sessionId, event_type: eventType, payload });
      if (error) console.error('Failed to log event:', eventType, error);
    } catch (err) {
      console.error('Error logging event:', eventType, err);
    }
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
    try {
      const { error } = await supabaseAdmin
        .from('events')
        .insert({ session_id: sessionId, event_type: eventType, payload });
      if (error) console.error('Failed to log event:', eventType, error);
    } catch (err) {
      console.error('Error logging event:', eventType, err);
    }
  }
}