// api/lib/validateTracks.js
//
// The anti-hallucination guard from PRD Section 7.3 / Automation 3.
// Call from /api/chat AFTER Claude returns recommendations, BEFORE sending
// them to the user.
//
// Validation is MULTI-STORE, and which stores get searched is decided by
// three signals, because no single one is sufficient:
//
//   1. Script detection — a track/artist written in non-Latin characters
//      (你, 蛋堡, ヨルシカ) obviously needs regional stores.
//
//   2. A LANGUAGE HINT from the conversation — catches a song whose TITLE
//      and ARTIST are Latin text but which is sung in another language, when
//      the user described their moment in that language.
//
//   3. A per-track REGION HINT reported by Groove (rec.region) — catches the
//      case the other two miss entirely: a Latin-script track, in an
//      English-language session, that just isn't in the US catalog (e.g.
//      Jorge Ben / Brazil, Fela Kuti / Nigeria). Groove knows the origin
//      when it recommends the track; this routes validation to that store.
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

// Map a per-track REGION hint (reported by Groove in the metadata, e.g.
// "Brazil", "France", "Nigeria") to storefronts. This is the fix for the
// case BOTH script detection and the conversation language hint miss: a
// Latin-script track, in an English-language session, that simply isn't in
// the US catalog. Groove knows Jorge Ben is Brazilian and Fela Kuti is
// Nigerian when it recommends them; letting it say so routes validation to
// the right store. Keys are lowercased country/region names and a few
// common aliases.
const REGION_TO_STORES = {
  brazil: ['BR'], brazilian: ['BR'],
  portugal: ['PT'], portuguese: ['PT'],
  france: ['FR'], french: ['FR'],
  germany: ['DE'], german: ['DE'],
  spain: ['ES'], spanish: ['ES'],
  mexico: ['MX'], mexican: ['MX'],
  italy: ['IT'], italian: ['IT'],
  nigeria: ['NG'], nigerian: ['NG'], 'west africa': ['NG'],
  'south africa': ['ZA'],
  jamaica: ['JM'], jamaican: ['JM'],
  japan: ['JP'], japanese: ['JP'],
  korea: ['KR'], 'south korea': ['KR'], korean: ['KR'],
  china: ['CN'], chinese: ['CN'],
  taiwan: ['TW'], taiwanese: ['TW'],
  'hong kong': ['HK'],
  thailand: ['TH'], thai: ['TH'],
  vietnam: ['VN'], vietnamese: ['VN'],
  indonesia: ['ID'], indonesian: ['ID'],
  india: ['IN'], indian: ['IN'],
  sweden: ['SE'], norway: ['NO'], iceland: ['IS'],
  netherlands: ['NL'], dutch: ['NL'],
  uk: ['GB'], 'united kingdom': ['GB'], britain: ['GB'], british: ['GB'], england: ['GB'],
  canada: ['CA'], australia: ['AU'],
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

// Splits a credited-artist string into its individual artists so a collab
// can be matched against EITHER name, not just the first. iTunes sometimes
// files "The Roots feat. Erykah Badu" under "Erykah Badu" as the primary
// artist; matching only the leading name ("The Roots") then wrongly fails.
// Returns e.g. ["the roots", "erykah badu"] for "The Roots feat. Erykah Badu".
function artistCandidates(name) {
  const raw = name || '';
  const parts = raw
    .split(/\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|,|&|\bx\b|\bwith\b|\/|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const cands = parts.length > 0 ? parts : [raw];
  // Also include the fully-normalized whole string as a candidate.
  return [...new Set([...cands.map((c) => normalizeArtist(c)), normalizeArtist(raw)])].filter(Boolean);
}

function oneArtistMatches(a, b) {
  const na = normalizeArtist(a);
  const nb = normalizeArtist(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// True if ANY named artist in the recommendation matches ANY named artist in
// the iTunes result — the dual-direction check that fixes collab crediting.
function artistsMatch(itunesArtist, recArtist) {
  const recCands = artistCandidates(recArtist);
  const itunesCands = artistCandidates(itunesArtist);
  for (const rc of recCands) {
    for (const ic of itunesCands) {
      if (oneArtistMatches(ic, rc)) return true;
    }
  }
  return false;
}

// Decides which storefronts to search for one track. US is always included.
// Regional stores are added from three signals, any of which can apply:
//   - the track's REGION hint from Groove (rec.region) — the strongest, and
//     the only one that catches Latin-script non-US catalog in an English
//     session (Brazilian, French, Nigerian, etc.)
//   - the conversation LANGUAGE hint
//   - non-Latin characters in the track/artist itself
// Deduped, US first.
function storesFor(rec, languageHint) {
  const set = new Set(['US']);

  const regionKey = (rec.region || '').toLowerCase().trim();
  if (regionKey && REGION_TO_STORES[regionKey]) {
    for (const s of REGION_TO_STORES[regionKey]) set.add(s);
  }

  const hintKey = (languageHint || '').toLowerCase().trim();
  if (hintKey && LANGUAGE_TO_STORES[hintKey]) {
    for (const s of LANGUAGE_TO_STORES[hintKey]) set.add(s);
  }

  if (hasNonLatin(rec.track) || hasNonLatin(rec.artist)) {
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

// ---------------------------------------------------------------------------
// SOURCE TRACK GROUNDING
//
// The recommendations were being validated against a real catalog, but the
// user's OWN song never was. So Groove reasoned about it purely from its title
// and artist string, with no ground truth, and title collisions wrecked it:
// given "Blue in Green" by kiki lili vivi (a modern Japanese track), Groove
// pattern-matched the title to the 1959 Miles Davis / Bill Evans jazz standard
// and anchored all three recommendations to the wrong song.
//
// This looks the user's track up in the same multi-store catalog and returns
// hard facts (real artist name as listed, genre, release year, storefront) so
// the prompt can tell Groove what the song ACTUALLY is.
//
// Cached in-memory. Vercel reuses serverless containers between requests, so
// follow-up turns in the same conversation usually hit this cache and pay no
// lookup cost at all. Only the first turn of a conversation pays for it.
// ---------------------------------------------------------------------------

const sourceFactsCache = new Map();
const SOURCE_CACHE_MAX = 500;

// Normalizes a track title for comparison. Strips the noise iTunes adds
// (remaster tags, version suffixes, featured-artist parentheticals) and all
// punctuation, so "Blue in Green (2023 Remaster)" still matches "Blue in Green".
function normalizeTitle(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')      // (Remastered), (feat. X), (Live)
    .replace(/\[[^\]]*\]/g, ' ')     // [Explicit]
    .replace(/\s-\s.*$/, ' ')        // " - 2011 Remaster"
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation, keeping any alphabet
    .replace(/\s+/g, ' ')
    .trim();
}

// Do these two titles plausibly refer to the same song?
// Deliberately lenient about decoration (remasters, live versions) but strict
// about the actual words: this is the check that stops a typo'd title from
// silently matching a DIFFERENT song by the same artist.
function titlesMatch(itunesTitle, userTitle) {
  const a = normalizeTitle(itunesTitle);
  const b = normalizeTitle(userTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  // One containing the other covers "Song" vs "Song (Extended Version)".
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

export async function lookupTrackFacts(track, artist, languageHint) {
  if (!track || !artist) return null;

  const cacheKey = `${track.toLowerCase().trim()}::${artist.toLowerCase().trim()}::${languageHint || ''}`;
  if (sourceFactsCache.has(cacheKey)) return sourceFactsCache.get(cacheKey);

  const term = `${track} ${artist}`;
  const stores = storesFor({ track, artist }, languageHint);
  const storeResults = await Promise.all(
    stores.map(async (c) => ({ country: c, results: await searchStore(term, c) }))
  );

  // Two tiers, and the distinction matters a lot:
  //
  //   confirmed  — BOTH the artist and the title match. Safe to state as fact.
  //   artist_only — the artist matches but no result's title does. This is the
  //                 typo case: the user misspelled the song, and iTunes happily
  //                 returned some OTHER song by that same artist. Previously we
  //                 would have grabbed it and told Groove it was verified fact,
  //                 anchoring every recommendation to a song the user never
  //                 mentioned. Now we refuse to assert anything about the track.
  let confirmed = null;
  let confirmedIn = null;
  let sawArtist = false;

  for (const { country, results } of storeResults) {
    if (!results) continue;
    for (const r of results) {
      if (!artistsMatch(r.artistName, artist)) continue;
      sawArtist = true;
      if (!titlesMatch(r.trackName, track)) continue;
      // Prefer a confirmed match that actually carries a genre.
      if (!confirmed || (!confirmed.primaryGenreName && r.primaryGenreName)) {
        confirmed = r;
        confirmedIn = country;
      }
    }
  }

  let facts;
  if (confirmed) {
    facts = {
      found: true,
      confidence: 'confirmed',
      trackName: confirmed.trackName || track,
      artistName: confirmed.artistName || artist,
      genre: confirmed.primaryGenreName || null,
      releaseYear: confirmed.releaseDate ? confirmed.releaseDate.slice(0, 4) : null,
      albumName: confirmed.collectionName || null,
      storefront: confirmedIn,
    };
  } else if (sawArtist) {
    // The artist is real, the track isn't confirmable. Say exactly that, and
    // nothing more. Do NOT hand back another song's metadata.
    facts = { found: false, confidence: 'artist_only', artistName: artist };
  } else {
    facts = { found: false, confidence: 'not_found' };
  }

  if (sourceFactsCache.size >= SOURCE_CACHE_MAX) sourceFactsCache.clear();
  sourceFactsCache.set(cacheKey, facts);

  return facts;
}