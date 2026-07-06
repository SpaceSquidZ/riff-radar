import { useRef, useState } from 'react';

// Renders one Groove recommendation: album art, a 30-second in-app preview
// (from the iTunes-enriched fields your /api/chat now attaches), a real
// Apple Music link (trackViewUrl), and a Spotify search link.
//
// Expects a `rec` shaped like what validateAndEnrichRecs() in
// api/lib/validateTracks.js produces:
//   {
//     track, artist, releaseYear, genre, explanation, matchAxis,
//     itunesValidation: 'found' | 'not_found' | 'unconfirmed',
//     previewUrl, artworkUrl, trackViewUrl,
//   }
//
// Fallback behavior (PRD Risk 3): if itunesValidation !== 'found', render
// no player, no artwork, no error message — just the Spotify search link.
// A missing preview should never look like a broken app.

function spotifySearchUrl(track, artist) {
  const q = encodeURIComponent(`${track} ${artist}`);
  return `https://open.spotify.com/search/${q}`;
}

export default function RecommendationCard({ rec, onPreviewPlayed, onOutboundClick }) {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasLoggedPlay, setHasLoggedPlay] = useState(false);

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

    // preview_played event, per PRD Section 8 instrumentation plan.
    // Logged once per card, on first play, not on every resume.
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

  return (
    <div className="rec-card">
      {hasPreview && rec.artworkUrl && (
        <img src={rec.artworkUrl} alt={`${rec.track} artwork`} className="rec-artwork" />
      )}

      <div className="rec-body">
        <p className="rec-match-axis">{rec.matchAxis}</p>
        <h4 className="rec-title">
          {rec.track} <span className="rec-artist">— {rec.artist}</span>
        </h4>
        {rec.releaseYear && <p className="rec-meta">{rec.releaseYear} · {rec.genre}</p>}
        <p className="rec-explanation">{rec.explanation}</p>

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
              onClick={() => logOutbound('apple_music', rec.trackViewUrl)}
            >
              Open in Apple Music
            </a>
          )}

          <a
            href={spotifySearchUrl(rec.track, rec.artist)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => logOutbound('spotify', spotifySearchUrl(rec.track, rec.artist))}
          >
            Open in Spotify
          </a>
        </div>
      </div>
    </div>
  );
}