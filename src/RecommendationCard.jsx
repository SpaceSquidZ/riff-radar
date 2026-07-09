import { useEffect, useRef, useState } from 'react';

// One recommendation card. Renders gracefully across three richness tiers,
// gating each element on whether its data is actually present rather than
// on an exact validation-status string:
//   - full:    artwork + preview player + Apple Music link + Spotify link
//   - reduced: artwork + Apple Music link + Spotify link (no preview clip)
//   - minimal: title/artist/genre/explanation + Spotify search link only
//              (a real-but-unfound or non-English track we couldn't verify
//              in any iTunes store — the Spotify search link works for any
//              language and never presents fabricated data as real)
//
// Playback is controlled by the parent (App.jsx owns one shared <audio>).

function spotifySearchUrl(track, artist) {
  const q = encodeURIComponent(`${track} ${artist}`);
  return `https://open.spotify.com/search/${q}`;
}

export default function RecommendationCard({ rec, isPlaying, onTogglePlay, onOutboundClick }) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const explanationRef = useRef(null);

  // Gate on data presence, not on a status string — a track found without
  // a preview should still show its artwork and Apple Music link.
  const hasPreview = !!rec.previewUrl;
  const hasArtwork = !!rec.artworkUrl;
  const hasAppleMusicLink = !!rec.trackViewUrl;

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

      {hasArtwork && (
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