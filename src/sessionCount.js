// src/sessionCount.js
//
// Counts DISTINCT DAYS visited, plus a persistent visitor id.
//
// WHY DAYS AND NOT SESSIONS
// D-019 defines connection strength as growing from distinct days visited,
// tracks discussed, and questions answered, with a per-day cap, and states the
// reason plainly: "it cannot be sprinted in one night." Any session definition
// based on idle gaps (the GA4/Mixpanel 30-minute convention) breaks that — a
// user with a morning, lunch, and evening visit banks three sessions in a day.
//
// Days are also the only definition that cannot be gamed from the browser.
// Tab-open counting punishes people who keep tabs open and double-counts people
// who close them. Idle-gap counting rewards leaving and coming back. Calendar
// days require actual time to pass.
//
// This is the same unit November's connection-strength system will use, so the
// thresholds change later but the counting does not. No migration.
//
// WHAT THIS IS NOT
// This is not an analytics session definition. Every event carries a
// server-assigned created_at and a visitor_id, so any session model (30-minute
// gaps, tab-opens, whatever) can be computed retroactively from the raw log in
// September. Do not couple the analytics definition to this one.
//
// HONEST LIMITATION
// localStorage is per-browser and clearable. A new device starts over. That is
// acceptable pre-accounts and is exactly what D-019 defers to November.

const VISITOR_KEY = 'rr_visitor_id';
// Set the first time the user actually SENDS a message, not merely loads.
const ENGAGED_KEY = 'rr_has_engaged';
const DAYS_KEY = 'rr_days_seen';
const LAST_DAY_KEY = 'rr_last_day';
const LAST_SEEN_KEY = 'rr_last_seen';

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
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

// LOCAL date, deliberately. A "day" should mean the user's day, not UTC's.
// Someone listening at 11pm Central should not roll over to tomorrow because
// a server somewhere is already past midnight.
function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Call ONCE at app mount.
 * Increments the day counter only if this is a new calendar day.
 *
 * @returns {{
 *   visitorId: string,
 *   daysSeen: number,
 *   daysSinceLast: number|null,
 *   isNewDay: boolean,
 *   isReturning: boolean
 * }}
 */
export function initSession() {
  let visitorId = safeGet(VISITOR_KEY);
  const isFirstEver = !visitorId;
  if (!visitorId) {
    visitorId = makeId();
    safeSet(VISITOR_KEY, visitorId);
  }

  const lastSeenRaw = safeGet(LAST_SEEN_KEY);
  let daysSinceLast = null;
  if (lastSeenRaw) {
    const ms = Date.now() - parseInt(lastSeenRaw, 10);
    if (!Number.isNaN(ms)) daysSinceLast = Math.floor(ms / 86400000);
  }

  const today = todayKey();
  const lastDay = safeGet(LAST_DAY_KEY);
  const isNewDay = lastDay !== today;

  if (isNewDay) {
    safeSet(DAYS_KEY, String(getDaysSeen() + 1));
    safeSet(LAST_DAY_KEY, today);
  }

  safeSet(LAST_SEEN_KEY, String(Date.now()));

  return {
    visitorId,
    daysSeen: getDaysSeen(),
    daysSinceLast,
    isNewDay,
    // "Returning" means they have TALKED to Groove before, not merely loaded
    // the page before.
    //
    // BUG THIS FIXES: this was `!isFirstEver`, which keyed off whether a
    // visitor id existed. Anyone who opened the link once and closed it
    // permanently lost the first-contact script and got the returning greeting
    // instead, so the single best-written thing in the product could be spent
    // on an idle page load. A real first tester hit exactly this.
    isReturning: hasEngaged(),
  };
}

/** True once the user has sent at least one message, ever. */
export function hasEngaged() {
  return safeGet(ENGAGED_KEY) === '1';
}

/** Call when the user sends their first message. Idempotent. */
export function markEngaged() {
  if (!hasEngaged()) safeSet(ENGAGED_KEY, '1');
}

export function getDaysSeen() {
  const n = parseInt(safeGet(DAYS_KEY) || '0', 10);
  return Number.isNaN(n) ? 0 : n;
}

export function getVisitorId() {
  return safeGet(VISITOR_KEY) || null;
}

/**
 * Days since the previous visit, or null on a first visit.
 * Read at send time so Groove can greet a returning user differently.
 */
export function getDaysSinceLast() {
  const raw = safeGet(LAST_SEEN_KEY);
  if (!raw) return null;
  const ms = Date.now() - parseInt(raw, 10);
  return Number.isNaN(ms) ? null : Math.floor(ms / 86400000);
}

// Alias so callers reading "session count" get the day count. The prompt's
// stage thresholds are expressed in these units.
export const getSessionCount = getDaysSeen;