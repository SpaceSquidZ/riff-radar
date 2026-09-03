import { useEffect, useRef, useState } from 'react';
import NoveltyControl from './NoveltyControl';

// Inline SVG so there's no icon library dependency and no extra network
// request. Simple glyph marks used to label the outbound link to each service.

function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="11" fill="#1DB954" />
      <path
        d="M6.5 9.2c3.6-1 7.6-.7 10.6 1.1M7.2 12.2c3-.8 6.3-.5 8.8 1M7.9 15.1c2.4-.6 5-.4 7 .8"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function AppleMusicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="22" height="22" rx="5" fill="#FA243C" />
      <path
        d="M15.5 6.4l-6 1.3v6.9a1.9 1.9 0 1 0 1.2 1.8V9.9l4.8-1v4.3a1.9 1.9 0 1 0 1.2 1.8V6.4z"
        fill="#fff"
      />
    </svg>
  );
}

// The save affordance. A star, not a plus: "keep this" rather than "add to a
// queue." Choosing is the entire emotional content of the crate, so the control
// should read as judgment, not as filing.
function StarIcon({ filled }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M12 3.6l2.5 5.4 5.9.7-4.4 4 1.2 5.8L12 16.6 6.8 19.5 8 13.7l-4.4-4 5.9-.7L12 3.6z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlayIcon({ playing }) {
  return playing ? (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="7" y="6" width="3.5" height="12" rx="1" fill="currentColor" />
      <rect x="13.5" y="6" width="3.5" height="12" rx="1" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M8 5.5v13l10-6.5-10-6.5z" fill="currentColor" />
    </svg>
  );
}

// D-022: five named connection types replace the old three fixed axes.
//
// The old structure (Structural twin / Adjacent genre / Surprise pick) rested
// on structural matching D-009 established we cannot perform. "Structural twin"
// was an unbackable claim, "adjacent genre" was too vague for a user to
// evaluate, and "surprise" invited randomness.
//
// Every type below is something the model genuinely knows and a user can
// verify or dispute. The label becomes the arguable part, which is the
// positioning made literal.
//
// Stored snake_case so the model produces a constrained token rather than a
// display string it might punctuate differently every time.
//
// Brief K5a (approved 01 Sep): display strings only, internal keys
// untouched. same_move and same_scene and same_mechanism were slippery even
// to the people who wrote them; the new words separate surface from depth --
// "Same trick" means they do the literally same thing, "Different route"
// means they reach the same effect by other means. The [recs] counters, the
// event schema, the fixture suites and every Decision Log entry from D-022
// onward reference the snake_case keys directly, so renaming those would
// break three weeks of counters for no gain.
const CONNECTION_LABELS = {
  same_hand: 'Same hands',
  lineage: 'Lineage',
  same_move: 'Same trick',
  same_scene: 'Same room',
  same_mechanism: 'Different route',
  // "Second listen" is the sixth type, deferred to November (D-024): it needs
  // rapport, which needs memory, which needs accounts. Not in the K5a table,
  // so left unchanged.
  second_listen: 'Second listen',
};

// Exported for App.jsx: K5b needs to know whether a given rec actually
// carries a resolvable label, to find the first card set that does.
export function connectionLabel(type) {
  if (!type) return null;
  const key = String(type).toLowerCase().replace(/[\s-]+/g, '_');
  return CONNECTION_LABELS[key] || null;
}

function spotifySearchUrl(track, artist) {
  const q = encodeURIComponent(`${track} ${artist}`);
  return `https://open.spotify.com/search/${q}`;
}

// Horizontal ROW layout, replacing the old 3-column grid of tall cards.
//
// The 3-column grid squeezed every card into a narrow vertical strip: the
// explanation clamped after ~4 lines, long titles truncated with an ellipsis,
// and the two service links stacked and wrapped ("Apple / Music" across two
// lines). A row gives text its natural horizontal space, so more information
// fits in less vertical distance, and it collapses cleanly on mobile.
export default function RecommendationCard({
  rec,
  isPlaying,
  onTogglePlay,
  onOutboundClick,
  isSaved,
  onToggleSave,
  onNoveltyReport,
}) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const explanationRef = useRef(null);

  const hasPreview = !!rec.previewUrl;
  const hasArtwork = !!rec.artworkUrl;
  const hasAppleMusicLink = !!rec.trackViewUrl;

  // connectionType is the v2b field. matchAxis is the v2a shape, tolerated so a
  // conversation open across the deploy does not render blank pills.
  const label = connectionLabel(rec.connectionType) || rec.matchAxis || null;

  useEffect(() => {
    if (explanationRef.current) {
      const el = explanationRef.current;
      setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
    }
  }, [rec.explanation]);

  function logOutbound(service, url) {
    onOutboundClick?.({ track: rec.track, artist: rec.artist, service, url });
  }

  const metaLine = [rec.releaseYear, rec.genre].filter(Boolean).join(' \u00b7 ');
  const spotifyUrl = spotifySearchUrl(rec.track, rec.artist);

  return (
    <div className="rec-card">
      <div className="rec-row">
        <div className="rec-row-art">
          {hasArtwork ? (
            <img src={rec.artworkUrl} alt="" className="rec-row-artwork" />
          ) : (
            <div className="rec-row-artwork rec-row-artwork-empty" aria-hidden="true" />
          )}
        </div>

        <div className="rec-row-body">
          <div className="rec-row-header">
            {label && <span className="rec-pill">{label}</span>}
            {/* DISTANT is a tag, never a type: far in language, geography, or era,
                but still carrying a real connection underneath. Display string
                only (K5a) -- rec.distant itself is unchanged. */}
            {rec.distant && <span className="rec-pill rec-pill-distant">Far signal</span>}
            {metaLine && <span className="rec-row-meta">{metaLine}</span>}
          </div>

          <p className="rec-row-title">{rec.track}</p>
          <p className="rec-row-artist">{rec.artist}</p>

          {rec.explanation && (
            <>
              <p
                ref={explanationRef}
                className={`rec-row-explanation${expanded ? ' expanded' : ''}`}
              >
                {rec.explanation}
              </p>
              {isOverflowing && (
                <button
                  type="button"
                  className="rec-read-more"
                  onClick={() => setExpanded((e) => !e)}
                >
                  {expanded ? 'Show less' : 'Read more'}
                </button>
              )}
            </>
          )}
        </div>

        <div className="rec-row-actions">
          {onToggleSave && (
            <button
              type="button"
              onClick={() => onToggleSave(rec)}
              className={`rec-row-save${isSaved ? ' rec-row-save-on' : ''}`}
              aria-label={isSaved ? `Remove ${rec.track} from crate` : `Save ${rec.track} to crate`}
              aria-pressed={!!isSaved}
              title={isSaved ? 'In your crate' : 'Keep this'}
            >
              <StarIcon filled={!!isSaved} />
            </button>
          )}

          {hasPreview && (
            <button
              type="button"
              onClick={onTogglePlay}
              className="rec-row-play"
              aria-label={isPlaying ? 'Pause preview' : 'Play 30 second preview'}
              title={isPlaying ? 'Pause preview' : 'Play 30s preview'}
            >
              <PlayIcon playing={isPlaying} />
            </button>
          )}

          <div className="rec-row-links">
            {hasAppleMusicLink && (
              <a
                href={rec.trackViewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rec-icon-link"
                aria-label="Open in Apple Music"
                title="Apple Music"
                onClick={() => logOutbound('apple_music', rec.trackViewUrl)}
              >
                <AppleMusicIcon />
              </a>
            )}

            <a
              href={spotifyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rec-icon-link"
              aria-label="Search on Spotify"
              title="Spotify"
              onClick={() => logOutbound('spotify', spotifyUrl)}
            >
              <SpotifyIcon />
            </a>
          </div>
        </div>
      </div>

      {onNoveltyReport && (
        <NoveltyControl novelty={rec.novelty} onReport={onNoveltyReport} />
      )}
    </div>
  );
}