// api/lib/itunesCache.js
//
// Supabase-backed cache for iTunes Search API results.
//
// WHY THIS EXISTS
// The in-memory Map in validateTracks.js only survives inside a single warm
// Vercel container. Cold starts wipe it, and concurrent invocations each get
// their own copy, so real-world hit rates are far lower than the comment there
// implies. This gives every invocation a shared, persistent cache.
//
// It matters most for D-023 (six candidates instead of three), which doubles
// the call volume against an undocumented, unofficially rate-limited API.
// Groove recommends the same tier-2 artists repeatedly across users, so hit
// rates should climb quickly.
//
// TTL is enforced on READ rather than by a cron job: fetch the row, compare
// created_at to now, treat anything past its limit as a miss.
//   - hits  (found): 30 days. A confirmed track is stable.
//   - misses (not found): 7 days. Catalogs add tracks; don't cache absence long.
//
// Nothing here ever throws. A cache failure must degrade to a live lookup,
// never break a reply.

import { supabaseAdmin } from '../../src/supabaseClient.js';
import { waitUntil } from '@vercel/functions';

const TTL_HIT_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_MISS_MS = 7 * 24 * 60 * 60 * 1000;

// HARD BUDGET on every Supabase round-trip from this module.
//
// This module sits directly on the critical path of a reply. Supabase calls
// from Vercel have been observed hanging on ECONNRESET / ETIMEDOUT rather than
// failing fast, and a hung read here stalls recommendation validation until
// the whole function hits its 60s maxDuration ceiling. That turns a harmless
// cache miss into a total request failure.
//
// The cache is an OPTIMIZATION. It must never be load-bearing. If Supabase
// does not answer within the budget, we abandon the cache and do the live
// iTunes lookup, which is the exact behavior we had before caching existed.
const CACHE_TIMEOUT_MS = 2000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[itunes_cache] ${label} exceeded ${ms}ms, abandoning`);
      resolve(null);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isFresh(row) {
  if (!row?.created_at) return false;
  const age = Date.now() - new Date(row.created_at).getTime();
  return age < (row.found ? TTL_HIT_MS : TTL_MISS_MS);
}

/**
 * Builds a stable cache key.
 *
 * The store list is part of the key on purpose: the same track searched in
 * different storefronts can produce different results, so a US-only lookup and
 * a US+TW+HK lookup are genuinely different queries and must not share a row.
 *
 * @param {'rec'|'src'} kind - 'rec' for validateOneTrack, 'src' for lookupTrackFacts.
 *   The prefix is what lets both result shapes share one table without a
 *   `kind` column, since the `confidence` field carries a different vocabulary
 *   for each.
 */
export function buildCacheKey(kind, track, artist, stores) {
  const t = (track || '').toLowerCase().trim();
  const a = (artist || '').toLowerCase().trim();
  const s = [...stores].sort().join(',');
  return `${kind}:${t}::${a}::${s}`;
}

/**
 * Reads one key. Returns the raw row if present and fresh, else null.
 */
export async function cacheGet(key) {
  if (!supabaseAdmin) return null;
  try {
    const result = await withTimeout(
      supabaseAdmin.from('itunes_cache').select('*').eq('cache_key', key).maybeSingle(),
      CACHE_TIMEOUT_MS,
      'read'
    );

    // null means the timeout won the race. Treat as a miss.
    if (!result) return null;

    const { data, error } = result;
    if (error) {
      console.error('[itunes_cache] read failed:', error.message);
      return null;
    }
    return isFresh(data) ? data : null;
  } catch (err) {
    console.error('[itunes_cache] read threw:', err?.message || err);
    return null;
  }
}

/**
 * Reads many keys in ONE query. Returns a Map of key -> row for fresh hits.
 *
 * Use this when validating a batch of candidates so you trade N iTunes
 * round-trips for one Supabase round-trip, rather than for N Supabase
 * round-trips.
 */
export async function cacheGetMany(keys) {
  const out = new Map();
  if (!supabaseAdmin || keys.length === 0) return out;
  try {
    const result = await withTimeout(
      supabaseAdmin.from('itunes_cache').select('*').in('cache_key', keys),
      CACHE_TIMEOUT_MS,
      'batch read'
    );

    if (!result) return out;

    const { data, error } = result;
    if (error) {
      console.error('[itunes_cache] batch read failed:', error.message);
      return out;
    }
    for (const row of data || []) {
      if (isFresh(row)) out.set(row.cache_key, row);
    }
    return out;
  } catch (err) {
    console.error('[itunes_cache] batch read threw:', err?.message || err);
    return out;
  }
}

/**
 * BUG THIS FIXES (Brief D, Part 5): cacheSet used to fire its own
 * fire-and-forget upsert immediately, once per track. On Vercel, a
 * serverless instance can be frozen shortly after the response ends —
 * BEFORE an unawaited promise gets a turn on the event loop to actually
 * send its request. Six candidates meant up to six separate writes racing
 * the freeze independently; losing some was not a corner case, it was the
 * expected outcome most turns. Confirmed live (Brief C Q4): the console
 * warning this produced ("cache write may be lost — container suspended
 * before ... 2000ms timer fired on next thaw") was showing up on ordinary
 * turns, not edge cases.
 *
 * The fix is two changes, not one:
 *   1. Batch a whole turn's writes into ONE upsert (queueCacheWrite +
 *      flushCacheWrites) instead of six-plus separate round trips — six
 *      round trips awaited would cost up to ~2s of real latency per turn,
 *      which is not an acceptable trade for correctness.
 *   2. Actually keep the instance alive for that one write, via
 *      waitUntil() from @vercel/functions where a live Vercel request
 *      context exists, or by awaiting the single batched write directly
 *      where it doesn't (local dev, tests) — one round trip is worth
 *      paying for where six were not.
 *
 * waitUntil() itself does NOT throw or signal failure when no live Vercel
 * context is available — @vercel/functions' own implementation reads
 * `getContext().waitUntil?.(promise)` with optional chaining, so it just
 * silently does nothing. A try/catch around waitUntil() cannot detect that,
 * so hasWaitUntilContext() checks the same global context symbol directly,
 * BEFORE deciding whether to also await the write.
 */
function hasWaitUntilContext() {
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
    return typeof ctx?.waitUntil === 'function';
  } catch {
    return false;
  }
}

function fieldsToRow(key, fields) {
  return {
    cache_key: key,
    found: !!fields.found,
    confidence: fields.confidence ?? null,
    storefront: fields.storefront ?? null,
    track_name: fields.trackName ?? null,
    artist_name: fields.artistName ?? null,
    album_name: fields.albumName ?? null,
    genre: fields.genre ?? null,
    // Column is int; upstream code produces a 4-char string.
    release_year: fields.releaseYear ? parseInt(fields.releaseYear, 10) || null : null,
    preview_url: fields.previewUrl ?? null,
    artwork_url: fields.artworkUrl ?? null,
    track_view_url: fields.trackViewUrl ?? null,
    created_at: new Date().toISOString(),
  };
}

/**
 * Queues one row for the batch upsert. Pure and synchronous — no I/O, so
 * this cannot itself be lost to a container freeze. `batch` is caller-owned
 * (one per request/turn — see api/chat.js), never a module-level array:
 * Vercel can serve concurrent requests from one warm instance, and a
 * shared global queue would risk one user's turn writing another's rows,
 * or a slow request picking up a fast one's already-flushed batch.
 */
export function queueCacheWrite(batch, key, fields) {
  if (!supabaseAdmin || !batch) return;
  batch.push(fieldsToRow(key, fields));
}

/**
 * Flushes one turn's queued rows in a SINGLE upsert. Resolves immediately
 * (without waiting on the write) when waitUntil() has a live context to
 * attach to; otherwise returns the write promise itself for the caller to
 * await, per the fallback plan above. Callers should `await` this either
 * way — in the waitUntil branch it is already resolved, so awaiting it
 * costs nothing.
 */
export function flushCacheWrites(batch) {
  if (!supabaseAdmin || !batch || batch.length === 0) return Promise.resolve();

  const writePromise = withTimeout(
    supabaseAdmin.from('itunes_cache').upsert(batch, { onConflict: 'cache_key' }),
    CACHE_TIMEOUT_MS,
    'batch write'
  )
    .then((result) => {
      if (result?.error) console.error('[itunes_cache] batch write failed:', result.error.message);
    })
    .catch((err) => {
      console.error('[itunes_cache] batch write threw:', err?.message || err);
    });

  if (hasWaitUntilContext()) {
    waitUntil(writePromise);
    return Promise.resolve();
  }
  return writePromise;
}

// --- shape converters -------------------------------------------------------
// The table stores flat columns. These translate to and from the two result
// shapes the callers actually use.

/** Cached row -> validateOneTrack's { status, enriched } */
export function rowToValidation(row) {
  if (row.confidence === 'not_found') {
    return { status: 'not_found', enriched: null };
  }
  return {
    status: row.confidence, // 'found' | 'found_no_preview'
    enriched: {
      previewUrl: row.preview_url,
      artworkUrl: row.artwork_url,
      trackViewUrl: row.track_view_url,
      releaseYear: row.release_year ? String(row.release_year) : null,
    },
  };
}

/** Cached row -> lookupTrackFacts' facts object */
export function rowToFacts(row) {
  if (!row.found) {
    return row.confidence === 'artist_only'
      ? { found: false, confidence: 'artist_only', artistName: row.artist_name }
      : { found: false, confidence: 'not_found' };
  }
  return {
    found: true,
    confidence: 'confirmed',
    trackName: row.track_name,
    artistName: row.artist_name,
    genre: row.genre,
    releaseYear: row.release_year ? String(row.release_year) : null,
    albumName: row.album_name,
    storefront: row.storefront,
  };
}