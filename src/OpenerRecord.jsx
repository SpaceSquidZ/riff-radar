// src/OpenerRecord.jsx
//
// A record Groove has on, NOT a recommendation.
//
// WHY THIS IS A SEPARATE COMPONENT FROM RecommendationCard
// D-025: "two is what someone actually has on; three is a set assembled for
// you." What makes these different is the ABSENCE of a claim: no connection-type
// pill, no one-sentence explanation, because Groove is not explaining why these
// two go together. The internal pair thread is never rendered.
//
// Everything else now matches the rec card exactly, including the service icons.
// The earlier version used monochrome glyphs, which made the opener read as a
// lesser version of the real thing rather than the same kind of object.

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

function spotifySearchUrl(track, artist) {
  // No OAuth, no API, no quota (D-003). If Spotify ever revokes anything, this
  // is the only thing that breaks and it is trivially swappable.
  return `https://open.spotify.com/search/${encodeURIComponent(`${track} ${artist}`)}`;
}

export default function OpenerRecord({ record, isPlaying, onTogglePlay, onOutboundClick }) {
  const { track, artist, year, genre, artworkUrl, trackViewUrl, previewUrl } = record;
  const spotifyUrl = spotifySearchUrl(track, artist);
  const metaLine = [year, genre].filter(Boolean).join(' \u00b7 ');

  function handleOutbound(service, url) {
    onOutboundClick?.({ track, artist, service, url, source: 'opener' });
  }

  return (
    <div className="opener-record">
      {artworkUrl ? (
        <img className="opener-record-art" src={artworkUrl} alt="" loading="lazy" />
      ) : (
        <div className="opener-record-art opener-record-art-empty" aria-hidden="true" />
      )}

      <div className="opener-record-body">
        <p className="opener-record-title">{track}</p>
        <p className="opener-record-artist">{artist}</p>
        {metaLine && <p className="opener-record-meta">{metaLine}</p>}
      </div>

      <div className="opener-record-actions">
        {previewUrl && (
          <button
            className="opener-record-play"
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause preview' : 'Play 30 second preview'}
            title={isPlaying ? 'Pause preview' : 'Play 30s preview'}
            type="button"
          >
            <PlayIcon playing={isPlaying} />
          </button>
        )}

        {trackViewUrl && (
          <a
            className="opener-record-link"
            href={trackViewUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => handleOutbound('apple_music', trackViewUrl)}
            aria-label={`Open ${track} in Apple Music`}
            title="Apple Music"
          >
            <AppleMusicIcon />
          </a>
        )}

        <a
          className="opener-record-link"
          href={spotifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => handleOutbound('spotify', spotifyUrl)}
          aria-label={`Search ${track} on Spotify`}
          title="Spotify"
        >
          <SpotifyIcon />
        </a>
      </div>
    </div>
  );
}