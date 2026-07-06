import { useState } from 'react';

// Three rotating Part 2 versions — Groove-voiced, varying in tone.
// One is picked randomly on each first-session load.
const GROOVE_LINES = [
  `"I've been collecting these for a long time. Moments in songs that do something you can't quite name. Tell me about one of yours."`,
  `"I hear music differently than most people. Tell me about a moment that caught you, and I'll show you what I mean."`,
  `"You know that part of a song where something just hits different? Tell me about it. I'll find you more music that does the same thing."`,
];

function getRandomLine() {
  return GROOVE_LINES[Math.floor(Math.random() * GROOVE_LINES.length)];
}

// Landing screen shown once per phase on first session.
// Stores dismissal in localStorage so it only appears once
// until the next phase milestone (handled in Week 6).
const STORAGE_KEY = 'riff_radar_landing_seen';

export function hasSeenLanding() {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function markLandingSeen() {
  localStorage.setItem(STORAGE_KEY, 'true');
}

export default function LandingScreen({ onEnter }) {
  const [grooveLine] = useState(getRandomLine);

  function handleEnter() {
    markLandingSeen();
    onEnter();
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      maxWidth: '600px',
      margin: '0 auto',
      textAlign: 'center',
      gap: '2rem',
    }}>
      <h1 style={{ fontSize: '2.5rem', fontWeight: 700, margin: 0 }}>
        Riff Radar
      </h1>

      <p style={{ fontSize: '1.1rem', lineHeight: 1.6, margin: 0, opacity: 0.8 }}>
        Riff Radar is a music companion. Tell Groove about a moment in a song
        you love, and he'll find you more music like it.
      </p>

      <p style={{
        fontSize: '1rem',
        lineHeight: 1.7,
        margin: 0,
        fontStyle: 'italic',
        opacity: 0.9,
      }}>
        {grooveLine}
      </p>

      <button
        onClick={handleEnter}
        style={{
          fontSize: '1rem',
          padding: '0.75rem 2rem',
          cursor: 'pointer',
          marginTop: '0.5rem',
        }}
      >
        Tell Groove about a moment →
      </button>
    </div>
  );
}