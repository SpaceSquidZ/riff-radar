import { useState, useEffect } from 'react';
import LandingScreen, { hasSeenLanding } from './LandingScreen';
import ConsentBanner, { hasSeenConsent } from './ConsentBanner';
import MomentForm from './MomentForm';
import MessageContent from './MessageContent';
import YouTubeMomentPicker from './YouTubeMomentPicker';
import { getSessionId } from './sessionId';
import { logEvent } from './supabaseClient';

const LOADING_MESSAGES = [
  'Flipping through the shelf...',
  'Pulling a few records...',
  'Digging through the stacks...',
  'Cueing something up...',
  'Scanning the crates...',
];

function getRandomLoadingMessage() {
  return LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
}

// App owns four phases:
//   'landing'  — first-visit intro screen (skipped on return visits)
//   'form'     — moment input form
//   'chat'     — Groove conversation post-submission
//
// YouTubeMomentPicker lives here (not inside MomentForm) so the player
// survives the form-to-chat transition and stays visible post-submission.

export default function App() {
  // Determine initial phase: skip landing if already seen.
  const [phase, setPhase] = useState(hasSeenLanding() ? 'form' : 'landing');
  const [showConsent, setShowConsent] = useState(!hasSeenConsent());

  // YouTube state — owned here so the player survives phase transitions.
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [youtubeTimestamp, setYoutubeTimestamp] = useState('');
  const [titleGuess, setTitleGuess] = useState(null);

  // Chat state.
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');

  useEffect(() => {
    const sessionId = getSessionId();
    logEvent(sessionId, 'session_start');
  }, []);

  async function sendMessage(newMessages) {
    setLoading(true);
    setLoadingMessage(getRandomLoadingMessage());
    try {
      const sessionId = getSessionId();
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, sessionCount: 0, sessionId }),
      });
      const data = await response.json();
      setMessages([...newMessages, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setMessages([...newMessages, { role: 'assistant', content: 'Error: ' + err.message }]);
    } finally {
      setLoading(false);
    }
  }

  function handleMomentSubmit(moment) {
    const newMessages = [{ role: 'user', content: moment.formattedMessage }];
    setMessages(newMessages);
    setPhase('chat');
    sendMessage(newMessages);
  }

  function handleSend() {
    if (!input.trim()) return;
    const newMessages = [...messages, { role: 'user', content: input }];
    setMessages(newMessages);
    setInput('');
    sendMessage(newMessages);
  }

  // Landing screen — shown once per phase milestone.
  if (phase === 'landing') {
    return (
      <>
        <LandingScreen onEnter={() => setPhase('form')} />
        {showConsent && (
          <ConsentBanner onAccept={() => setShowConsent(false)} />
        )}
      </>
    );
  }

  return (
    <>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' }}>
        <h1>Riff Radar</h1>

        {/* YouTubeMomentPicker is rendered exactly once here, outside both
            phase conditionals, so React never unmounts it between phases.
            Visibility and layout are controlled via CSS, not conditional rendering. */}
        <div style={{
          display: 'flex',
          gap: '24px',
          alignItems: 'flex-start',
        }}>
          {/* Left column: YouTube picker — always in the DOM once videoLoaded,
              hidden entirely before a video is loaded in chat phase.
              position: sticky keeps the video visible while chat scrolls. */}
          <div style={{
            flex: '0 0 420px',
            display: (phase === 'chat' && !videoLoaded) ? 'none' : 'block',
            position: 'sticky',
            top: '1.5rem',
            alignSelf: 'flex-start',
          }}>
            <YouTubeMomentPicker
              onTimestampCaptured={setYoutubeTimestamp}
              onTitleGuessed={setTitleGuess}
              onVideoLoadedChange={setVideoLoaded}
              showControls={phase === 'form'}
            />
            {phase === 'chat' && videoLoaded && (
              <p style={{ fontSize: '0.8em', opacity: 0.6, marginTop: '8px' }}>
                Want to describe another moment from this video? Type it in the message box.
              </p>
            )}
          </div>

          {/* Right column: form or chat depending on phase */}
          <div style={{ flex: '1 1 0', minWidth: 0 }}>
            {phase === 'form' && (
              <>
                {!videoLoaded && (
                  <div style={{ marginBottom: '1rem' }}>
                    <h3 style={{ margin: '0 0 4px 0' }}>Type it yourself</h3>
                    <p style={{ fontSize: '0.85em', opacity: 0.7, margin: 0 }}>
                      Already know the moment? Fill in the details below.
                    </p>
                  </div>
                )}
                <MomentForm
                  onSubmit={handleMomentSubmit}
                  youtubeTimestamp={youtubeTimestamp}
                  videoLoaded={videoLoaded}
                  titleGuess={titleGuess}
                />
              </>
            )}

            {phase === 'chat' && (
              <div>
                {messages.map((msg, i) => (
                  <div key={i} style={{ marginBottom: '1rem' }}>
                    <strong>{msg.role === 'user' ? 'You' : 'Groove'}:</strong>
                    <MessageContent content={msg.content} />
                  </div>
                ))}
                {loading && <p style={{ opacity: 0.6 }}>{loadingMessage}</p>}

                <div style={{ marginTop: '1.5rem', display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                    placeholder="Type a message..."
                    style={{ flex: 1 }}
                  />
                  <button onClick={handleSend}>Send</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showConsent && phase !== 'landing' && (
        <ConsentBanner onAccept={() => setShowConsent(false)} />
      )}
    </>
  );
}