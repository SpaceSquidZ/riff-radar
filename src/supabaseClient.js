// src/supabaseClient.js
//
// Single shared Supabase client instance, plus a logEvent helper that
// writes to the events table. Used from both frontend components
// (session_start, outbound_click) and api/chat.js (message_sent,
// rec_generated) — see each call site for which events it logs.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || import.meta.env?.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Logs an event to the events table. Never throws — a logging failure
 * should never break the user's actual experience, so errors are
 * caught and logged to the console instead of propagating.
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