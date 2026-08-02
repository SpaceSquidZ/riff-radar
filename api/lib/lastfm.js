// api/lib/lastfm.js
//
// Fetches a pool of REAL, catalogued artists related to whatever the user is
// currently orbiting, so Groove selects from confirmed-existing names instead
// of inventing them.
//
// ===========================================================================
// WHY THIS EXISTS
//
// On 2026-08-01 a live session produced:
//     generated=6  validated_ok=1  surfaced=1
//
// Five of six candidates failed iTunes validation. The failures were not
// formatting mismatches:
//     "Music for Airports 2/1" by Laraaji   <- real album, WRONG ARTIST (Eno)
//     "Water Copies Green" by Satoshi Ashikawa  <- fabricated title
//     "Andy Warhol's Dance Party" by Spoon      <- does not exist
//
// Validation was working correctly. GENERATION was the problem. The novelty
// objective (D-021) requires four of six candidates to be SCENE tier, which
// pushes the model into exactly the region where its training data is thinnest
// and it pattern-completes plausible titles rather than recalling real ones.
//
// Loosening the SCENE quota would reduce hallucination and simultaneously
// destroy the reason the product exists. So the fix comes from elsewhere:
// give the model a pool of artists that provably exist.
//
// WHAT THIS DOES NOT FIX
// A real artist with an invented track title still gets through. iTunes
// validation stays in the pipeline. Expect meaningful reduction, not zero.
//
// WHAT THIS MUST NOT BECOME
// Last.fm match scores are NOT used for ranking. Match score measures
// co-listening, and ranking by it would quietly turn this into the
// collaborative-filtering product D-009 explicitly decided not to build.
// Last.fm supplies a candidate pool. Groove supplies the judgment.
// ===========================================================================

import { supabaseAdmin } from '../../src/supabaseClient.js';

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

// Fetch 20 in one call rather than paginating. artist.getSimilar returns
// results already sorted by match score descending, so "top 10 then maybe 10
// more" would be two round-trips for the same data. 20 also leaves real
// headroom: roughly six need to survive iTunes validation to matter, and the
// spike showed even deep-cut artists (Ata Kak, 67k listeners) return a full 20.
const POOL_SIZE = 20;

// Everything here is an optimisation on the critical path of a reply. If
// Last.fm is slow, the pool is simply absent and Groove generates from memory
// exactly as he does today. Degradation, never breakage.
const FETCH_TIMEOUT_MS = 2500;
const CACHE_TIMEOUT_MS = 2000;

// ToS clause 4.3.4 asks for caching "in accordance with the HTTP headers sent
// with web service responses." Last.fm's headers are inconsistent, so this is
// the floor when no usable max-age comes back.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Artist-level listener counts, used to INFORM tier judgment rather than
// decide it. D-021 is explicit that tier is a property of the TRACK: a Bill
// Evans deep cut is SCENE even though Bill Evans is WIDE by listener count.
// So this is passed to Groove as context, and the final call stays with him.
const WIDE_THRESHOLD = 1_000_000;
const SCENE_THRESHOLD = 100_000;

function tierHint(listeners) {
  if (listeners == null) return null;
  if (listeners > WIDE_THRESHOLD) return 'wide';
  if (listeners < SCENE_THRESHOLD) return 'scene';
  return 'borderline';
}

