// src/OpenerRecord.jsx
//
// A record Groove has on, NOT a recommendation.
//
// WHY THIS IS A SEPARATE COMPONENT FROM RecommendationCard
// D-025: "two is what someone actually has on; three is a set assembled for
// you." If opener records look identical to recommendation cards, that
// distinction collapses and the user reads the opener as recs they did not ask
// for. Different object, different treatment.
//
// Concretely it drops the two things that make a rec card a rec card: the
// connection-type pill and the one-sentence explanation. Groove is not
// explaining why these two go together, because he is not recommending them.
// The internal `thread` behind the pair is never rendered.
//
// Deliberately keeps the outbound links. They are the most complimented part of
// the product in feedback, and the star/crate replacement is Wave 3. Rationing
// them now on a guessed cadence would trade a liked feature for an untested
// hypothesis.

function spotifySearchUrl(track, artist) {
  // No OAuth, no API, no quota (D-003). If Spotify ever revokes anything, this
  // is the only thing that breaks and it is trivially swappable.
  return `https://open.spotify.com/search/${encodeURIComponent(`${track} ${artist}`)}`;
}

export default function OpenerRecord({ record, isPlaying, onTogglePlay, onOutboundClick }) {
  const { track, artist, year, genre, artworkUrl, trackViewUrl } = record;
  const spotifyUrl = spotifySearchUrl(track, artist);

  function handleOutbound(service, url) {
    if (onOutboundClick) {
      onOutboundClick({ track, artist, service, url, source: 'opener' });
    }
  }

  return (
    <div className="opener-record">
      {artworkUrl ? (
        <img className="opener-record-art" src={artworkUrl} alt="" loading="lazy" />
      ) : (
        <div className="opener-record-art opener-record-art-empty" />
      )}

      <div className="opener-record-body">
        <p className="opener-record-title">{track}</p>
        <p className="opener-record-artist">{artist}</p>
        {(year || genre) && (
          <p className="opener-record-meta">
            {[year, genre].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>

      <div className="opener-record-actions">
        <button
          className="opener-record-play"
          onClick={onTogglePlay}
          aria-label={isPlaying ? `Pause ${track}` : `Play ${track}`}
          type="button"
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" fill="currentColor" />
              <rect x="14" y="5" width="4" height="14" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M8 5v14l11-7z" fill="currentColor" />
            </svg>
          )}
        </button>

        {trackViewUrl && (
          <a
            className="opener-record-link"
            href={trackViewUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => handleOutbound('apple_music', trackViewUrl)}
            aria-label={`Open ${track} in Apple Music`}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                d="M12 3v10.55A4 4 0 1014 17V7h4V3z"
                fill="currentColor"
              />
            </svg>
          </a>
        )}

        <a
          className="opener-record-link"
          href={spotifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => handleOutbound('spotify', spotifyUrl)}
          aria-label={`Search ${track} on Spotify`}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15" />
            <path
              d="M7 9.5c3.5-1 7.5-.6 10 1M7.5 12.5c3-.8 6.2-.4 8.3 1M8 15.4c2.4-.6 4.9-.3 6.6.8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </a>
      </div>
    </div>
  );
}