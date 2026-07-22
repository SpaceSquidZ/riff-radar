// api/events.js
//
// Server-side event ingestion. The only path by which browser events reach Supabase.
//
// Why this exists (D-008): events were being written from the browser using the
// Supabase anon key, which ships to every visitor. Anyone could POST arbitrary
// rows into the table the entire portfolio funnel depends on.
//
// Note: api/chat.js already writes server-side via logEvent(..., useAdmin=true)
// and is unaffected by this. This endpoint exists for the BROWSER's events.

import { supabaseAdmin } from '../src/supabaseClient.js';

// Every event type the app is allowed to write.
// Unknown types are rejected rather than stored, so typos surface in dev
// instead of six weeks later in a broken funnel query.
const ALLOWED_EVENTS = new Set([
  // --- currently in use ---
  'session_start',
  'form_field_completed',
  'moment_submitted',
  'message_sent',
  'preview_played',
  'outbound_click',
  'rec_generated',
  'itunes_validation_failed',

  // --- arriving with the v4 rebuild (PRD v4.0 §8) ---
  'opener_pair_shown',
  'opener_track_engaged',
  'first_message_sent',
  'input_track_identified',
  'input_track_corrected',
  'groove_question_asked',
  'groove_question_answered',
  'rec_candidates_generated',
  'rec_validated',
  'rec_shown',
  'rec_novelty_reported',
  'rec_marked',
  'refinement_chip_clicked',
  'crate_viewed',
  'crate_link_clicked',
  'lore_beat_delivered',
  'log_viewed',
  'return_visit',
]);

const MAX_PAYLOAD_BYTES = 8000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  let body = req.body;
  // sendBeacon sends a Blob; Vercel may hand it over unparsed.
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'malformed json' });
    }
  }

  const { session_id, event_type, payload = {} } = body || {};

  if (typeof event_type !== 'string' || !ALLOWED_EVENTS.has(event_type)) {
    console.warn('[events] rejected unknown event_type:', event_type);
    return res.status(400).json({ error: 'invalid event_type' });
  }
  if (typeof session_id !== 'string' || session_id.length < 4) {
    return res.status(400).json({ error: 'invalid session_id' });
  }
  if (typeof payload !== 'object' || payload === null) {
    return res.status(400).json({ error: 'payload must be an object' });
  }
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
    return res.status(400).json({ error: 'payload too large' });
  }

  if (!supabaseAdmin) {
    console.error('[events] supabaseAdmin is null — SUPABASE_SERVICE_ROLE_KEY missing');
    return res.status(202).json({ ok: false });
  }

  try {
    const { error } = await supabaseAdmin
      .from('events')
      .insert({ session_id, event_type, payload });

    if (error) {
      console.error('[events] insert failed:', event_type, error.message);
      // Still 202. Analytics failure is not the user's problem, and the client
      // should not retry into a loop against a broken table.
      return res.status(202).json({ ok: false });
    }
    return res.status(202).json({ ok: true });
  } catch (err) {
    console.error('[events] unexpected:', err?.message || err);
    return res.status(202).json({ ok: false });
  }
}