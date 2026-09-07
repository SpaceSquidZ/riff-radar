// src/ConsentPanel.jsx
//
// §4a rebuild (04 Sep 2026): centred on the black field App.jsx renders
// around this component, not an edge drawer. The right-edge/bottom-sheet
// drawer treatment (D-031, rebuilt 2026-08-31) is gone -- this and the
// status-label sequence that follows it are one designed moment ("the
// opening sequence"), not a disclosure that happens to sit near a separate
// visual effect, so they now share one surface. App.jsx owns that surface
// (.opener-black-field) and renders it at rgba(0,0,0,0.94)+, no blur, full
// viewport -- THIS component no longer renders its own scrim.
//
// EXACTLY THREE DISMISS PATHS, ALL RECORD SEEN (06 Sep 2026 fix).
// BUG THIS FIXES: the × button and backdrop-click-to-dismiss both called
// onClose directly, bypassing markConsentSeen() -- a visitor who dismissed
// either way saw the full black-field-and-consent sequence again on their
// next visit, because hasSeenConsent() was never actually set. Fixed by
// removing the ambiguous paths rather than patching them: no × button, no
// backdrop click. Got it, No thanks, and Escape (mapped to the same
// behaviour as No thanks -- a modal with no keyboard exit is an
// accessibility problem) are the only three, and all three are real
// decisions that mark seen. One behaviour, no branches, so this cannot
// recur. It also means nobody dismisses a privacy notice by accident,
// which is the right default for a privacy notice -- this is an
// explicit-acknowledgment pattern, not a forced-consent one, so both
// buttons stay equally prominent.
//
// OPEN BY DEFAULT (until read), not hidden behind discovery — the opposite
// default from the crate (src/CratePanel.jsx). This is a disclosure; it has
// to be seen, not found. It must never gate anything else: nothing in
// App.jsx waits for this panel to close (see the removed `if (showConsent)
// return` this replaces — that gate was an AC-1 failure, blocking Groove's
// opener behind a UI element the D-031 spec explicitly says must not block
// it).
//
// Brief M, P0-4. No persistent tab, no toggle, no re-open affordance --
// decided 2 Sep, dropped in the original briefing. This used to render an
// always-visible tab that reopened the drawer after Accept/Decline, which
// contradicted the "dismisses for good" intent. Dismissing it (by Accept,
// Decline, or Escape) closes it and there is nothing left on screen to
// bring it back with -- only a fresh page load with hasSeenConsent() still
// false shows it again.
//
// DECLINE IS REAL, not cosmetic. hasDeclinedConsent() is checked by emit()
// in App.jsx and short-circuits BEFORE logEvent is ever called — declining
// stops logging outright, it does not just dismiss this card. PRD v4.0 §9.
//
// Brief N, N-4 / §4a. App.jsx now holds Groove's opening sequence (status
// labels, then his first bubble) until this panel is dismissed, so a
// first-time visitor doesn't have any of it play out unseen behind the
// black field. onMount exists so App.jsx can tell "the panel rendered and
// is just open" apart from "the panel never rendered at all" -- only the
// second is a failure the sequence needs a guard against; the first is
// this component working correctly.

import { useCallback, useEffect } from 'react';

const SEEN_KEY = 'riff_radar_consent_seen';
const DECLINED_KEY = 'riff_radar_consent_declined';

export function hasSeenConsent() {
  return localStorage.getItem(SEEN_KEY) === 'true';
}

export function markConsentSeen() {
  localStorage.setItem(SEEN_KEY, 'true');
}

export function hasDeclinedConsent() {
  return localStorage.getItem(DECLINED_KEY) === 'true';
}

function markConsentDeclined() {
  localStorage.setItem(DECLINED_KEY, 'true');
}

// No separate onDecline callback: the parent never needs to react to this
// moment specifically. hasDeclinedConsent() lives in localStorage, and
// emit() in App.jsx reads it fresh on every call -- the flag itself IS the
// wiring, not a React state value threaded back up.
export default function ConsentPanel({ open, onClose, onMount }) {
  useEffect(() => {
    onMount?.();
  }, []);

  function handleAccept() {
    markConsentSeen();
    onClose();
  }

  // useCallback so the escape-key effect below has a stable function to
  // depend on -- a plain function here would be a new reference every
  // render, which is what the button's onClick doesn't care about but an
  // effect dependency array does.
  const handleDecline = useCallback(() => {
    markConsentSeen();
    markConsentDeclined();
    onClose();
  }, [onClose]);

  // Escape is the third and last dismiss path -- same behaviour as No
  // thanks, not a bare close, since a genuine decision (seen + declined) is
  // the only kind of dismissal this panel has anymore. Only listens while
  // open, so it can't fire against a panel that's already gone.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape') handleDecline();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleDecline]);

  return (
    <aside
      className={`consent-drawer${open ? ' consent-drawer-open' : ''}`}
      aria-hidden={!open}
    >
      <header className="consent-header">
        <h2 className="consent-title">Before we get into it</h2>
      </header>

      <div className="consent-body">
        <p>
          Here is what Riff Radar logs: which songs you bring to Groove (title and artist),
          the timestamps or moments you mark, whether you clicked through to a music
          streaming service, and basic session activity like messages exchanged and
          recommendations generated.
        </p>

        <p>
          Here is what it does not collect: the actual words you write to Groove are
          never logged to our analytics or stored in our database, and we don't collect
          any personal information. The words themselves stay in your browser for this
          session, so refreshing the page doesn't lose the conversation — closing the
          tab clears them for good.
        </p>

        <p>
          Here is what never happens: this data is never sold or shared with advertisers.
          That part matters.
        </p>

        <div className="consent-actions">
          <button type="button" className="consent-accept" onClick={handleAccept}>
            Got it
          </button>
          <button type="button" className="consent-decline" onClick={handleDecline}>
            No thanks
          </button>
        </div>

        <a className="consent-link" href="/privacy">
          Read the full details
        </a>
      </div>
    </aside>
  );
}
