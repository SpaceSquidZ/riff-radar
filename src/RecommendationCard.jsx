import { useEffect, useRef, useState } from 'react';

// One recommendation card. Playback is now controlled by the PARENT
// (App.jsx owns one shared <audio> element for the whole page) instead of
// each card managing its own <audio> — that's what previously let two
// cards' previews play simultaneously, since pressing play on card 2 had
// no way to know card 1's audio existed. Card just reflects isPlaying and
// asks the parent to toggle playback.
//
// Expects:
//   rec: { track, artist, matchAxis, genre, explanation, releaseYear,
//          itunesValidation, previewUrl, artworkUrl, trackViewUrl }
//   isPlaying: boolean — whether THIS card's preview is the one currently playing
//   onTogglePlay: () => void — ask the parent to play/pause this card's preview
//   onOutboundClick: ({track, artist, service, url}) => void

function spotifySearchUrl(track, artist) {
  const q = encodeURIComponent(`${track} ${artist}`);
  return `https://open.spotify.com/search/${q}`;
}

export default function RecommendationCard({ rec, isPlaying, onTogglePlay, onOutboundClick }) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const explanationRef = useRef(null);

  const hasPreview = rec.itunesValidation === 'found' && !!rec.previewUrl;
  const hasAppleMusicLink = rec.itunesValidation === 'found' && !!rec.trackViewUrl;

  useEffect(() => {
    if (explanationRef.current) {
      const el = explanationRef.current;
      setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.explanation]);

  function logOutbound(service, url) {
    onOutboundClick?.({ track: rec.track, artist: rec.artist, service, url });
  }

  const metaLine = [rec.releaseYear, rec.genre].filter(Boolean).join(' \u00b7 ');

  return (
    <div className="rec-card">
      {rec.matchAxis && <span className="rec-pill">{rec.matchAxis}</span>}

      {hasPreview && rec.artworkUrl && (
        <img src={rec.artworkUrl} alt={`${rec.track} artwork`} className="rec-artwork" />
      )}

      <p className="rec-title">{rec.track}</p>
      <p className="rec-artist">{rec.artist}</p>
      {metaLine && <p className="rec-meta">{metaLine}</p>}

      {rec.explanation && (
        <>
          <p
            ref={explanationRef}
            className={`rec-explanation${expanded ? ' expanded' : ''}`}
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

      <div className="rec-actions">
        {hasPreview && (
          <button type="button" onClick={onTogglePlay} className="rec-play-button">
            {isPlaying ? 'Pause preview' : 'Play 30s preview'}
          </button>
        )}

        <div className="rec-links">
          {hasAppleMusicLink && (
            <a
              href={rec.trackViewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rec-link-button"
              onClick={() => logOutbound('apple_music', rec.trackViewUrl)}
            >
              Apple Music
            </a>
          )}

          <a
            href={spotifySearchUrl(rec.track, rec.artist)}
            target="_blank"
            rel="noopener noreferrer"
            className="rec-link-button"
            onClick={() => logOutbound('spotify', spotifySearchUrl(rec.track, rec.artist))}
          >
            Spotify
          </a>
        </div>
      </div>
    </div>
  );
}