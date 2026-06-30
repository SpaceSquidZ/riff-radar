import { useState, useRef, useEffect } from 'react';

// Extracts an 11-character YouTube video ID from common URL formats:
// youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID
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

// Loads the YouTube IFrame API script once, shared across mounts.
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

export default function YouTubeMomentPicker({ onTimestampCaptured }) {
  const [url, setUrl] = useState('');
  const [videoId, setVideoId] = useState(null);
  const [error, setError] = useState('');
  const [startMark, setStartMark] = useState(null);
  const [endMark, setEndMark] = useState(null);
  const playerRef = useRef(null);
  const playerContainerRef = useRef(null);

  function handleLoadVideo(e) {
    e.preventDefault();
    const id = extractVideoId(url.trim());
    if (!id) {
      setError('Could not find a video in that URL. Paste a full YouTube link.');
      return;
    }
    setError('');
    setStartMark(null);
    setEndMark(null);
    setVideoId(id);
  }

  // Create the player once we have a videoId and the API is ready.
  useEffect(() => {
    if (!videoId) return;

    let player;
    loadYouTubeApi().then(() => {
      player = new window.YT.Player(playerContainerRef.current, {
        videoId,
        playerVars: { rel: 0 },
      });
      playerRef.current = player;
    });

    return () => {
      if (player && player.destroy) player.destroy();
    };
  }, [videoId]);

  function markStart() {
    if (!playerRef.current) return;
    const time = playerRef.current.getCurrentTime();
    setStartMark(time);
    // If an end mark already exists and is now before the new start, clear it.
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
    <div>
      <h3>Or scrub a YouTube video to find your moment</h3>

      {!videoId && (
        <form onSubmit={handleLoadVideo}>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a YouTube link"
          />
          <button type="submit">Load video</button>
        </form>
      )}

      {error && <p>{error}</p>}

      {videoId && (
        <div>
          <div ref={playerContainerRef}></div>

          <button type="button" onClick={markStart}>
            Mark start {startMark !== null && `(${secondsToTimestamp(startMark)})`}
          </button>
          <button type="button" onClick={markEnd}>
            Mark end {endMark !== null && `(${secondsToTimestamp(endMark)})`}
          </button>

          <p>
            Marking just a start point captures a single instant. Marking both
            start and end captures a range.
          </p>

          <button type="button" onClick={useThisMoment}>
            Use this moment
          </button>
        </div>
      )}
    </div>
  );
}