import { useState, useEffect } from 'react';

// A pool of example moments spanning genres, from iconic to indie.
// One is picked at random each time the form loads, so the placeholder
// text doesn't always anchor on the same song. Purely cosmetic — these
// are never submitted, just shown as hints.
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

function stripTrailingPunctuation(value) {
  return value.trim().replace(/[.!?]+$/, '');
}

function buildFormattedMessage({ song, artist, timestamp, whatCaughtYou }) {
  const cleanSong = stripTrailingPunctuation(song);
  const cleanArtist = stripTrailingPunctuation(artist);
  const cleanDescription = stripTrailingPunctuation(whatCaughtYou);

  return (
    `I'm listening to ${cleanSong} by ${cleanArtist}. ` +
    `At ${timestamp.trim()}, ${cleanDescription}.` +
    `\n\nFind me more music like this.`
  );
}

// MomentForm no longer owns a YouTubeMomentPicker or any video-loaded state —
// App.jsx owns the single shared picker (left column) and passes down
// whatever the user captures there. Previously this component ALSO rendered
// its own internal YouTubeMomentPicker with its own separate state, which is
// what caused the duplicate "Watch this with me" picker to appear on screen:
// two independent pickers, each unaware of the other.
export default function MomentForm({ onSubmit, youtubeTimestamp, videoLoaded, titleGuess }) {
  const [example] = useState(getRandomExample);

  const [song, setSong] = useState('');
  const [artist, setArtist] = useState('');
  const [timestamp, setTimestamp] = useState('');
  const [whatCaughtYou, setWhatCaughtYou] = useState('');
  const [error, setError] = useState('');

  const [songIsGuess, setSongIsGuess] = useState(false);
  const [artistIsGuess, setArtistIsGuess] = useState(false);

  // When the YouTube picker (owned by App.jsx) captures a timestamp,
  // reflect it into this form's timestamp field.
  useEffect(() => {
    if (youtubeTimestamp) {
      setTimestamp(youtubeTimestamp);
    }
  }, [youtubeTimestamp]);

  // When App.jsx's picker guesses a title, fill song/artist here — but only
  // if the user hasn't already typed something themselves, so we never
  // silently overwrite a real entry with a guess.
  useEffect(() => {
    if (!titleGuess) return;
    if (!song.trim()) {
      setSong(titleGuess.song);
      setSongIsGuess(true);
    }
    if (!artist.trim()) {
      setArtist(titleGuess.artist);
      setArtistIsGuess(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleGuess]);

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

    const formattedMessage = buildFormattedMessage({ song, artist, timestamp, whatCaughtYou });

    onSubmit({
      song: song.trim(),
      artist: artist.trim(),
      timestamp: timestamp.trim(),
      whatCaughtYou: whatCaughtYou.trim(),
      formattedMessage,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="moment-form-card">
      <h2 className="moment-form-heading">Describe a moment</h2>
      {videoLoaded && (
        <p className="moment-form-hint">Pulled from the video on the left — check it over below.</p>
      )}

      <div className="moment-form-field">
        <label htmlFor="song">
          Song title{' '}
          {songIsGuess && <span className="moment-form-guess-tag">(from the video title, double check this)</span>}
        </label>
        <input
          id="song"
          type="text"
          value={song}
          onChange={(e) => {
            setSong(e.target.value);
            setSongIsGuess(false);
          }}
          placeholder={example.song}
        />
      </div>

      <div className="moment-form-field">
        <label htmlFor="artist">
          Artist{' '}
          {artistIsGuess && <span className="moment-form-guess-tag">(from the video title, double check this)</span>}
        </label>
        <input
          id="artist"
          type="text"
          value={artist}
          onChange={(e) => {
            setArtist(e.target.value);
            setArtistIsGuess(false);
          }}
          placeholder={example.artist}
        />
      </div>

      <div className="moment-form-field">
        <label htmlFor="timestamp">Timestamp (mm:ss, or a range like 2:15-2:45)</label>
        <input
          id="timestamp"
          type="text"
          value={timestamp}
          onChange={(e) => setTimestamp(e.target.value)}
          placeholder={example.timestamp}
        />
      </div>

      <div className="moment-form-field">
        <label htmlFor="whatCaughtYou">What caught you?</label>
        <p className="moment-form-subtext">
          Take your time with this part. The more specific you are, the
          further I can take this in directions you wouldn't expect.
        </p>
        <textarea
          id="whatCaughtYou"
          rows={4}
          value={whatCaughtYou}
          onChange={(e) => setWhatCaughtYou(e.target.value)}
          placeholder={example.whatCaughtYou}
        />
      </div>

      {error && <p className="moment-form-error">{error}</p>}

      <button type="submit" className="moment-form-submit">Find me music like this</button>
    </form>
  );
}