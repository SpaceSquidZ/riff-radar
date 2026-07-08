import { useState } from 'react';
import YouTubeMomentPicker from './YouTubeMomentPicker';

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

// Validates a single mm:ss timestamp (e.g. "3:20") or a range
// like "2:15-2:45" / "2:15 - 2:45".
function isValidTimestamp(value) {
  const trimmed = value.trim();
  const single = /^\d{1,2}:\d{2}$/;
  const range = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/;
  return single.test(trimmed) || range.test(trimmed);
}

// Strips any trailing period(s) from a field before we insert our own
// punctuation. Artist/song names occasionally end in a period themselves
// (e.g. "Bolden."), which previously produced "Bolden.." once the template
// added its own period. This normalizes any field to have no trailing
// punctuation, so we can always add exactly one closing mark ourselves.
function stripTrailingPunctuation(value) {
  return value.trim().replace(/[.!?]+$/, '');
}

// Builds the message actually sent to Groove as the opening line of the
// conversation. Two changes from the original version:
//   1. Trailing punctuation on song/artist/description is normalized so we
//      never end up with doubled periods.
//   2. The closing "find me more music like this" now sits on its own
//      paragraph (a blank line, markdown-style) instead of running directly
//      into the description with no separator — both for how it reads to a
//      human in the chat UI, and so Groove sees a clearly separated request
//      rather than one long run-on sentence.
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

export default function MomentForm({ onSubmit }) {
  // Picked once per form mount, not on every render, so the placeholder
  // doesn't change while someone is still typing.
  const [example] = useState(getRandomExample);

  const [song, setSong] = useState('');
  const [artist, setArtist] = useState('');
  const [timestamp, setTimestamp] = useState('');
  const [whatCaughtYou, setWhatCaughtYou] = useState('');
  const [error, setError] = useState('');

  // True once a YouTube video has been loaded, used to switch to the
  // side-by-side (video left, fields right) layout.
  const [videoLoaded, setVideoLoaded] = useState(false);

  // True if song/artist were just auto-filled from a YouTube title guess
  // and haven't been touched by the user yet — used to show a visible
  // "double check this" treatment rather than presenting a guess as fact.
  const [songIsGuess, setSongIsGuess] = useState(false);
  const [artistIsGuess, setArtistIsGuess] = useState(false);

  function handleTitleGuessed({ artist: guessedArtist, song: guessedSong }) {
    // Only fill fields the user hasn't already typed something into,
    // so we never silently overwrite something they entered themselves.
    if (!song.trim()) {
      setSong(guessedSong);
      setSongIsGuess(true);
    }
    if (!artist.trim()) {
      setArtist(guessedArtist);
      setArtistIsGuess(true);
    }
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

    const formattedMessage = buildFormattedMessage({ song, artist, timestamp, whatCaughtYou });

    onSubmit({
      song: song.trim(),
      artist: artist.trim(),
      timestamp: timestamp.trim(),
      whatCaughtYou: whatCaughtYou.trim(),
      formattedMessage,
    });
  }

  const fields = (
    <div>
      <div>
        <label htmlFor="song">
          Song title {songIsGuess && <span>(from the video title, double check this)</span>}
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

      <div>
        <label htmlFor="artist">
          Artist {artistIsGuess && <span>(from the video title, double check this)</span>}
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
        <p>
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

      {error && <p>{error}</p>}

      <button type="submit">Find me music like this</button>
    </div>
  );

  return (
    <form onSubmit={handleSubmit}>
      <h2>Describe a moment</h2>

      {!videoLoaded && (
        <div>
          <YouTubeMomentPicker
            onTimestampCaptured={setTimestamp}
            onTitleGuessed={handleTitleGuessed}
            onVideoLoadedChange={setVideoLoaded}
          />
          {fields}
        </div>
      )}

      {videoLoaded && (
        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 50%' }}>
            <YouTubeMomentPicker
              onTimestampCaptured={setTimestamp}
              onTitleGuessed={handleTitleGuessed}
              onVideoLoadedChange={setVideoLoaded}
            />
          </div>
          <div style={{ flex: '1 1 50%' }}>{fields}</div>
        </div>
      )}
    </form>
  );
}