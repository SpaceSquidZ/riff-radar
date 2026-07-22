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

const TTL_HIT_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_MISS_MS = 7 * 24 * 60 * 60 * 1000;

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
    const { data, error } = await supabaseAdmin
      .from('itunes_cache')
      .select('*')
      .eq('cache_key', key)
      .maybeSingle();

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
    const { data, error } = await supabaseAdmin
      .from('itunes_cache')
      .select('*')
      .in('cache_key', keys);

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
 * Writes one row. Fire-and-forget: never awaited on the critical path, never
 * throws. Upsert so concurrent invocations racing on the same key are fine.
 */
export function cacheSet(key, fields) {
  if (!supabaseAdmin) return;
  const row = {
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

  try {
    Promise.resolve(
      supabaseAdmin.from('itunes_cache').upsert(row, { onConflict: 'cache_key' })
    ).then(({ error }) => {
      if (error) console.error('[itunes_cache] write failed:', error.message);
    }).catch((err) => {
      console.error('[itunes_cache] write threw:', err?.message || err);
    });
  } catch (err) {
    console.error('[itunes_cache] write threw:', err?.message || err);
  }
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