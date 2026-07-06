// api/lib/validateTracks.js
//
// The anti-hallucination guard from PRD Section 7.3 / Automation 3.
// Call this from inside your /api/chat handler AFTER Claude returns
// recommendations and BEFORE you send them to the user.
//
// This module does NOT call the Claude API itself — it just validates
// and enriches tracks. Regenerating a replacement recommendation when
// a track fails validation is your chat handler's job (see the
// integration sketch at the bottom of this file).

const ITUNES_BASE = 'https://itunes.apple.com/search';

/**
 * Validates a single {track, artist} pair against iTunes and, if found,
 * enriches it with preview/artwork/link data.
 *
 * @param {{track: string, artist: string}} rec
 * @returns {Promise<{valid: boolean, enriched: object|null}>}
 */
export async function validateOneTrack(rec) {
  const term = `${rec.track} ${rec.artist}`;
  const url = `${ITUNES_BASE}?term=${encodeURIComponent(term)}&entity=song&limit=5`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      // Treat a transient iTunes failure as "couldn't confirm," not
      // "definitely fake." See note in validateAndEnrichRecs below on
      // how the caller should weigh this.
      return { valid: null, enriched: null };
    }

    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      return { valid: false, enriched: null };
    }

    const norm = (s) => (s || '').toLowerCase().trim();
    const match =
      data.results.find((r) => norm(r.artistName) === norm(rec.artist)) || null;

    if (!match) {
      // iTunes found something for the search term, but nothing by the
      // artist Groove named. That's exactly the misattribution case the
      // PRD calls out (Section 7.1, hard rules) — treat as invalid.
      return { valid: false, enriched: null };
    }

    return {
      valid: true,
      enriched: {
        previewUrl: match.previewUrl || null,
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
 * Returns the same array shape, each rec annotated with:
 *   - itunesValidation: 'found' | 'not_found' | 'unconfirmed'
 *   - previewUrl, artworkUrl, trackViewUrl, releaseYear (null if not found)
 *
 * Does NOT filter out failed recs or call Claude for replacements —
 * that decision belongs in your chat handler, because only it has the
 * conversation context needed to re-prompt Claude sensibly. This module
 * just tells you which recs failed.
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

/*
INTEGRATION SKETCH for /api/chat.js
------------------------------------
After you parse Groove's 3 recommendations out of Claude's response:

  import { validateAndEnrichRecs } from './lib/validateTracks.js';

  let enrichedRecs = await validateAndEnrichRecs(parsedRecs);

  const failed = enrichedRecs.filter(r => r.itunesValidation === 'not_found');

  if (failed.length > 0) {
    // Log the hallucination event (Supabase: itunes_validation_failed,
    // per PRD Section 8 instrumentation plan).
    await logEvent('itunes_validation_failed', { failed, sessionId });

    // Silently re-prompt Claude for replacements only for the failed
    // slots, reusing the same system prompt + conversation history,
    // with an added user-invisible instruction like:
    // "The following recommendations could not be verified and must be
    // replaced with different, real tracks: [list]. Do not mention this
    // to the user." Then re-validate the replacements once. Cap retries
    // at 1 pass — don't loop indefinitely if Claude keeps hallucinating
    // for a stubborn genre.
  }

  // 'unconfirmed' (iTunes request itself failed, e.g. timeout) should
  // NOT be treated as a hallucination — don't burn a retry on it. Just
  // ship the rec without a preview player and without a trackViewUrl
  // link, same as the Risk 3 graceful-fallback behavior.

  // Send enrichedRecs to the frontend as-is; RecommendationCard.jsx
  // (see companion file) knows how to render found / not_found / unconfirmed.
*/