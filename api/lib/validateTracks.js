// api/lib/validateTracks.js
//
// The anti-hallucination guard from PRD Section 7.3 / Automation 3.
// Call from /api/chat AFTER Claude returns recommendations, BEFORE sending
// them to the user.
//
// Validation is MULTI-STORE, and which stores get searched is decided two
// ways, because neither alone is sufficient:
//
//   1. Script detection — a track/artist written in non-Latin characters
//      (你, 蛋堡, ヨルシカ) obviously needs regional stores.
//
//   2. A LANGUAGE HINT from the conversation — this catches the case script
//      detection misses entirely: a song whose TITLE and ARTIST are Latin
//      text but which is actually sung in another language. "Come Over" by
//      "DEAN" is all-Latin characters but Korean; a romanized-name Mandarin
//      artist with an English song title is all-Latin too. If the user
//      described their moment in Korean/Chinese/Japanese/etc., that's a
//      strong signal to search those regional stores regardless of how the
//      track name happens to be spelled.
//
// Outcomes per track:
//   'found'            — real, artist matches, has a preview
//   'found_no_preview' — real, artist matches, no preview clip anywhere
//   'not_found'        — no artist match in ANY searched store
//   'unconfirmed'      — every iTunes request itself failed (network/5xx)

const ITUNES_BASE = 'https://itunes.apple.com/search';

// Map a coarse language hint to the iTunes storefronts most likely to carry
// that catalog. Keys are intentionally loose so callers can pass ISO 639-1,
// ISO 639-3 (what `franc` emits), or a plain language name.
const LANGUAGE_TO_STORES = {
  // Chinese
  zh: ['TW', 'HK', 'CN'], cmn: ['TW', 'HK', 'CN'], chinese: ['TW', 'HK', 'CN'], mandarin: ['TW', 'HK', 'CN'], cantonese: ['HK', 'TW'], yue: ['HK', 'TW'],
  // Korean
  ko: ['KR'], kor: ['KR'], korean: ['KR'],
  // Japanese
  ja: ['JP'], jpn: ['JP'], japanese: ['JP'],
  // A few more common cases
  th: ['TH'], tha: ['TH'], vi: ['VN'], vie: ['VN'], id: ['ID'], ind: ['ID'],
  es: ['ES', 'MX'], spa: ['ES', 'MX'], pt: ['BR', 'PT'], por: ['BR', 'PT'],
  fr: ['FR'], fra: ['FR'], de: ['DE'], deu: ['DE'], hi: ['IN'], hin: ['IN'],
};

// Fallback set when a track has non-Latin characters but we have no more
// specific language hint.
const GENERIC_NON_LATIN_STORES = ['TW', 'HK', 'JP', 'KR', 'CN'];

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

// Decides which storefronts to search for one track. US is always included.
// Regional stores are added from the language hint and/or from non-Latin
// characters in the track itself. Deduped, US first.
function storesFor(rec, languageHint) {
  const set = new Set(['US']);

  const hintKey = (languageHint || '').toLowerCase().trim();
  if (hintKey && LANGUAGE_TO_STORES[hintKey]) {
    for (const s of LANGUAGE_TO_STORES[hintKey]) set.add(s);
  }

  if (hasNonLatin(rec.track) || hasNonLatin(rec.artist)) {
    // If we had a specific hint we've already added its stores; still add
    // the generic set so e.g. a stray CJK title in an otherwise-English
    // session is covered.
    for (const s of GENERIC_NON_LATIN_STORES) set.add(s);
  }

  return [...set];
}

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

export async function validateOneTrack(rec, languageHint) {
  const term = `${rec.track} ${rec.artist}`;
  const stores = storesFor(rec, languageHint);

  const storeResults = await Promise.all(stores.map((c) => searchStore(term, c)));

  let anyRequestSucceeded = false;
  const artistMatches = [];

  for (const results of storeResults) {
    if (results === null) continue;
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

// languageHint is optional — a coarse language code or name derived from the
// user's own words (see chat.js). When absent, validation still works via
// script detection; the hint only widens the store net for the
// English-title / non-English-audio case.
export async function validateAndEnrichRecs(recs, languageHint) {
  const results = await Promise.all(
    recs.map(async (rec) => {
      const { status, enriched } = await validateOneTrack(rec, languageHint);
      return {
        ...rec,
        itunesValidation: status,
        previewUrl: enriched?.previewUrl ?? null,
        artworkUrl: enriched?.artworkUrl ?? null,
        trackViewUrl: enriched?.trackViewUrl ?? null,
        releaseYear: enriched?.releaseYear ?? null,
      };
    })
  );
  return results;
}