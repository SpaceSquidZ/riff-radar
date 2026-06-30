// src/sessionId.js
//
// Generates a random session ID once per browser and persists it in
// localStorage, so events from the same visitor group together even
// without real accounts (those arrive in Week 6).
//
// This is NOT a security-sensitive identifier — it's just a grouping
// key for analytics. Anyone could clear localStorage and get a new one.

const STORAGE_KEY = 'riff_radar_session_id';

export function getSessionId() {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}