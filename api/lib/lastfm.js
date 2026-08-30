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
// WHAT THIS DID NOT FIX (Brief B, Change 2, D-032)
// A manual audit on 2026-08-30 disproved half of the prediction above.
// Later sessions reached pool=6/6 -- every candidate drawn from this
// pool -- and STILL returned validated_ok=0. 119 distinct not_found tracks
// across test sessions, ~20 checked by hand against full-catalogue iTunes
// artistTerm searches (Danny Brown: 195 tracks; Earl Sweatshirt: 89). None of
// the recommended tracks existed. This pool constrained WHO Groove named.
// Nothing constrained WHAT TRACK he attached to them, so he invented one
// anyway -- exactly the failure mode this file's own comment above already
// predicted in as many words.
//
// So getCandidatePool now also fetches each artist's real top tracks
// (fetchTopTracksFor, artist.getTopTracks) and hands Groove artist+track
// PAIRS that provably exist, not just artist names. See groovePrompt.js,
// "Artists in range tonight", for how this is framed to him -- same
// principle as before, extended one level deeper: this constrains the
// candidate SET further, Groove still supplies the judgment.
//
// WHAT THIS STILL DOES NOT FIX
// "Top tracks" means most-played. A real artist's invented CONNECTION or
// misjudged TIER still gets through -- this only guarantees the pair is
// real, not that picking it or explaining it was good judgment. And for a
// WIDE-tier artist specifically, most-played means the hit, which the
// novelty objective (D-021) exists to avoid surfacing -- see the WIDE
// handling in groovePrompt.js, which deliberately gives WIDE artists no
// track list here at all and leaves Groove reaching for a deep cut from his
// own knowledge instead, same as before this existed.
//
// WHAT THIS MUST NOT BECOME
// Last.fm match scores AND play counts are NOT used for ranking or for
// picking which track to recommend. Both measure popularity, and using
// either would quietly turn this into the collaborative-filtering product
// D-009 explicitly decided not to build. Last.fm supplies a candidate set
// of real artist+track pairs. Groove supplies the judgment: which pair,
// what connection, whether it is even the right call to reach outside the
// set entirely.
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

// Brief B, Change 2. A handful is plenty: this is a "does this pair exist"
// check for Groove, not a chart. Deliberately longer-lived than the
// similar-artist pool above (which can legitimately shift as Last.fm's own
// algorithm or tagging drifts) -- an artist's back catalogue does not
// reissue itself weekly, so measured Last.fm cache-control headers are
// ignored here in favor of a fixed, longer TTL. Cheapest shape that works
// per the brief: a real, ~100-300ms parallel fetch across a full 20-artist
// pool (measured, not estimated) landing almost entirely on a 30-day cache
// after the first time any given artist appears in ANY pool, since the
// cache key is per-artist, not per-seed.
const TOP_TRACKS_PER_ARTIST = 5;
const TOP_TRACKS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
 * A handful of `artistName`'s real tracks, cheapest-titles-first (Last.fm's
 * own "top tracks" ordering, i.e. most-played — see the WIDE-tier caveat in
 * this file's header before using this for a widely known artist).
 *
 * NEVER throws, same contract as getCandidatePool: any failure (no key, no
 * network, unknown artist, timeout) returns an empty array, and the caller
 * (getCandidatePool below) treats that identically to "no data" — the
 * artist just carries no track list, exactly as if this function did not
 * exist.
 *
 * @param {string} artistName
 * @returns {Promise<string[]>}
 */
