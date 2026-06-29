import { useState } from 'react';

// Validates mm:ss format (e.g. "3:20", "0:45", "12:05")
function isValidTimestamp(value) {
  return /^\d{1,2}:\d{2}$/.test(value.trim());
}

export default function MomentForm({ onSubmit }) {
  const [song, setSong] = useState('');
  const [artist, setArtist] = useState('');
  const [timestamp, setTimestamp] = useState('');
  const [whatCaughtYou, setWhatCaughtYou] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(e) {
    e.preventDefault();

    if (!song.trim() || !artist.trim() || !timestamp.trim() || !whatCaughtYou.trim()) {
      setError('All fields are required.');
      return;
    }
    if (!isValidTimestamp(timestamp)) {
      setError('Timestamp should be in mm:ss format, like 3:20.');
      return;
    }

    setError('');

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
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>Describe a moment</h2>

      <div>
        <label htmlFor="song">Song title</label>
        <input id="song" type="text" value={song} onChange={(e) => setSong(e.target.value)} placeholder="Superposition" />
      </div>

      <div>
        <label htmlFor="artist">Artist</label>
        <input id="artist" type="text" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Daniel Caesar" />
      </div>

      <div>
        <label htmlFor="timestamp">Timestamp (mm:ss)</label>
        <input id="timestamp" type="text" value={timestamp} onChange={(e) => setTimestamp(e.target.value)} placeholder="3:20" />
      </div>

      <div>
        <label htmlFor="whatCaughtYou">What caught you?</label>
        <input id="whatCaughtYou" type="text" value={whatCaughtYou} onChange={(e) => setWhatCaughtYou(e.target.value)} placeholder="the vocal stack that blooms open" />
      </div>

      {error && <p>{error}</p>}

      <button type="submit">Find me music like this</button>
    </form>
  );
}