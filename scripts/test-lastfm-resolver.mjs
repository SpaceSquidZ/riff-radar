// scripts/test-lastfm-resolver.mjs
//
// STANDALONE test of the containment-based artist resolution rule (Brief H).
// Not wired into lastfm.js -- this script exists to test the RULE, not ship
// code. Run against a fixed list of likely-split artists plus two controls,
// report per-artist whether resolution succeeded and what was selected.
//
// Usage:
//   set -a && source .env.local && set +a && node scripts/test-lastfm-resolver.mjs

const key = process.env.LASTFM_API_KEY;
if (!key) throw new Error('LASTFM_API_KEY not in environment');

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

async function call(method, params) {
  const url = new URL(API_ROOT);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', key);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

async function getSimilar(artist) {
  const json = await call('artist.getsimilar', { artist });
  return json.similarartists?.artist?.length ?? 0;
}

async function search(artist) {
  const json = await call('artist.search', { artist });
  return (json.results?.artistmatches?.artist || []).map((a) => a.name);
}

// Exact normalization spec from Brief H: NFKD, strip combining marks,
// casefold, collapse whitespace/punctuation to single spaces, trim. No
// stemming, no fuzzy matching, no edit distance -- edit distance is exactly
// what would let a near-miss like "Marika" back in for "Mariya".
function normalize(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

async function resolve(inputName) {
  const log = [];

  // Step 1: getSimilar on the name as given.
  const directCount = await getSimilar(inputName);
  if (directCount > 0) {
    log.push(`[lastfm] resolved "${inputName}" -> "${inputName}" (direct, ${directCount} similar)`);
    return { resolvedTo: inputName, graphSize: directCount, rank: 'direct', log, allCandidates: [] };
  }

  // Step 2: artist.search on the name.
  const results = await search(inputName);
  const normalizedQuery = normalize(inputName);

  // Step 3: containment filter.
  const survivors = [];
  const rejected = [];
  results.forEach((name, i) => {
    const rank = i + 1;
    if (normalize(name).includes(normalizedQuery)) {
      survivors.push({ name, rank });
    } else {
      rejected.push({ name, rank });
    }
  });

  if (survivors.length === 0) {
    log.push(`[lastfm] unresolved "${inputName}" -- 0 of ${results.length} results passed containment`);
    return { resolvedTo: null, graphSize: 0, rank: null, log, allCandidates: [] };
  }

  // Step 4: getSimilar on up to three survivors, take the largest graph.
  const tested = survivors.slice(0, 3);
  const candidates = [];
  for (const s of tested) {
    const count = await getSimilar(s.name);
    candidates.push({ ...s, graphSize: count });
  }

  // Log rejections among the tested candidates that didn't win (for the
  // "containment too strict/loose" auditability the brief asks for) --
  // here we additionally log candidates that DID pass containment but
  // lost on graph size, since those are also informative, though the
  // brief's example rejection line is specifically about containment
  // failures. Logging both, labeled distinctly.
  for (const r of rejected) {
    log.push(`[lastfm] rejected "${r.name}" (rank ${r.rank}) -- containment`);
  }

  const winner = candidates.reduce((best, c) => (c.graphSize > (best?.graphSize ?? -1) ? c : best), null);

  if (!winner || winner.graphSize === 0) {
    log.push(`[lastfm] unresolved "${inputName}" -- ${survivors.length} passed containment, none had a graph`);
    return { resolvedTo: null, graphSize: 0, rank: null, log, allCandidates: candidates };
  }

  log.push(
    `[lastfm] resolved "${inputName}" -> "${winner.name}" (rank ${winner.rank}, ${winner.graphSize} similar)`
  );
  return { resolvedTo: winner.name, graphSize: winner.graphSize, rank: winner.rank, log, allCandidates: candidates };
}

const ARTISTS = [
  { name: 'Mariya Takeuchi', note: 'Japanese, known split (Brief E/G)' },
  { name: 'Taeko Onuki', note: 'Japanese, suspected split (Brief E note on spelling drift)' },
  { name: 'Jaurim', note: 'Korean' },
  { name: 'Zemfira', note: 'Cyrillic/Russian' },
  { name: 'Faye Wong', note: 'Chinese (also D-025)' },
  { name: 'Sigur Rós', note: 'Latin + diacritic' },
  { name: 'ANOHNI', note: 'Latin + unusual stylization (all-caps)' },
  { name: 'black midi', note: 'Latin + unusual stylization (lowercase)' },
  { name: 'Radiohead', note: 'control, expect direct success' },
  { name: 'Mac DeMarco', note: 'control, expect direct success' },
];

for (const { name, note } of ARTISTS) {
  console.log(`\n=== ${name} (${note}) ===`);
  const result = await resolve(name);
  result.log.forEach((l) => console.log('  ' + l));
  console.log(`  candidates tested: ${JSON.stringify(result.allCandidates)}`);
}
