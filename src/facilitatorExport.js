// src/facilitatorExport.js
//
// Brief K5, item 2. Facilitator-only conversation export, for hand-coding a
// session's transcript afterward. No visible control -- testers must never
// see this exists, and nothing here renders anything.
//
// Keyboard chord, not a query parameter. navigator.clipboard.writeText()
// requires a live user gesture in most browsers; a keydown IS one, but a
// page load carrying ?export=1 is not, and the copy would silently fail in
// exactly the browsers a facilitator is most likely to be using.

import { loadConversation } from './conversationPersistence';
import { getSessionId } from './sessionId';
import { getVisitorId } from './sessionCount';

function isExportShortcut(event) {
  return (
    (event.ctrlKey || event.metaKey) &&
    event.altKey &&
    event.shiftKey &&
    event.key.toLowerCase() === 'e'
  );
}

async function exportConversation() {
  const conversation = loadConversation();
  if (!conversation) {
    console.warn('[facilitator export] nothing to export -- no stored conversation this session.');
    return;
  }

  // sessionId/visitorId are what make the export joinable against the
  // events table afterward; the bare transcript on its own isn't.
  const payload = {
    sessionId: getSessionId(),
    visitorId: getVisitorId(),
    exportedAt: new Date().toISOString(),
    ...conversation,
  };

  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    console.info('[facilitator export] conversation copied to clipboard.');
  } catch (err) {
    console.error('[facilitator export] clipboard write failed:', err);
  }
}

/**
 * Installs the Ctrl/Cmd+Alt+Shift+E export shortcut on the window.
 * Returns a cleanup function for a useEffect.
 */
export function installFacilitatorExport() {
  function handleKeyDown(event) {
    if (!isExportShortcut(event)) return;
    event.preventDefault();
    exportConversation();
  }
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
