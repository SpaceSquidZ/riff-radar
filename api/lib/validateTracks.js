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
//   'found'            — real, artist AND title match, has a preview
//   'found_no_preview' — real, artist AND title match, no preview clip anywhere
//   'wrong_title'      — the ARTIST is real but no result's TITLE matches. The
//                        recommended track is not confirmable, so it must not
//                        ship. Distinguished from 'not_found' because the two
//                        say different things about generation quality: a
//                        fabricated ARTIST is a different failure from a real
//                        artist with a fabricated TRACK, and Roadmap v2 Wave 1
//                        asks for both to be measurable.
//   'not_found'        — no artist match in ANY searched store
//   'unconfirmed'      — every iTunes request itself failed (network/5xx)
//
// CACHING (July 2026)
// Both lookup paths now read through a Supabase-backed cache before hitting
// iTunes, and write back on a miss. This is a prerequisite for D-023
// (six candidates instead of three), which doubles call volume against an
// undocumented, unofficially rate-limited API. See api/lib/itunesCache.js.
// 'unconfirmed' results are deliberately NEVER cached — a network blip is
// transient and must not poison a key for 30 days.

import {
  buildCacheKey,
  cacheGet,
  queueCacheWrite,
  rowToValidation,
  rowToFacts,
} from './itunesCache.js';

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

// Normalized Levenshtein similarity, 0..1. Used as the fallback check when
// neither exact nor a safe substring match applies.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[n];
}

function similarity(a, b) {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  return 1 - levenshtein(a, b) / longer;
}

// WRONG-MATCH GUARD (T1.4)
//
// The old rule was `na === nb || na.includes(nb) || nb.includes(na)`, which is
// how Steven's ZAYN failure got through: iTunes returned "Zayn Keoh", and
// "zayn keoh".includes("zayn") is true, so a completely different artist
// passed validation and rendered as a real card. That is worse than a missing
// recommendation — a validated-but-wrong track poisons trust in every correct
// one, which is why the PRD treats wrong-match as a trust cliff with its own
// 2% guardrail rather than folding it into hallucination rate.
//
// Substring matching is still needed for legitimate cases ("Beatles" vs "The
// Beatles"), so it is kept but bounded: the shorter name must account for most
// of the longer one. "beatles"/"the beatles" is 0.64 and passes.
// "zayn"/"zayn keoh" is 0.44 and fails.
const SUBSTRING_LENGTH_RATIO = 0.6;
const FUZZY_SIMILARITY_FLOOR = 0.85;
// Titles carry more characters than artist names, so the same proportional
// distance represents a larger real difference. Held tighter on purpose.
const TITLE_SIMILARITY_FLOOR = 0.9;

function oneArtistMatches(a, b) {
  const na = normalizeArtist(a);
  const nb = normalizeArtist(b);
  if (!na || !nb) return false;

  if (na === nb) return true;

  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    return shorter / longer >= SUBSTRING_LENGTH_RATIO;
  }

  // Catches spelling and transliteration drift ("Amalia Rodrigues" vs
  // "Amália Rodrigues", "Ali Farka Toure" vs "Ali Farka Touré") without
  // opening the door to unrelated names.
  return similarity(na, nb) >= FUZZY_SIMILARITY_FLOOR;
}

