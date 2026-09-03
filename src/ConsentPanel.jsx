// src/ConsentPanel.jsx
//
// D-031's actual shape (rebuilt 2026-08-31 — the July 2026 "closed" version
// was never really built; see the Decision Log status note on D-031). A
// RIGHT-edge drawer, on the opposite edge from CratePanel (src/CratePanel.jsx)
// and visually subordinate to it: the crate is a feature people reach for
// repeatedly, this is a disclosure people read once and dismiss for good.
//
// OPEN BY DEFAULT (until read), not hidden behind discovery — the opposite
// default from the crate. This is a disclosure; it has to be seen, not
// found. It must never gate anything else: nothing in App.jsx waits for
// this panel to close (see the removed `if (showConsent) return` this
// replaces — that gate was an AC-1 failure, blocking Groove's opener behind
// a UI element the D-031 spec explicitly says must not block it).
//
// Brief M, P0-4. No persistent tab, no toggle, no re-open affordance --
// decided 2 Sep, dropped in the original briefing. This used to render an
// always-visible tab that reopened the drawer after Accept/Decline, which
// contradicted the "dismisses for good" intent. Dismissing it (by any of
// Accept, Decline, the close button, or the scrim) closes it and there is
// nothing left on screen to bring it back with -- only a fresh page load
// with hasSeenConsent() still false shows it again.
//
// DECLINE IS REAL, not cosmetic. hasDeclinedConsent() is checked by emit()
// in App.jsx and short-circuits BEFORE logEvent is ever called — declining
// stops logging outright, it does not just dismiss this card. PRD v4.0 §9.

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
export default function ConsentPanel({ open, onClose }) {
  function handleAccept() {
    markConsentSeen();
    onClose();
  }

  function handleDecline() {
    markConsentSeen();
    markConsentDeclined();
    onClose();
  }

  return (
    <>
      {open && <div className="consent-scrim" onClick={onClose} aria-hidden="true" />}

      <aside
        className={`consent-drawer${open ? ' consent-drawer-open' : ''}`}
        aria-hidden={!open}
      >
        <header className="consent-header">
          <h2 className="consent-title">Before we get into it</h2>
          <button
            type="button"
            className="consent-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
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
    </>
  );
}
