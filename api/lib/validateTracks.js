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