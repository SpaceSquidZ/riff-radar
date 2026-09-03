// src/crate.js
//
// The session crate: tracks the user chose to keep.
//
// WHY THIS IS NOT "EVERYTHING GROOVE RECOMMENDED"
// A first tester made the distinction sharply: 不要 conversation based 这样会乱,
// 让 user 自己去选哪些歌要 pick. Grouping by which conversation a track came from
// gets messy fast. The crate is what the user CHOSE, and choosing is the entire
// emotional content of the feature. A crate you did not dig is just a shelf.
//
// WHY sessionStorage AND NOT localStorage
// Deliberate. sessionStorage survives a refresh but not a new tab or a new day,
// which matches what this is: one night's digging, not a permanent library.
// Cross-session persistence needs accounts and lands in November. Promising
// permanence the app cannot deliver would be worse than the honest limit.
//
// THE POINT OF THE WHOLE THING (the "leave once" pattern)
// Every recommendation card is currently its own exit ramp. Three cards on
// screen is three chances to lose someone to Spotify mid-conversation. The
// crate concentrates that into ONE deliberate exit at a moment of the user's
// choosing, with everything they actually wanted in one place. Same eventual
// clicks out, far fewer chances to abandon the conversation on the way.

const CRATE_KEY = 'rr_crate';

/** Stable identity for a track across rec cards and opener records. */
export function crateKey(item) {
  const t = (item?.track || '').toLowerCase().trim();
  const a = (item?.artist || '').toLowerCase().trim();
  return `${t}::${a}`;
}

export function readCrate() {
  try {
    const raw = sessionStorage.getItem(CRATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeCrate(items) {
  try {
    sessionStorage.setItem(CRATE_KEY, JSON.stringify(items));
  } catch {
    /* private browsing or quota, ignore. The in-memory state still works. */
  }
}

/**
 * Only the fields the crate panel actually renders. Recommendation objects
 * carry explanations, ranks and validation status, none of which belong in a
 * saved list: the crate is the user's shelf, not a transcript of why Groove
 * suggested something.
 *
 * connectionType/distant/isHunt are the one exception (K3d, amending the
 * original version of this comment, which excluded them too): six months
 * later the connection label is the only record of why something was kept,
 * so it carries through onto the crate row rather than getting stripped.
 */
export function toCrateItem(rec, source = 'recommendation') {
  return {
    track: rec.track,
    artist: rec.artist,
    year: rec.releaseYear || rec.year || null,
    genre: rec.genre || null,
    artworkUrl: rec.artworkUrl || null,
    previewUrl: rec.previewUrl || null,
    trackViewUrl: rec.trackViewUrl || null,
    connectionType: rec.connectionType || null,
    distant: !!rec.distant,
    isHunt: !!rec.isHunt,
    source,
    savedAt: Date.now(),
  };
}