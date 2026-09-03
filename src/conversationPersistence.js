// src/conversationPersistence.js
//
// Roadmap v2 Wave 2 item 8 / Milestone 1 DoD: conversation persistence
// across refresh. sessionStorage, not localStorage -- same rationale as
// src/crate.js: this should survive a refresh but not a new tab or a new
// day. Promising permanence the app cannot deliver would be worse than the
// honest limit, and it keeps a returning-next-day visitor on the intended
// return-greeting path instead of resurrecting a stale conversation.
//
// Scoped beyond the bare `messages` array on purpose. sourceTrack and
// orbitArtist are pure in-memory React state with no persistence of their
// own -- restoring messages without them would make a refreshed
// conversation LOOK intact while silently losing pool-grounding context on
// the very next real turn. openerPair is included for the same reason: it
// is what event logging (opener_pair_id) and the API's openerPair field
// resolve against, and it is not recoverable from rendered message text.

const CONVERSATION_KEY = 'rr_conversation';

export function saveConversation({ messages, sourceTrack, orbitArtist, openerPair }) {
  try {
    sessionStorage.setItem(
      CONVERSATION_KEY,
      JSON.stringify({ messages, sourceTrack, orbitArtist, openerPair })
    );
  } catch {
    /* private browsing or quota, ignore. The in-memory state still works. */
  }
}

/**
 * Returns null unless there is an actual conversation to resume. A save
 * that landed before the opener's first bubble arrived (or nothing stored
 * at all) must fall through to the normal opener sequence, not to a blank
 * screen with no opener and no messages.
 *
 * buildingRecs is forced false on every restored message: it reflects an
 * in-flight stream that ended the moment the tab closed, and restoring it
 * as true would show a card stuck "digging" forever with nothing left to
 * finish it.
 */
export function loadConversation() {
  try {
    const raw = sessionStorage.getItem(CONVERSATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return null;
    }
    return {
      messages: parsed.messages.map((m) => ({ ...m, buildingRecs: false })),
      sourceTrack: parsed.sourceTrack ?? null,
      orbitArtist: parsed.orbitArtist ?? null,
      openerPair: parsed.openerPair ?? null,
    };
  } catch {
    return null;
  }
}
