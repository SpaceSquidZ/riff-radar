import { useState, useEffect, useRef } from 'react';

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

export default function MomentForm({ onSubmit, youtubeTimestamp, videoLoaded, titleGuess, onEvent }) {
  const [example] = useState(getRandomExample);

  const [song, setSong] = useState('');
  const [artist, setArtist] = useState('');
  const [timestamp, setTimestamp] = useState('');
  const [whatCaughtYou, setWhatCaughtYou] = useState('');
  const [error, setError] = useState('');

  const [songIsGuess, setSongIsGuess] = useState(false);
  const [artistIsGuess, setArtistIsGuess] = useState(false);

  // Field-level instrumentation.
  //
  // The funnel currently only shows whether someone reached moment_submitted.
  // If they bail, we have no idea WHERE. That's the difference between knowing
  // "the form is a problem" and knowing "people get through song and artist and
  // then quit at 'what caught you'" — only the second one tells you what to fix.
  //
  // Each field fires ONCE, the first time it's filled in, so we can see how deep
  // people get before dropping off. Fired on blur rather than on every keystroke
  // to avoid flooding Supabase.
  const fieldsLogged = useRef(new Set());

  function logFieldFilled(fieldName, value) {
    if (!onEvent) return;
    if (!value.trim()) return;
    if (fieldsLogged.current.has(fieldName)) return;
    fieldsLogged.current.add(fieldName);
    onEvent('form_field_completed', {
      field: fieldName,
      // Order matters for reading the drop-off funnel later.
      field_order: ['song', 'artist', 'timestamp', 'whatCaughtYou'].indexOf(fieldName) + 1,
      // Length only, never the content. We want to know if people write one word
      // or three sentences in "what caught you", not to read what they wrote.
      value_length: value.trim().length,
      entered_via_youtube: fieldName === 'timestamp' ? !!youtubeTimestamp : undefined,
    });
  }

  // A timestamp marked in the YouTube player flows down as a prop. In that
  // path the timestamp is essentially FREE (you're already watching, you just
  // hit "mark"), which is exactly why requiring it manually was the expensive
  // ask and requiring it here is not.
  useEffect(() => {
    if (youtubeTimestamp) setTimestamp(youtubeTimestamp);
  }, [youtubeTimestamp]);

  // Song/artist guessed from the YouTube video title. Only fills fields the
  // user hasn't typed into, so we never silently overwrite their own input.
  useEffect(() => {
    if (!titleGuess) return;
    setSong((prev) => {
      if (prev.trim()) return prev;
      setSongIsGuess(true);
      return titleGuess.song || '';
    });
    setArtist((prev) => {
      if (prev.trim()) return prev;
      setArtistIsGuess(true);
      return titleGuess.artist || '';
    });
  }, [titleGuess]);

  function handleSubmit(e) {
    e.preventDefault();

    // TIMESTAMP IS NOW OPTIONAL.
    //
    // Groove cannot hear audio. It never actually consumes the timestamp as
    // data; everything it says about "that moment" is reconstructed from the
    // song it knows plus what the user wrote in "what caught you". The
    // timestamp was scaffolding that nudged people toward specificity, but it
    // was also the single most expensive field on the form: to fill it in
    // manually you have to go find the song, scrub to the moment, and note the
    // time before you can even start. That cost was turning people away at the
    // door. "What caught you" is the field that actually carries the signal,
    // so that stays required.
    if (!song.trim() || !artist.trim() || !whatCaughtYou.trim()) {
      setError('Song, artist, and what caught you are needed to get started.');
      // A user who hits a validation wall and gives up is invisible otherwise.
      onEvent?.('form_validation_failed', {
        reason: 'missing_required',
        missing: [
          !song.trim() && 'song',
          !artist.trim() && 'artist',
          !whatCaughtYou.trim() && 'whatCaughtYou',
        ].filter(Boolean),
      });
      return;
    }
    // Still validate the FORMAT if they did give us one.
    if (timestamp.trim() && !isValidTimestamp(timestamp)) {
      setError('Timestamp should be mm:ss (like 3:20) or a range (like 2:15-2:45).');
      onEvent?.('form_validation_failed', { reason: 'bad_timestamp_format' });
      return;
    }

    setError('');

    const hasTimestamp = !!timestamp.trim();
    const formattedMessage = hasTimestamp
      ? `I'm listening to ${song.trim()} by ${artist.trim()}. ` +
        `At ${timestamp.trim()}, ${whatCaughtYou.trim()} ` +
        `Find me more music like this.`
      : `I'm listening to ${song.trim()} by ${artist.trim()}. ` +
        `What caught me: ${whatCaughtYou.trim()} ` +
        `Find me more music like this.`;

    onSubmit({
      song: song.trim(),
      artist: artist.trim(),
      timestamp: timestamp.trim(), // may be empty
      whatCaughtYou: whatCaughtYou.trim(),
      formattedMessage,
    });
  }

  return (
    <form className="moment-form-card" onSubmit={handleSubmit}>
      <h2 className="moment-form-heading">Describe a moment</h2>

      <div className="moment-form-field">
        <label htmlFor="song">
          Song title{' '}
          {songIsGuess && (
            <span className="moment-form-guess-tag">(from the video title, double check this)</span>
          )}
        </label>
        <input
          id="song"
          type="text"
          value={song}
          onChange={(e) => {
            setSong(e.target.value);
            setSongIsGuess(false);
          }}
          onBlur={(e) => logFieldFilled('song', e.target.value)}
          placeholder={example.song}
        />
      </div>

      <div className="moment-form-field">
        <label htmlFor="artist">
          Artist{' '}
          {artistIsGuess && (
            <span className="moment-form-guess-tag">(from the video title, double check this)</span>
          )}
        </label>
        <input
          id="artist"
          type="text"
          value={artist}
          onChange={(e) => {
            setArtist(e.target.value);
            setArtistIsGuess(false);
          }}
          onBlur={(e) => logFieldFilled('artist', e.target.value)}
          placeholder={example.artist}
        />
      </div>

      <div className="moment-form-field">
        <label htmlFor="timestamp">Timestamp (optional)</label>
        <p className="moment-form-subtext">
          {videoLoaded
            ? 'Mark it in the video, or type it here. Skip it if you like.'
            : 'Only if you know it. mm:ss, or a range like 2:15-2:45.'}
        </p>
        <input
          id="timestamp"
          type="text"
          value={timestamp}
          onChange={(e) => setTimestamp(e.target.value)}
          onBlur={(e) => logFieldFilled('timestamp', e.target.value)}
          placeholder={example.timestamp}
        />
      </div>

      <div className="moment-form-field">
        <label htmlFor="whatCaughtYou">What caught you?</label>
        <p className="moment-form-subtext">
          Take your time with this part. The more specific you are, the further I
          can take this in directions you wouldn't expect.
        </p>
        <textarea
          id="whatCaughtYou"
          rows={4}
          value={whatCaughtYou}
          onChange={(e) => setWhatCaughtYou(e.target.value)}
          onBlur={(e) => logFieldFilled('whatCaughtYou', e.target.value)}
          placeholder={example.whatCaughtYou}
        />
      </div>

      {error && <p className="moment-form-error">{error}</p>}

      <button type="submit" className="moment-form-submit">
        Find me music like this
      </button>
    </form>
  );
}