// src/InputTrackCard.jsx
//
// The track Groove thinks the user brought him, rendered as a small hand-typed
// label rather than a form field.
//
// WHY THIS EXISTS
// Deleting the intake form (D-011) removed the only place the app learned which
// song the user meant, which killed source-track grounding. Groove now extracts
// it from free text and the server verifies it against the catalog, but a guess
// the user cannot see is a guess the user cannot correct. This is that surface.
//
// It is an ENHANCEMENT, never a requirement. No card appears when nobody named
// a track, which is common: someone reacting to an opener record, or arriving
// with a mood rather than a song, never sees one. It must never block a reply.
//
// Styled as an object handed across rather than a confirmation dialog, per the
// receiving-equipment frame in the design notes.

import { useState } from 'react';

export default function InputTrackCard({ inputTrack, onCorrect }) {
  const [editing, setEditing] = useState(false);
  const [track, setTrack] = useState(inputTrack.track);
  const [artist, setArtist] = useState(inputTrack.artist);

  // 'confirmed' means the catalog matched both title and artist. Anything else
  // is Groove's reading, unverified, and the user is the only one who can say.
  const verified = inputTrack.confidence === 'confirmed';

  function submit() {
    const t = track.trim();
    const a = artist.trim();
    if (!t || !a) return;
    setEditing(false);
    if (t !== inputTrack.track || a !== inputTrack.artist) {
      onCorrect?.({ track: t, artist: a });
    }
  }

  if (editing) {
    return (
      <div className="input-track-card input-track-card-editing">
        <span className="input-track-caption">What are we listening to?</span>
        <input
          className="input-track-field"
          value={track}
          onChange={(e) => setTrack(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Song"
          aria-label="Song title"
          autoFocus
        />
        <input
          className="input-track-field"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Artist"
          aria-label="Artist"
        />
        <div className="input-track-edit-actions">
          <button type="button" className="input-track-save" onClick={submit}>
            That's it
          </button>
          <button
            type="button"
            className="input-track-cancel"
            onClick={() => {
              setTrack(inputTrack.track);
              setArtist(inputTrack.artist);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`input-track-card${verified ? '' : ' input-track-card-unverified'}`}
      onClick={() => setEditing(true)}
      title="Not right? Tap to fix it."
      aria-label={`Playing ${inputTrack.track} by ${inputTrack.artist}. Tap to correct.`}
    >
      <span className="input-track-caption">
        {verified ? 'On the table' : 'Did you mean'}
      </span>
      <span className="input-track-title">{inputTrack.track}</span>
      <span className="input-track-artist">{inputTrack.artist}</span>
      {(inputTrack.year || inputTrack.genre) && (
        <span className="input-track-meta">
          {[inputTrack.year, inputTrack.genre].filter(Boolean).join(' \u00b7 ')}
        </span>
      )}
    </button>
  );
}