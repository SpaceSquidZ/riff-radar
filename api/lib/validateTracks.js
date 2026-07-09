// api/lib/validateTracks.js
//
// The anti-hallucination guard from PRD Section 7.3 / Automation 3.
// Call this from inside your /api/chat handler AFTER Claude returns
// recommendations and BEFORE you send them to the user.
//
// Two changes from the original version:
//   1. A track now only counts as "found" if it BOTH matches a real artist
//      AND has a 30-second preview URL. A track with no preview renders as
//      a broken-looking card (no artwork, no play button, no Apple Music
//      link) — better to drop it and show fewer cards than ship one that
//      looks half-broken.
//   2. Artist matching is now lenient (case-insensitive, tolerant of
//      "feat. X" / "ft. X" suffixes, substring match in either direction)
//      instead of requiring exact string equality. Exact matching was
//      producing false negatives on real tracks — e.g. Groove writing
//      "eAeon feat. DEAN" when iTunes lists the artist as just "eAeon"
//      was being treated as a hallucination when it wasn't one.

const ITUNES_BASE = 'https://itunes.apple.com/search';

function normalizeArtist(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\(feat[^)]*\)/g, '')
    .replace(/\bfeat\.?\s.*$/, '')
    .replace(/\bft\.?\s.*$/, '')
    .replace(/\bfeaturing\s.*$/, '')
    .trim();
}

function artistsMatch(a, b) {
  const na = normalizeArtist(a);
  const nb = normalizeArtist(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Validates a single {track, artist} pair against iTunes and, if a real
 * match with a preview exists, enriches it with preview/artwork/link data.
 *
 * @param {{track: string, artist: string}} rec
 * @returns {Promise<{valid: boolean|null, enriched: object|null}>}
 *   valid === null means the iTunes request itself failed (network/5xx),
 *   which should NOT be treated as a hallucination signal.
 */
export async function validateOneTrack(rec) {
  const term = `${rec.track} ${rec.artist}`;
  const url = `${ITUNES_BASE}?term=${encodeURIComponent(term)}&entity=song&limit=5`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { valid: null, enriched: null };
    }

    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      return { valid: false, enriched: null };
    }

    const match = data.results.find((r) => artistsMatch(r.artistName, rec.artist)) || null;

    if (!match || !match.previewUrl) {
      // Either no real artist match, or a match with no preview available —
      // both are treated as invalid per the "must have a preview" rule.
      return { valid: false, enriched: null };
    }

    return {
      valid: true,
      enriched: {
        previewUrl: match.previewUrl,
        artworkUrl: match.artworkUrl100 ? match.artworkUrl100.replace('100x100', '400x400') : null,
        trackViewUrl: match.trackViewUrl || null,
        releaseYear: match.releaseDate ? match.releaseDate.slice(0, 4) : null,
      },
    };
  } catch (err) {
    console.error(`iTunes validation request failed for "${term}":`, err);
    return { valid: null, enriched: null };
  }
}

/**
 * Validates and enriches an array of recommendations in parallel.
 * Each rec is annotated with:
 *   - itunesValidation: 'found' | 'not_found' | 'unconfirmed'
 *   - previewUrl, artworkUrl, trackViewUrl, releaseYear (null if not found)
 *
 * Callers should filter to itunesValidation === 'found' before display —
 * this module intentionally does not do that filtering itself, since only
 * the caller knows whether it wants to drop, retry, or otherwise handle
 * anything that didn't pass.
 *
 * @param {Array<{track: string, artist: string}>} recs
 * @returns {Promise<Array>} enriched recs with validation status
 */
export async function validateAndEnrichRecs(recs) {
  const results = await Promise.all(
    recs.map(async (rec) => {
      const { valid, enriched } = await validateOneTrack(rec);
      return {
        ...rec,
        itunesValidation: valid === true ? 'found' : valid === false ? 'not_found' : 'unconfirmed',
        previewUrl: enriched?.previewUrl ?? null,
        artworkUrl: enriched?.artworkUrl ?? null,
        trackViewUrl: enriched?.trackViewUrl ?? null,
        releaseYear: enriched?.releaseYear ?? null,
      };
    })
  );
  return results;
}