function normalizeKey(name) {
  return (name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[lastfm] ${label} exceeded ${ms}ms, abandoning`);
      resolve(null);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- cache -----------------------------------------------------------------
//
// Mirrors the itunes_cache pattern. Requires a `lastfm_cache` table:
//
//   create table if not exists lastfm_cache (
//     cache_key   text primary key,
//     payload     jsonb not null,
//     created_at  timestamptz not null default now(),
//     expires_at  timestamptz not null
//   );
//   alter table lastfm_cache enable row level security;
//
// RLS on with no policies: service role only, same posture as events and
// itunes_cache. The browser never touches this.
//
// Note ToS clause 4.3.4 also caps total stored Last.fm data at 100 MB. Artist
// metadata is small and thousands of rows should stay far under it, but the
// expires_at column makes a periodic cleanup trivial if that ever changes.

async function cacheGet(key) {
  if (!supabaseAdmin) return null;
  try {
    const result = await withTimeout(
      supabaseAdmin
        .from('lastfm_cache')
        .select('payload, expires_at')
        .eq('cache_key', key)
        .maybeSingle(),
      CACHE_TIMEOUT_MS,
      'cache read'
    );
    if (!result) return null;

    const { data, error } = result;
    if (error || !data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.payload;
  } catch (err) {
    console.error('[lastfm] cache read threw:', err?.message || err);
    return null;
  }
}

function cacheSet(key, payload, ttlMs) {
  if (!supabaseAdmin) return;
  const row = {
    cache_key: key,
    payload,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
  try {
    // Bounded even though it is fire-and-forget: an unbounded floating promise
    // on a hung connection can keep the serverless container alive toward
    // maxDuration. Same failure the iTunes cache already guards against.
    withTimeout(
      supabaseAdmin.from('lastfm_cache').upsert(row, { onConflict: 'cache_key' }),
      CACHE_TIMEOUT_MS,
      'cache write'
    ).catch((err) => console.error('[lastfm] cache write threw:', err?.message || err));
  } catch (err) {
    console.error('[lastfm] cache write threw:', err?.message || err);
  }
}

// --- api -------------------------------------------------------------------

async function call(method, params) {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return null;

  const url = new URL(API_ROOT);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', key);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.warn(`[lastfm] ${method} returned ${res.status}`);
      return null;
    }
    // Respect the response's own cache directive where one is offered.
    const cc = res.headers.get('cache-control') || '';
    const maxAge = /max-age=(\d+)/.exec(cc);
    const ttlMs = maxAge ? parseInt(maxAge[1], 10) * 1000 : DEFAULT_TTL_MS;
    const json = await res.json();
    return { json, ttlMs };
  } catch (err) {
    console.error(`[lastfm] ${method} failed:`, err?.message || err);
    return null;
  }
}

/**
 * A pool of real artists related to `artistName`.
 *
 * NEVER throws. Returns null when unavailable for any reason (no key, no
 * network, unknown artist, timeout), and the caller carries on exactly as it
 * does today.
 *
 * @param {string} artistName - the artist currently being orbited
 * @returns {Promise<{seed: string, artists: Array}|null>}
 */
export async function getCandidatePool(artistName) {
  if (!artistName || !process.env.LASTFM_API_KEY) return null;

  const cacheKey = `pool:${normalizeKey(artistName)}`;

  const cached = await cacheGet(cacheKey);
  if (cached) {
    console.log(`[lastfm] HIT pool for "${artistName}" (${cached.artists?.length || 0})`);
    return cached;
  }

  const similarRes = await withTimeout(
    call('artist.getSimilar', { artist: artistName, limit: String(POOL_SIZE), autocorrect: '1' }),
    FETCH_TIMEOUT_MS,
    'getSimilar'
  );
  if (!similarRes?.json) return null;

  let raw = similarRes.json?.similarartists?.artist ?? [];
  if (!Array.isArray(raw)) raw = raw ? [raw] : [];
  if (raw.length === 0) {
    console.log(`[lastfm] no similar artists for "${artistName}"`);
    return null;
  }

  // Listener counts come from a second call per artist, which would be 20 more
  // round-trips. Not worth it on the critical path. Instead only enrich the top
  // handful, which is where tier accuracy matters most, and leave the rest as
  // names. Groove judges tier at track level anyway.
  const TOP_TO_ENRICH = 8;
  const names = raw.map((a) => a?.name).filter(Boolean);

  const enriched = await Promise.all(
    names.slice(0, TOP_TO_ENRICH).map(async (name) => {
      const infoRes = await withTimeout(
        call('artist.getInfo', { artist: name, autocorrect: '1' }),
        FETCH_TIMEOUT_MS,
        'getInfo'
      );
      const listeners = Number(infoRes?.json?.artist?.stats?.listeners);
      const value = Number.isFinite(listeners) ? listeners : null;
      return { name, listeners: value, tierHint: tierHint(value) };
    })
  );

  const rest = names.slice(TOP_TO_ENRICH).map((name) => ({
    name,
    listeners: null,
    tierHint: null,
  }));

  const pool = { seed: artistName, artists: [...enriched, ...rest] };

  cacheSet(cacheKey, pool, similarRes.ttlMs || DEFAULT_TTL_MS);
  console.log(`[lastfm] pool for "${artistName}": ${pool.artists.length} artists`);

  return pool;
}

/**
 * Which artist should seed the pool this turn.
 *
 * The pool has to follow the thread. If someone says "more like the second
 * one," they have stopped orbiting what they arrived with — and a pool still
 * seeded from the original artist stops covering what is actually being
 * discussed. Three turns down a rabbit hole the drift compounds and the
 * safety net is protecting the wrong thing.
 *
 * Most recently recommended artist wins, because that is what a follow-up
 * almost always refers to. Falls back to what they brought in.
 */
export function resolveSeedArtist(sourceTrack, previousRecommendations = []) {
  if (previousRecommendations.length > 0) {
    const last = previousRecommendations[previousRecommendations.length - 1];
    if (last?.artist) return last.artist;
  }
  return sourceTrack?.artist || null;
}