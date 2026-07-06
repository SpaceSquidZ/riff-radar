import { useState } from 'react';
import { franc } from 'franc';
import { getSessionId } from './sessionId';
import { logEvent } from './supabaseClient';

const EXAMPLE_MOMENTS = [
  { song: 'Superposition', artist: 'Daniel Caesar', timestamp: '3:20', whatCaughtYou: 'the vocal stack that blooms open' },
  { song: 'Redbone', artist: 'Childish Gambino', timestamp: '2:10', whatCaughtYou: 'the guitar riff that just loops and loops' },
  { song: 'Liability', artist: 'Lorde', timestamp: '1:45', whatCaughtYou: 'how bare the production gets right there' },
  { song: 'Bags', artist: 'Clairo', timestamp: '0:50', whatCaughtYou: 'the way her voice cracks on that one word' },
  { song: 'Mystery of Love', artist: 'Sufjan Stevens', timestamp: '2:55', whatCaughtYou: 'the strings coming in underneath' },
  { song: 'Bohemian Rhapsody', artist: 'Queen', timestamp: '3:03', whatCaughtYou: 'the operatic section just exploding into rock' },
  { song: 'good 4 u', artist: 'Olivia Rodrigo', timestamp: '0:42', whatCaughtYou: 'how the chorus just slams in after that quiet verse' },
  { song: 'Pink + White', artist: 'Frank Ocean', timestamp: '3:10', whatCaughtYou: 'the backing vocals barely announcing themselves' },
  { song: 'Cardigan', artist: 'Taylor Swift', timestamp: '2:30', whatCaughtYou: 'the piano dropping out right before the bridge' },
  { song: 'Motion Sickness', artist: 'Phoebe Bridgers', timestamp: '1:58', whatCaughtYou: 'the way the drums just kick in out of nowhere' },
];

function getRandomExample() {
  return EXAMPLE_MOMENTS[Math.floor(Math.random() * EXAMPLE_MOMENTS.length)];
}

function isValidTimestamp(value) {
  const trimmed = value.trim();
  const single = /^\d{1,2}:\d{2}$/;
  const range = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/;
  return single.test(trimmed) || range.test(trimmed);
}

function detectLanguage(text) {
  if (!text || text.trim().length < 10) return null;
  const result = franc(text.trim());
  return result === 'und' ? null : result;
}

// MomentForm no longer owns YouTubeMomentPicker — the player lives in
// App.jsx so it can survive the form-to-chat transition. This component
// receives timestamp and title-guess callbacks from App instead.
export default function MomentForm({
  onSubmit,
  // Pre-filled timestamp from the YouTube picker (controlled by App)
  youtubeTimestamp,
  // Whether a video is currently loaded (controls layout)
  videoLoaded,
  // Song/artist guess from YouTube title parsing
  titleGuess,
}) {
  const [example] = useState(getRandomExample);
  const [song, setSong] = useState('');
  const [artist, setArtist] = useState('');
  const [timestamp, setTimestamp] = useState('');
  const [whatCaughtYou, setWhatCaughtYou] = useState('');
  const [error, setError] = useState('');
  const [songIsGuess, setSongIsGuess] = useState(false);
  const [artistIsGuess, setArtistIsGuess] = useState(false);

  // Sync YouTube-captured timestamp into the local field.
  // Using a ref pattern to avoid infinite loops from the prop changing.
  const prevYoutubeTimestamp = useState(null);
  if (youtubeTimestamp && youtubeTimestamp !== prevYoutubeTimestamp[0]) {
    prevYoutubeTimestamp[1](youtubeTimestamp);
    setTimestamp(youtubeTimestamp);
  }

  // Sync title guess from YouTube into song/artist fields,
  // but only if the user hasn't already typed something there.
  const prevTitleGuess = useState(null);
  if (titleGuess && titleGuess !== prevTitleGuess[0]) {
    prevTitleGuess[1](titleGuess);
    if (!song.trim()) { setSong(titleGuess.song); setSongIsGuess(true); }
    if (!artist.trim()) { setArtist(titleGuess.artist); setArtistIsGuess(true); }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!song.trim() || !artist.trim() || !timestamp.trim() || !whatCaughtYou.trim()) {
      setError('All fields are required.');
      return;
    }
    if (!isValidTimestamp(timestamp)) {
      setError('Timestamp should be mm:ss (like 3:20) or a range (like 2:15-2:45).');
      return;
    }
    setError('');

    const detectedLanguage = detectLanguage(whatCaughtYou);
    const sessionId = getSessionId();
    logEvent(sessionId, 'moment_submitted', {
      song: song.trim(),
      artist: artist.trim(),
      timestamp: timestamp.trim(),
      input_method: videoLoaded ? 'youtube' : 'manual',
      language: detectedLanguage,
    });

    const formattedMessage =
      `I'm listening to ${song.trim()} by ${artist.trim()}. ` +
      `At ${timestamp.trim()}, ${whatCaughtYou.trim()} ` +
      `Find me more music like this.`;

    onSubmit({
      song: song.trim(),
      artist: artist.trim(),
      timestamp: timestamp.trim(),
      whatCaughtYou: whatCaughtYou.trim(),
      formattedMessage,
      detectedLanguage,
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>Describe a moment</h2>

      <div>
        <label htmlFor="song">
          Song title {songIsGuess && <span style={{ fontSize: '0.8em', opacity: 0.6 }}>(from the video title, double check this)</span>}
        </label>
        <input
          id="song"
          type="text"
          value={song}
          onChange={(e) => { setSong(e.target.value); setSongIsGuess(false); }}
          placeholder={example.song}
        />
      </div>

      <div>
        <label htmlFor="artist">
          Artist {artistIsGuess && <span style={{ fontSize: '0.8em', opacity: 0.6 }}>(from the video title, double check this)</span>}
        </label>
        <input
          id="artist"
          type="text"
          value={artist}
          onChange={(e) => { setArtist(e.target.value); setArtistIsGuess(false); }}
          placeholder={example.artist}
        />
      </div>

      <div>
        <label htmlFor="timestamp">Timestamp (mm:ss, or a range like 2:15-2:45)</label>
        <input
          id="timestamp"
          type="text"
          value={timestamp}
          onChange={(e) => setTimestamp(e.target.value)}
          placeholder={example.timestamp}
        />
      </div>

      <div>
        <label htmlFor="whatCaughtYou">What caught you?</label>
        <p style={{ fontSize: '0.85em', opacity: 0.7, margin: '4px 0 8px 0' }}>
          Take your time. The more specific, the more interesting where this goes.
        </p>
        <textarea
          id="whatCaughtYou"
          rows={6}
          style={{ width: '100%', minHeight: '120px', padding: '12px', boxSizing: 'border-box' }}
          value={whatCaughtYou}
          onChange={(e) => setWhatCaughtYou(e.target.value)}
          placeholder={example.whatCaughtYou}
        />
      </div>

      {error && <p style={{ color: 'red' }}>{error}</p>}
      <button type="submit">Find me music like this</button>
    </form>
  );
}