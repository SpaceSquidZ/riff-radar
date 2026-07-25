// src/loreProgress.js
//
// Tracks what Groove has already said to this person, so he does not repeat
// himself and so beats land once each.
//
// WHY CLIENT-SIDE
// Pre-accounts there is nowhere else to put it. The alternative is querying the
// events table by visitor_id on every request, which puts a Supabase read on
// the critical path of a reply. That is the exact pattern that caused the
// 60-second timeouts during the iTunes cache work.
//
// This is soft state: clearable, per-browser, and a user on a new device starts
// over. Acceptable pre-accounts. November's account system replaces it with a
// server-side record keyed to user_id.
//
// WHAT GETS TRACKED
//   deliveredArcBeats — episode beats already shown, by id
//   deliveredLoreLines — exact lore lines already used, so they never repeat
//   offeredAsks — daily-ask ids already offered, so the pool cycles
//   answeredAsks — asks the user actually responded to (for the acceleration
//                  signal and, later, for callbacks)

const ARC_KEY = 'rr_arc_beats';
const LORE_KEY = 'rr_lore_lines';
const ASKS_OFFERED_KEY = 'rr_asks_offered';
const ASKS_ANSWERED_KEY = 'rr_asks_answered';

function readList(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* private browsing, ignore */
  }
}

function push(key, value) {
  if (!value) return;
  const list = readList(key);
  if (list.includes(value)) return;
  list.push(value);
  writeList(key, list);
}

export function getDeliveredArcBeats() {
  return readList(ARC_KEY);
}

export function markArcBeatDelivered(beatId) {
  push(ARC_KEY, beatId);
}

export function getDeliveredLoreLines() {
  return readList(LORE_KEY);
}

export function markLoreLineDelivered(line) {
  push(LORE_KEY, line);
}

export function getOfferedAsks() {
  return readList(ASKS_OFFERED_KEY);
}

export function markAskOffered(askId) {
  push(ASKS_OFFERED_KEY, askId);
}

export function getAnsweredAsks() {
  return readList(ASKS_ANSWERED_KEY);
}

export function markAskAnswered(askId) {
  push(ASKS_ANSWERED_KEY, askId);
}

// --- pending ask ----------------------------------------------------------
//
// When Groove offers an ask, it becomes "pending" until the user answers it or
// two turns pass. The next request sends the pending ask's text as
// pendingQuestion, so Groove can (a) acknowledge an answer, and (b) report
// whether the reply actually answered it.
//
// Two turns, not one, because the prompt permits exactly one light follow-up
// before dropping it permanently.

const PENDING_ASK_KEY = 'rr_pending_ask';
const MAX_PENDING_TURNS = 2;

export function setPendingAsk(askId, askText) {
  try {
    localStorage.setItem(
      PENDING_ASK_KEY,
      JSON.stringify({ id: askId, text: askText, turns: 0 })
    );
  } catch {
    /* ignore */
  }
}

export function getPendingAsk() {
  try {
    const raw = localStorage.getItem(PENDING_ASK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPendingAsk() {
  try {
    localStorage.removeItem(PENDING_ASK_KEY);
  } catch {
    /* ignore */
  }
}

/** Age the pending ask by one turn; clears it once it is stale. */
export function agePendingAsk() {
  const pending = getPendingAsk();
  if (!pending) return;
  const turns = (pending.turns || 0) + 1;
  if (turns >= MAX_PENDING_TURNS) {
    clearPendingAsk();
    return;
  }
  try {
    localStorage.setItem(PENDING_ASK_KEY, JSON.stringify({ ...pending, turns }));
  } catch {
    /* ignore */
  }
}

/**
 * Everything the server needs to build the lore addendum.
 * Spread into the /api/chat request body.
 */
export function getProgressContext() {
  const pending = getPendingAsk();
  return {
    deliveredArcBeats: getDeliveredArcBeats(),
    deliveredLoreLines: getDeliveredLoreLines(),
    offeredAsks: getOfferedAsks(),
    answeredAsks: getAnsweredAsks(),
    pendingQuestion: pending?.text || null,
    pendingAskId: pending?.id || null,
  };
}