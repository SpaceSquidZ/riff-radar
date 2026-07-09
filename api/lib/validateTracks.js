// api/lib/validateTracks.js
//
// The anti-hallucination guard from PRD Section 7.3 / Automation 3.
// Call this from /api/chat AFTER Claude returns recommendations and BEFORE
// sending them to the user.
//
// Validation is now MULTI-STORE. The original US-only search systematically
// dropped real non-English tracks (Mandarin, Cantonese, K-pop, J-pop) that
// simply aren't in the US iTunes catalog or lack a US preview — which made
// entire non-English recommendation sets vanish. For any track containing
// non-Latin characters, this also searches the TW/HK/JP/KR/CN stores, where
// that catalog actually lives.
//
// Three outcomes per track:
//   'found'            — real track, artist matches, AND a preview exists
//   'found_no_preview' — real track, artist matches, but no preview clip
//                        anywhere (still has artwork + an Apple Music page)
//   'not_found'        — no artist match in ANY searched store (strong
//                        hallucination signal now that we search worldwide)
//   'unconfirmed'      — every iTunes request itself failed (network/5xx);
//                        NOT a hallucination signal, don't penalize it

const ITUNES_BASE = 'https://itunes.apple.com/search';

// Searched IN ADDITION to US when a track/artist has non-Latin characters.
const EXTRA_STORES_FOR_NON_LATIN = ['TW', 'HK', 'JP', 'KR', 'CN'];

// True if the string contains anything beyond basic Latin + Latin-1 +
// Latin Extended-A (covers accented European text as "Latin", flags CJK,
// Hangul, kana, etc. as non-Latin).
function hasNonLatin(s) {
  return /[^\u0000-\u024f]/.test(s || '');
}

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

// Returns an array of results, or null if the request itself failed.
// null (request failed) is deliberately distinct from [] (request
// succeeded, no matches) so the caller can tell a network problem apart
// from a genuine no-such-track.
async function searchStore(term, country) {
  const url = `${ITUNES_BASE}?term=${encodeURIComponent(term)}&entity=song&limit=5&country=${country}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.results || [];
  } catch (err) {
    console.error(`iTunes search failed (${country}) for "${term}":`, err);
    return null;
  }
}

export async function validateOneTrack(rec) {
  const term = `${rec.track} ${rec.artist}`;
  const nonLatin = hasNonLatin(rec.track) || hasNonLatin(rec.artist);
  const stores = nonLatin ? ['US', ...EXTRA_STORES_FOR_NON_LATIN] : ['US'];

  const storeResults = await Promise.all(stores.map((c) => searchStore(term, c)));

  let anyRequestSucceeded = false;
  const artistMatches = [];

  for (const results of storeResults) {
    if (results === null) continue; // this store's request failed
    anyRequestSucceeded = true;
    for (const r of results) {
      if (artistsMatch(r.artistName, rec.artist)) artistMatches.push(r);
    }
  }

  if (!anyRequestSucceeded) {
    return { status: 'unconfirmed', enriched: null };
  }

  if (artistMatches.length === 0) {
    return { status: 'not_found', enriched: null };
  }

  // Prefer a match that actually has a playable preview; fall back to any
  // confirmed match (real track, no preview clip available).
  const withPreview = artistMatches.find((m) => m.previewUrl);
  const best = withPreview || artistMatches[0];

  return {
    status: withPreview ? 'found' : 'found_no_preview',
    enriched: {
      previewUrl: best.previewUrl || null,
      artworkUrl: best.artworkUrl100 ? best.artworkUrl100.replace('100x100', '400x400') : null,
      trackViewUrl: best.trackViewUrl || null,
      releaseYear: best.releaseDate ? best.releaseDate.slice(0, 4) : null,
    },
  };
}

export async function validateAndEnrichRecs(recs) {
  const results = await Promise.all(
    recs.map(async (rec) => {
      const { status, enriched } = await validateOneTrack(rec);
      return {
        ...rec,
        itunesValidation: status, // 'found' | 'found_no_preview' | 'not_found' | 'unconfirmed'
        previewUrl: enriched?.previewUrl ?? null,
        artworkUrl: enriched?.artworkUrl ?? null,
        trackViewUrl: enriched?.trackViewUrl ?? null,
        releaseYear: enriched?.releaseYear ?? null,
      };
    })
  );
  return results;
}