async function fetchTopTracksFor(artistName) {
  const cacheKey = `toptracks:${normalizeKey(artistName)}`;

  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const res = await withTimeout(
    call('artist.getTopTracks', {
      artist: artistName,
      autocorrect: '1',
      limit: String(TOP_TRACKS_PER_ARTIST),
    }),
    FETCH_TIMEOUT_MS,
    'getTopTracks'
  );

  let raw = res?.json?.toptracks?.track ?? [];
  if (!Array.isArray(raw)) raw = raw ? [raw] : [];
  const tracks = raw.map((t) => t?.name).filter(Boolean);

  // Cache even an empty result (an artist Last.fm has no top-tracks data
  // for is not going to gain any before the TTL is up), so a thin artist
  // does not re-attempt this same failed lookup on every pool it appears in.
  cacheSet(cacheKey, tracks, TOP_TRACKS_TTL_MS);
  return tracks;
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

  // Brief B, Change 2. Top tracks are fetched for ALL 20, not just the
  // enriched 8 — measured cost is ~100-300ms for a full 20-artist parallel
  // fetch (see the brief's Q3), so there is no latency reason to skip the
  // unenriched 12. WIDE-tier exclusion (rule: don't hand out a "top tracks"
  // list for a widely known artist, since most-played there means the hit —
  // see D-021) happens in groovePrompt.js at render time instead of here,
  // because tierHint is only known for the enriched 8 at fetch time anyway,
  // and keeping "what to fetch" and "what to show" separate is simpler than
  // threading that decision through two different code paths.
  const enriched = await Promise.all(
    names.slice(0, TOP_TO_ENRICH).map(async (name) => {
      const [infoRes, topTracks] = await Promise.all([
        withTimeout(call('artist.getInfo', { artist: name, autocorrect: '1' }), FETCH_TIMEOUT_MS, 'getInfo'),
        fetchTopTracksFor(name),
      ]);
      const listeners = Number(infoRes?.json?.artist?.stats?.listeners);
      const value = Number.isFinite(listeners) ? listeners : null;
      return { name, listeners: value, tierHint: tierHint(value), topTracks };
    })
  );

  const rest = await Promise.all(
    names.slice(TOP_TO_ENRICH).map(async (name) => ({
      name,
      listeners: null,
      tierHint: null,
      topTracks: await fetchTopTracksFor(name),
    }))
  );

  const pool = { seed: artistName, artists: [...enriched, ...rest] };

  cacheSet(cacheKey, pool, similarRes.ttlMs || DEFAULT_TTL_MS);
  console.log(`[lastfm] pool for "${artistName}": ${pool.artists.length} artists`);

  return pool;
}

/**
 * Which artist should seed the pool this turn.
 *
 * Brief B, Change 1. BUG THIS REPLACES: the previous version had TWO inputs
 * competing for priority — sourceTrack.artist (only updates when a full
 * TRACK is confirmed) and previousRecommendations[last] (Groove's own last
 * pick). Neither represents what the user is CURRENTLY oriented on. Once any
 * track was confirmed, sourceTrack.artist won unconditionally and froze
 * there for the rest of the session — a bare artist-only mention ("what
 * about Grouper?") never touches sourceTrack at all, so the pool stayed
 * stuck on the artist from three turns ago while the user had moved on.
 * Confirmed live (Test 2): pool seed stayed "Tim Hecker" two turns after the
 * user pivoted to Grouper by name.
 *
 * orbitArtist is a single, unified signal instead: whichever of an artist
 * name or a full track the user named MOST RECENTLY, whether or not a
 * recommendation was ever asked for. It is computed in api/chat.js from the
 * SAME requestedArtists/inputTrack fields Brief A already added to the
 * metadata contract (see the handler, "next turn's orbit" comment) — no new
 * model output was added for this. The pool is fetched before the current
 * message is parsed, so this still carries the documented one-turn lag: it
 * reflects what was named as of the END of the previous turn, not this
 * turn's own text. That lag is expected and acceptable; the bug was
 * permanent stickiness past it, not the lag itself.
 *
 * previousRecommendations is the fallback ONLY for a turn where nothing has
 * ever been named at all (e.g. session opens on "surprise me").
 */
export function resolveSeedArtist(orbitArtist, previousRecommendations = []) {
  if (orbitArtist) return orbitArtist;
  if (previousRecommendations.length > 0) {
    const last = previousRecommendations[previousRecommendations.length - 1];
    if (last?.artist) return last.artist;
  }
  return null;
}