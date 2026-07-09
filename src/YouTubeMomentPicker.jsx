import { useState, useRef, useEffect } from 'react';

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function secondsToTimestamp(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function guessArtistAndSongFromTitle(rawTitle) {
  if (!rawTitle) return null;

  let cleaned = rawTitle
    .replace(/\(.*?(official|video|audio|lyrics?|visualizer|hd|4k).*?\)/gi, '')
    .replace(/\[.*?(official|video|audio|lyrics?|visualizer|hd|4k).*?\]/gi, '')
    .replace(/\s*-\s*topic\s*$/i, '')
    .trim();

  const separators = [' - ', ' \u2013 ', ' \u2014 ', ' | '];
  for (const sep of separators) {
    if (cleaned.includes(sep)) {
      const [first, second] = cleaned.split(sep);
      if (first && second) {
        return { artist: first.trim(), song: second.trim() };
      }
    }
  }
  return null;
}

let apiLoadPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiLoadPromise) return apiLoadPromise;

  apiLoadPromise = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.body.appendChild(tag);
    window.onYouTubeIframeAPIReady = resolve;
  });
  return apiLoadPromise;
}

export default function YouTubeMomentPicker({ onTimestampCaptured, onTitleGuessed, onVideoLoadedChange }) {
  const [url, setUrl] = useState('');
  const [videoId, setVideoId] = useState(null);
  const [error, setError] = useState('');
  const [startMark, setStartMark] = useState(null);
  const [endMark, setEndMark] = useState(null);
  const playerRef = useRef(null);

  function handleLoadVideo() {
    const id = extractVideoId(url.trim());
    if (!id) {
      setError('Could not find a video in that URL. Paste a full YouTube link.');
      return;
    }
    setError('');
    setStartMark(null);
    setEndMark(null);
    setVideoId(id);
    if (onVideoLoadedChange) onVideoLoadedChange(true);
  }

  useEffect(() => {
    if (!videoId) return;

    let player;
    let cancelled = false;

    loadYouTubeApi()
      .then(() => {
        if (cancelled) return;
        try {
          player = new window.YT.Player('youtube-player-container', {
            videoId,
            playerVars: { rel: 0 },
            events: {
              onError: (e) => {
                console.error('YouTube player error:', e);
                setError('This video could not be loaded. It may be restricted from embedding.');
              },
              onReady: (e) => {
                try {
                  const data = e.target.getVideoData();
                  const guess = guessArtistAndSongFromTitle(data && data.title);
                  if (guess && onTitleGuessed) onTitleGuessed(guess);
                } catch (err) {
                  // Title guessing is best-effort only.
                }
              },
            },
          });
          playerRef.current = player;
        } catch (err) {
          console.error('Failed to create YouTube player:', err);
          setError('Something went wrong loading the video player.');
        }
      })
      .catch((err) => {
        console.error('Failed to load YouTube IFrame API:', err);
        setError('Could not load the YouTube player. Check your connection and try again.');
      });

    return () => {
      cancelled = true;
      if (player && player.destroy) player.destroy();
    };
  }, [videoId]);

  function markStart() {
    if (!playerRef.current) return;
    const time = playerRef.current.getCurrentTime();
    setStartMark(time);
    if (endMark !== null && endMark <= time) setEndMark(null);
  }

  function markEnd() {
    if (!playerRef.current) return;
    const time = playerRef.current.getCurrentTime();
    if (startMark !== null && time <= startMark) {
      setError('End mark should be after the start mark.');
      return;
    }
    setError('');
    setEndMark(time);
  }

  function useThisMoment() {
    if (startMark === null) {
      setError('Mark a start point first.');
      return;
    }
    const timestamp =
      endMark !== null
        ? `${secondsToTimestamp(startMark)}-${secondsToTimestamp(endMark)}`
        : secondsToTimestamp(startMark);

    onTimestampCaptured(timestamp);
  }

  return (
    <div className="moment-form-card">
      {!videoId && (
        <div>
          <h3 className="moment-form-heading">Find it in a video</h3>
          <p className="moment-form-hint">
            Paste a video and find your moment together. I'll be right here.
          </p>
          <input
            type="text"
            className="card-text-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLoadVideo()}
            placeholder="Paste a YouTube link"
          />
          <button type="button" className="card-button-primary" onClick={handleLoadVideo}>
            Load video
          </button>
        </div>
      )}

      {error && <p className="moment-form-error">{error}</p>}

      {videoId && (
        <div>
          <div id="youtube-player-container" className="youtube-player-embed"></div>

          <div className="youtube-mark-buttons">
            <button type="button" className="card-button-secondary" onClick={markStart}>
              Mark start {startMark !== null && `(${secondsToTimestamp(startMark)})`}
            </button>
            <button type="button" className="card-button-secondary" onClick={markEnd}>
              Mark end {endMark !== null && `(${secondsToTimestamp(endMark)})`}
            </button>
          </div>

          <p className="moment-form-subtext">
            Marking just a start point captures a single instant. Marking both
            start and end captures a range.
          </p>

          <button type="button" className="card-button-primary" onClick={useThisMoment}>
            Use this moment
          </button>
        </div>
      )}
    </div>
  );
}