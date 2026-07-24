// src/sessionCount.js
//
// Counts distinct visits, pre-accounts.
//
// WHY THIS EXISTS
// App.jsx was sending `sessionCount: 0` hardcoded on every request. In
// groovePrompt.js, getActiveStage(0) fails every threshold (stage 1 needs >= 1),
// so getLoreAddendum returned an empty string and NO LORE HAS EVER FIRED in
// production. Not "users only saw stage 1" — they saw nothing at all. This is
// the likeliest reason no reviewer noticed Groove had a backstory.
//
// HONEST LIMITATIONS
// localStorage is per-browser and clearable, so this is a soft counter, not an
// identity system. Someone on a new device starts at 1; someone who clears
// storage resets. That is acceptable at this stage and matches D-019's note
// that real connection strength requires accounts (November).
//
// The visitor id is separate from the session id: session id changes every
// visit (sessionStorage), visitor id persists across visits (localStorage).
// Having both is what makes return_visit and Day-30 retention computable.

const VISITOR_KEY = 'rr_visitor_id';
const COUNT_KEY = 'rr_session_count';
const COUNTED_MARKER = 'rr_session_counted';
const LAST_SEEN_KEY = 'rr_last_seen';

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    /* private browsing, ignore */
  }
}

function makeId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `v_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Call ONCE at app mount, before anything reads the count.
 * Increments the counter at most once per browser session.
 *
 * @returns {{ visitorId: string, sessionCount: number, daysSinceLast: number|null }}
 */
export function initSession() {
  let visitorId = safeGet(localStorage, VISITOR_KEY);
  if (!visitorId) {
    visitorId = makeId();
    safeSet(localStorage, VISITOR_KEY, visitorId);
  }

  const lastSeenRaw = safeGet(localStorage, LAST_SEEN_KEY);
  let daysSinceLast = null;
  if (lastSeenRaw) {
    const ms = Date.now() - parseInt(lastSeenRaw, 10);
    if (!Number.isNaN(ms)) daysSinceLast = Math.floor(ms / 86400000);
  }

  // sessionStorage clears when the tab closes, so this marker guarantees the
  // counter moves once per visit no matter how many times the page reloads.
  if (!safeGet(sessionStorage, COUNTED_MARKER)) {
    const next = getSessionCount() + 1;
    safeSet(localStorage, COUNT_KEY, String(next));
    safeSet(sessionStorage, COUNTED_MARKER, '1');
  }

  safeSet(localStorage, LAST_SEEN_KEY, String(Date.now()));

  return { visitorId, sessionCount: getSessionCount(), daysSinceLast };
}

export function getSessionCount() {
  const raw = safeGet(localStorage, COUNT_KEY);
  const n = parseInt(raw || '0', 10);
  return Number.isNaN(n) ? 0 : n;
}

export function getVisitorId() {
  return safeGet(localStorage, VISITOR_KEY) || null;
}