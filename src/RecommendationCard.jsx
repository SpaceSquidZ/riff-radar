import { useRef, useState } from 'react';

// One recommendation card: match-axis pill, thumbnail art, title/artist,
// year/genre, an expandable explanation, preview player, and two link
// buttons. Designed to sit in a 3-column grid (see App.jsx).
//
// Expects a `rec` shaped like what validateAndEnrichRecs() produces, carrying
// Groove's metadata (matchAxis, genre, explanation) alongside the
// iTunes-enriched fields:
//   {
//     track, artist, matchAxis, genre, explanation, releaseYear,
//     itunesValidation: 'found' | 'not_found' | 'unconfirmed',
//     previewUrl, artworkUrl, trackViewUrl,
//   }

function spotifySearchUrl(track, artist) {
  const q = encodeURIComponent(`${track} ${artist}`);
  return `https://open.spotify.com/search/${q}`;
}

export default function RecommendationCard({ rec, onPreviewPlayed, onOutboundClick }) {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasLoggedPlay, setHasLoggedPlay] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const hasPreview = rec.itunesValidation === 'found' && !!rec.previewUrl;
  const hasAppleMusicLink = rec.itunesValidation === 'found' && !!rec.trackViewUrl;

  function togglePlay() {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }

    audioRef.current.play();
    setIsPlaying(true);

    if (!hasLoggedPlay) {
      setHasLoggedPlay(true);
      onPreviewPlayed?.({ track: rec.track, artist: rec.artist });
    }
  }

  function handleAudioEnded() {
    setIsPlaying(false);
  }

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
          <p className={`rec-explanation${expanded ? ' expanded' : ''}`}>{rec.explanation}</p>
          <button
            type="button"
            className="rec-read-more"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? 'Show less' : 'Read more'}
          </button>
        </>
      )}

      <div className="rec-actions">
        {hasPreview && (
          <div className="rec-preview">
            <audio
              ref={audioRef}
              src={rec.previewUrl}
              onEnded={handleAudioEnded}
              preload="none"
            />
            <button type="button" onClick={togglePlay} className="rec-play-button">
              {isPlaying ? 'Pause preview' : 'Play 30s preview'}
            </button>
          </div>
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