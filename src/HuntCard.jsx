// src/HuntCard.jsx
//
// D-037. A track we cannot play is a find, not a failure. This renders the
// candidates selectSurfaced tags isHunt:true -- itunesValidation ===
// 'not_found' specifically (see the comment at that call site for why
// 'wrong_title' and 'unconfirmed' are excluded).
//
// Deliberately its own component rather than branches inside
// RecommendationCard: the two card shapes differ in almost everything that
// matters here -- no preview ever, no artwork ever, a different and
// differently-ordered link set, a different line register. Threading that
// through the existing component as conditionals would obscure more than
// it would share.
//
// The K1 novelty control is the one exception -- it's identical between the
// two card types, so it's a shared NoveltyControl component rather than a
// third copy of the same two buttons.

import NoveltyControl from './NoveltyControl';

function RadarIcon() {
  // The static, same-every-time artwork treatment the brief asks for --
  // "not an empty box... should look intentional." A radar sweep ties back
  // to the product name rather than reading as a missing-image placeholder.
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.35" />
      <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.5" />
      <circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.7" />
      <path d="M12 12L12 3.2A8.8 8.8 0 0 1 19.6 8.2z" fill="currentColor" opacity="0.28" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    </svg>
  );
}

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

function BandcampIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="11" fill="#1DA0C3" />
      <path d="M7 15.5h6.2L17 8.5h-6.2L7 15.5z" fill="#fff" />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="1" y="4.5" width="22" height="15" rx="4" fill="#FF0000" />
      <path d="M10 8.3v7.4l6.5-3.7L10 8.3z" fill="#fff" />
    </svg>
  );
}

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

// Search links, not verified links, on purpose (D-037): a search always
// resolves, it just might not find the record. That is honest, and it is
// the hunt -- pointing, not delivering. Order is Spotify, Bandcamp, YouTube:
// Spotify first because a track missing from Apple Music may well be there;
// Bandcamp second because it's where self-released and genuinely
// underground music actually lives -- precisely the population that fails
// iTunes validation -- and it pays artists properly; YouTube as the
// backstop, inelegant but never empty.
function spotifySearchUrl(track, artist) {
  return `https://open.spotify.com/search/${encodeURIComponent(`${track} ${artist}`)}`;
}
function bandcampSearchUrl(track, artist) {
  return `https://bandcamp.com/search?q=${encodeURIComponent(`${track} ${artist}`)}`;
}
function youtubeSearchUrl(track, artist) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${track} ${artist}`)}`;
}

export default function HuntCard({ rec, onOutboundClick, isSaved, onToggleSave, onNoveltyReport }) {
  const metaLine = [rec.releaseYear, rec.genre].filter(Boolean).join(' · ');
  const spotifyUrl = spotifySearchUrl(rec.track, rec.artist);
  const bandcampUrl = bandcampSearchUrl(rec.track, rec.artist);
  const youtubeUrl = youtubeSearchUrl(rec.track, rec.artist);

  function logOutbound(service, url) {
    onOutboundClick?.({ track: rec.track, artist: rec.artist, service, url, isHunt: true });
  }

  return (
    <div className="rec-card">
      <div className="rec-row rec-row-hunt">
        <div className="rec-row-art">
          <div className="rec-row-artwork rec-row-artwork-hunt" aria-hidden="true">
            <RadarIcon />
          </div>
        </div>

        <div className="rec-row-body">
          <div className="rec-row-header">
            <span className="rec-pill rec-pill-hunt">Worth the dig</span>
            {metaLine && <span className="rec-row-meta">{metaLine}</span>}
          </div>

          <p className="rec-row-title">{rec.track}</p>
          <p className="rec-row-artist">{rec.artist}</p>

          {rec.explanation && <p className="rec-row-explanation">{rec.explanation}</p>}

          {/* Not a badge, not a warning -- lead, not fault. */}
          <p className="rec-row-hunt-line">
            This one I can't pull in clean. It's out there though — worth the dig.
          </p>
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

          {/* No preview control at all -- absent, not present-and-dead. There
              is never a previewUrl for a 'not_found' candidate, so this is
              simply omitted rather than rendered disabled. */}

          <div className="rec-row-links">
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
            <a
              href={bandcampUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rec-icon-link"
              aria-label="Search on Bandcamp"
              title="Bandcamp"
              onClick={() => logOutbound('bandcamp', bandcampUrl)}
            >
              <BandcampIcon />
            </a>
            <a
              href={youtubeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rec-icon-link"
              aria-label="Search on YouTube"
              title="YouTube"
              onClick={() => logOutbound('youtube', youtubeUrl)}
            >
              <YouTubeIcon />
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