// True if ANY named artist in the recommendation matches ANY named artist in
// the iTunes result — the dual-direction check that fixes collab crediting.
export function artistsMatch(itunesArtist, recArtist) {
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

export async function validateOneTrack(rec, languageHint, cacheWriteBatch) {
  const stores = storesFor(rec, languageHint);
  const cacheKey = buildCacheKey('rec', rec.track, rec.artist, stores);

  const cached = await cacheGet(cacheKey);
  if (cached) {
    console.log(`[itunes_cache] HIT rec "${rec.track}" by ${rec.artist}`);
    return rowToValidation(cached);
  }

  const term = `${rec.track} ${rec.artist}`;
  const storeResults = await Promise.all(stores.map((c) => searchStore(term, c)));

  let anyRequestSucceeded = false;
  const artistMatches = [];  // artist matches, title not yet considered
  const fullMatches = [];    // artist AND title match — the only shippable set

  for (const results of storeResults) {
    if (results === null) continue;
    anyRequestSucceeded = true;
    for (const r of results) {
      if (!artistsMatch(r.artistName, rec.artist)) continue;
      artistMatches.push(r);
      // THE FIX (see block comment below): the title has to match too.
      if (titlesMatch(r.trackName, rec.track)) fullMatches.push(r);
    }
  }

  // NEVER cache this. Every iTunes request failed, which is a transient
  // network condition, not a fact about the track.
  if (!anyRequestSucceeded) {
    return { status: 'unconfirmed', enriched: null };
  }

  if (artistMatches.length === 0) {
    // Brief N, N-5. BUG THIS FIXES: a candidate could fail the artist check
    // above while the TITLE was sitting right there in the same storeResults,
    // credited to someone else -- "Down Town" is real, but iTunes lists it
    // under Sugar Babe, not the Eiichi Ohtaki attribution Groove gave it. The
    // old code only ever looked at artistMatches, so this searched the exact
    // same response twice under two different filters and only kept one of
    // them; the raw results were already in memory and got discarded.
    //
    // This is a distinct failure from not_found (title's not confirmed to
    // exist under ANY artist) and from wrong_title (artist's real, title
    // isn't). A title match under a different artist means the record IS
    // out there -- just not attributed the way Groove said -- which is
    // neither "absent from the catalogue" nor "hallucinated title," so it
    // gets its own status rather than being folded into either.
    const titleMatchElsewhere = storeResults
      .filter((results) => results !== null)
      .flat()
      .find((r) => titlesMatch(r.trackName, rec.track));

    if (titleMatchElsewhere) {
      queueCacheWrite(cacheWriteBatch, cacheKey, { found: false, confidence: 'misattributed' });
      return {
        status: 'misattributed',
        enriched: null,
        misattributedArtist: titleMatchElsewhere.artistName || null,
      };
    }

    queueCacheWrite(cacheWriteBatch, cacheKey, { found: false, confidence: 'not_found' });
    return { status: 'not_found', enriched: null };
  }

  // BUG THIS FIXES (observed live 2026-08-21)
  //
  // This function used to accept a result on ARTIST MATCH ALONE. iTunes search
  // is a relevance ranker, not an exact lookup: ask it for a track that does
  // not exist and it cheerfully returns whatever else that artist has. The
  // artist check passed, so the candidate was marked 'found' and shipped as a
  // real card — carrying a DIFFERENT song's preview clip, artwork, release year
  // and store link, all under the recommended title.
  //
  // A live MIKE session produced roughly eight of these in one conversation:
  // "Vase" by MAVI rendered from "Quanne Se Fa Notte", "Nu Sha" by Wu-Tang from
  // "Gravel Pit", "Duels" by GZA from "Living in the World Today", and so on.
  // Every card was internally consistent and every card was wrong.
  //
  // This is precisely Roadmap v2 R2, "wrong-match is a trust cliff, not a
  // slope", whose Wave 1 mitigation lists TITLE SUFFIX REJECTION alongside the
  // artist string distance that did get built. The artist half shipped (see
  // artistsMatch and scripts/test-artist-match.mjs); the title half did not.
  // lookupTrackFacts already does this correctly for the user's OWN track, and
  // says so at length — this brings the recommendation path to parity.
  //
  // titlesMatch is deliberately lenient about decoration (remasters, live
  // versions, "(feat. X)") and strict about the actual words, so legitimate
  // catalogue variance still passes.
  if (fullMatches.length === 0) {
    queueCacheWrite(cacheWriteBatch, cacheKey, { found: false, confidence: 'wrong_title' });
    return { status: 'wrong_title', enriched: null };
  }

  const withPreview = fullMatches.find((m) => m.previewUrl);
  const best = withPreview || fullMatches[0];
  const status = withPreview ? 'found' : 'found_no_preview';

  const enriched = {
    previewUrl: best.previewUrl || null,
    artworkUrl: best.artworkUrl100 ? best.artworkUrl100.replace('100x100', '400x400') : null,
    trackViewUrl: best.trackViewUrl || null,
    releaseYear: best.releaseDate ? best.releaseDate.slice(0, 4) : null,
  };

  queueCacheWrite(cacheWriteBatch, cacheKey, {
    found: true,
    confidence: status,
    trackName: best.trackName || rec.track,
    artistName: best.artistName || rec.artist,
    ...enriched,
  });

  return { status, enriched };
}

// languageHint is optional — a coarse language code or name derived from the
// user's own words (see chat.js). When absent, validation still works via
// script detection; the hint only widens the store net for the
// English-title / non-English-audio case.
export async function validateAndEnrichRecs(recs, languageHint, cacheWriteBatch) {
  const results = await Promise.all(
    recs.map(async (rec) => {
      const { status, enriched } = await validateOneTrack(rec, languageHint, cacheWriteBatch);
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
// TWO CACHE LAYERS:
//   L1 — the in-memory Map below. Free, instant, but only lives as long as one
//        warm Vercel container. Good for follow-up turns in the same session.
//   L2 — Supabase (itunesCache.js). Shared across every invocation and
//        survives cold starts. This is the one that actually cuts iTunes load.
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
    // Fold accents. iTunes stores "Yèkèrmo Sèw"; Groove and users both write
    // "Yekermo Sew". artistsMatch already survives this via its fuzzy floor,
    // but titles had no equivalent, so the Mulatu Astatke entry in the opener
    // pool would fail a strict title check against its own catalogue listing.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    // Apostrophes are DELETED rather than spaced. "Echo's Answer" typed as
    // "Echos Answer" must still match; spacing it produces "echo s answer",
    // which does not.
    .replace(/['’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // remaining punctuation, keeping any alphabet
    .replace(/\s+/g, ' ')
    .trim();
}

// Do these two titles plausibly refer to the same song?
// Deliberately lenient about decoration (remasters, live versions) but strict
// about the actual words: this is the check that stops a typo'd title from
// silently matching a DIFFERENT song by the same artist.
// Exported so scripts/test-title-match.mjs can pin its behaviour the same way
// scripts/test-artist-match.mjs pins artistsMatch. Roadmap v2 Wave 1 asks for
// regression fixtures on wrong-match detection; the artist half had them from
// the start, the title half did not.
export function titlesMatch(itunesTitle, userTitle) {
  const a = normalizeTitle(itunesTitle);
  const b = normalizeTitle(userTitle);
  if (!a || !b) return false;
  if (a === b) return true;

  // BOUNDED containment. The old rule was bare `a.includes(b) || b.includes(a)`
  // — the same shape as the artist rule that let "Zayn Keoh" pass for "ZAYN"
  // (see the WRONG-MATCH GUARD note above). In title form it means "The Kiss"
  // matches "The Kiss of Death" and "Falling" matches "Falling Slowly": two
  // genuinely different songs, and on the recommendation path that renders as a
  // real card for a song nobody asked about. Reuse the same ratio bound the
  // artist guard already uses, so containment still covers the case it was
  // added for ("Song" vs "Song (Extended Version)") and nothing wider.
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return shorter / longer >= SUBSTRING_LENGTH_RATIO;
  }

  // Residual drift the normalizer does not catch (transliteration variants,
  // a dropped particle). Deliberately tighter than the artist floor: titles are
  // longer, so an equivalent proportional distance is a much bigger difference.
  return similarity(a, b) >= TITLE_SIMILARITY_FLOOR;
}

export async function lookupTrackFacts(track, artist, languageHint, cacheWriteBatch) {
  if (!track || !artist) return null;

  const stores = storesFor({ track, artist }, languageHint);

  // L1: in-memory, this container only.
  const memKey = `${track.toLowerCase().trim()}::${artist.toLowerCase().trim()}::${languageHint || ''}`;
  if (sourceFactsCache.has(memKey)) return sourceFactsCache.get(memKey);

  // L2: Supabase, shared across all invocations.
  const cacheKey = buildCacheKey('src', track, artist, stores);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    console.log(`[itunes_cache] HIT src "${track}" by ${artist}`);
    const facts = rowToFacts(cached);
    if (sourceFactsCache.size >= SOURCE_CACHE_MAX) sourceFactsCache.clear();
    sourceFactsCache.set(memKey, facts);
    return facts;
  }

  const term = `${track} ${artist}`;
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
  let anyRequestSucceeded = false;

  for (const { country, results } of storeResults) {
    if (!results) continue;
    anyRequestSucceeded = true;
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

  // Only persist if iTunes actually answered. A total network failure looks
  // identical to 'not_found' here, and caching that for a week would be wrong.
  if (anyRequestSucceeded) {
    queueCacheWrite(cacheWriteBatch, cacheKey, facts);
  }

  if (sourceFactsCache.size >= SOURCE_CACHE_MAX) sourceFactsCache.clear();
  sourceFactsCache.set(memKey, facts);

  return facts;
}