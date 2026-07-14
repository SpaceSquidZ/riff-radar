// src/supabaseClient.js

import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
  (typeof process !== 'undefined' && process.env?.VITE_SUPABASE_URL);

// PUBLIC key — safe for the browser. Used by the website.
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

// Logs an event. Pass useAdmin = true from the server so it uses the
// secret key (which still works after we lock the database).
export async function logEvent(sessionId, eventType, payload = {}, useAdmin = false) {
  const client = useAdmin && supabaseAdmin ? supabaseAdmin : supabase;
  try {
    const { error } = await client
      .from('events')
      .insert({ session_id: sessionId, event_type: eventType, payload });

    if (error) {
      console.error('Failed to log event:', eventType, error);
    }
  } catch (err) {
    console.error('Error logging event:', eventType, err);
  }
}