// api/itunes-search.js
//
// Thin proxy in front of the iTunes Search API. Two reasons this lives
// server-side instead of calling itunes.apple.com directly from the browser:
//   1. Normalizes the response into exactly the shape the frontend needs
//      (drops the ~20 fields we don't use).
//   2. One choke point if iTunes ever rate-limits us or changes shape —
//      fix it here, not in every component that calls it.
//
// Usage: GET /api/itunes-search?track=Superposition&artist=Daniel%20Caesar
//
// Returns:
//   { found: true, result: { trackName, artistName, previewUrl, artworkUrl,
//                             trackViewUrl, releaseYear, collectionName } }
//   { found: false }
// Never throws to the caller — a failed lookup is just `found: false`
// so a flaky iTunes response never breaks Groove's recommendation flow.

export default async function handler(req, res) {
  const { track, artist } = req.query;

  if (!track || !artist) {
    return res.status(400).json({ error: 'track and artist are required query params' });
  }

  const term = `${track} ${artist}`;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
    term
  )}&entity=song&limit=5`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`iTunes API returned ${response.status} for term: ${term}`);
      return res.status(200).json({ found: false });
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      return res.status(200).json({ found: false });
    }

    const best = pickBestMatch(data.results, track, artist);

    if (!best) {
      return res.status(200).json({ found: false });
    }

    return res.status(200).json({
      found: true,
      result: {
        trackName: best.trackName,
        artistName: best.artistName,
        previewUrl: best.previewUrl || null,
        artworkUrl: best.artworkUrl100
          ? best.artworkUrl100.replace('100x100', '400x400')
          : null,
        // This is the field Groove's recs have been missing — a real,
        // clickable Apple Music page for the track. No auth, no MusicKit
        // JS needed to surface it.
        trackViewUrl: best.trackViewUrl || null,
        releaseYear: best.releaseDate ? best.releaseDate.slice(0, 4) : null,
        collectionName: best.collectionName || null,
      },
    });
  } catch (err) {
    console.error('iTunes Search API request failed:', err);
    // Graceful fallback per the roadmap's Risk 3 — a lookup failure
    // shows no player and no error, not a broken UI.
    return res.status(200).json({ found: false });
  }
}

// iTunes' own relevance ranking is decent but not artist-aware enough —
// it will happily return a cover version or a different artist entirely
// with a similar-sounding title. This does a light re-rank: prefer exact
// (case-insensitive) artist match, then exact track match, before falling
// back to iTunes' top result.
function pickBestMatch(results, wantedTrack, wantedArtist) {
  const norm = (s) => (s || '').toLowerCase().trim();

  const exactBoth = results.find(
    (r) => norm(r.artistName) === norm(wantedArtist) && norm(r.trackName) === norm(wantedTrack)
  );
  if (exactBoth) return exactBoth;

  const artistMatch = results.find((r) => norm(r.artistName) === norm(wantedArtist));
  if (artistMatch) return artistMatch;

  // No confident artist match at all — this is a strong hallucination
  // signal (see validateTrack.js), so don't guess. Return the top result
  // anyway; the caller decides what "found" means for validation purposes
  // vs. display purposes.
  return results[0];
}