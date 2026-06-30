// src/supabaseClient.js
//
// Single shared Supabase client instance, plus a logEvent helper that
// writes to the events table. Used from both frontend components
// (session_start, outbound_click) and api/chat.js (message_sent,
// rec_generated) — see each call site for which events it logs.

import { createClient } from '@supabase/supabase-js';

// Vite exposes browser-safe env vars via import.meta.env. Node (used by
// api/chat.js on the server) does not have import.meta.env, so we check
// for it first and only touch process.env in a way that's safe even when
// `process` itself doesn't exist (true in the browser).
const supabaseUrl =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
  (typeof process !== 'undefined' && process.env?.VITE_SUPABASE_URL);

const supabaseKey =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY) ||
  (typeof process !== 'undefined' && process.env?.VITE_SUPABASE_ANON_KEY);

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Logs an event to the events table. Never throws — a logging failure
 * should never break the user's actual experience, so errors are
 * caught and logged to the console instead of propagating.
 *
 * @param {string} sessionId - from getSessionId() on the frontend, or
 *   passed through from the request body on the backend.
 * @param {string} eventType - 'session_start' | 'message_sent' |
 *   'rec_generated' | 'outbound_click'
 * @param {object} payload - event-specific details, see the table's
 *   SQL comments for the expected shape per event type.
 */
export async function logEvent(sessionId, eventType, payload = {}) {
  try {
    const { error } = await supabase
      .from('events')
      .insert({ session_id: sessionId, event_type: eventType, payload });

    if (error) {
      console.error('Failed to log event:', eventType, error);
    }
  } catch (err) {
    console.error('Error logging event:', eventType, err);
  }
}