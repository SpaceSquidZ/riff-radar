// ConsentBanner.jsx
//
// Shown once, after the landing screen is dismissed, before the user
// interacts with the form. Stored in localStorage so it only appears
// once per browser. Written in Groove's voice but with plain-language
// specifics so the disclosure is unambiguous.

const STORAGE_KEY = 'riff_radar_consent_seen';

export function hasSeenConsent() {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function markConsentSeen() {
  localStorage.setItem(STORAGE_KEY, 'true');
}

export default function ConsentBanner({ onAccept }) {
  function handleAccept() {
    markConsentSeen();
    onAccept();
  }

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      padding: '1.5rem 2rem',
      borderTop: '1px solid rgba(128,128,128,0.2)',
      backdropFilter: 'blur(8px)',
      zIndex: 100,
      maxWidth: '680px',
      margin: '0 auto',
    }}>
      <p style={{ margin: '0 0 0.5rem 0', fontStyle: 'italic', fontSize: '0.95rem' }}>
        Before we get into it. A few things worth knowing.
      </p>

      <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', lineHeight: 1.6, opacity: 0.85 }}>
        Here is what Riff Radar logs: which songs you bring to Groove (title and artist),
        the timestamps or moments you mark, whether you clicked through to a music
        streaming service, and basic session activity like messages exchanged and
        recommendations generated.
      </p>

      <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', lineHeight: 1.6, opacity: 0.85 }}>
        Here is what it does not collect: the actual words you write to Groove,
        or any personal information.
      </p>

      <p style={{ margin: '0 0 1rem 0', fontSize: '0.875rem', lineHeight: 1.6, opacity: 0.85 }}>
        Here is what never happens: this data is never sold or shared with advertisers.
        That part matters.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button
          onClick={handleAccept}
          style={{ padding: '0.5rem 1.5rem', cursor: 'pointer', fontSize: '0.9rem' }}
        >
          Got it
        </button>
        <a
          href="/privacy"
          style={{ fontSize: '0.85rem', opacity: 0.7 }}
        >
          Read the full details
        </a>
      </div>
    </div>
  );
}