import { useState, useEffect, useRef } from 'react';
import LandingScreen, { hasSeenLanding } from './LandingScreen';
import ConsentBanner, { hasSeenConsent } from './ConsentBanner';
import MomentForm from './MomentForm';
import MessageContent from './MessageContent';
import YouTubeMomentPicker from './YouTubeMomentPicker';
import RecommendationCard from './RecommendationCard';
import { getSessionId } from './sessionId';
import { logEvent } from './supabaseClient';
import './riff-radar.css';

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

// How long to wait with no new text arriving before showing the "building
// your three tracks" skeleton. Resets on every delta, so it only fires
// once the visible reply has genuinely stopped growing — this is the gap
// between "text finished streaming" and "cards arrived" (iTunes validation
// + occasional hallucination retry), which previously had zero feedback.
const SKELETON_DELAY_MS = 700;

export default function App() {
  const [phase, setPhase] = useState(hasSeenLanding() ? 'form' : 'landing');
  const [showConsent, setShowConsent] = useState(!hasSeenConsent());

  const [videoLoaded, setVideoLoaded] = useState(false);
  const [youtubeTimestamp, setYoutubeTimestamp] = useState('');
  const [titleGuess, setTitleGuess] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');

  // --- Shared audio player, used by every RecommendationCard on the page ---
  // One <audio> element total, not one per card. Fixes: pressing play on
  // card 2 previously had no way to know card 1's own <audio> was playing,
  // since each card managed playback independently.
  const audioElRef = useRef(null);
  const [activePreviewKey, setActivePreviewKey] = useState(null);
  const loggedPreviewKeysRef = useRef(new Set());

  useEffect(() => {
    const audio = new Audio();
    audio.addEventListener('ended', () => setActivePreviewKey(null));
    audioElRef.current = audio;
    return () => {
      audio.pause();
      audio.src = '';
    };
  }, []);

  function previewKeyFor(rec) {
    return `${rec.track}::${rec.artist}`;
  }

  function handleTogglePlay(rec) {
    const audio = audioElRef.current;
    if (!audio) return;
    const key = previewKeyFor(rec);

    if (activePreviewKey === key) {
      audio.pause();
      setActivePreviewKey(null);
      return;
    }

    audio.pause();
    audio.src = rec.previewUrl;
    audio.play();
    setActivePreviewKey(key);

    if (!loggedPreviewKeysRef.current.has(key)) {
      loggedPreviewKeysRef.current.add(key);
      const sessionId = getSessionId();
      logEvent(sessionId, 'preview_played', { track: rec.track, artist: rec.artist });
    }
  }

  useEffect(() => {
    const sessionId = getSessionId();
    logEvent(sessionId, 'session_start');
  }, []);

  function updateLastMessage(updater) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = updater(last);
      return next;
    });
  }

  async function sendMessage(newMessages) {
    setLoading(true);
    setLoadingMessage(getRandomLoadingMessage());

    setMessages([
      ...newMessages,
      { role: 'assistant', content: '', recs: [], followUpQuestion: '', buildingRecs: false },
    ]);

    let skeletonTimer = null;
    function scheduleSkeletonCheck() {
      clearTimeout(skeletonTimer);
      skeletonTimer = setTimeout(() => {
        updateLastMessage((msg) => ({ ...msg, buildingRecs: true }));
      }, SKELETON_DELAY_MS);
    }

    try {
      const sessionId = getSessionId();
      // newMessages may include assistant messages carrying UI-only fields
      // (recs, followUpQuestion, buildingRecs) attached after streaming.
      // Anthropic's API only accepts {role, content} per message and
      // rejects anything else with a 400 — strip down before sending.
      const apiMessages = newMessages.map(({ role, content }) => ({ role, content }));
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, sessionCount: 0, sessionId }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let firstDeltaReceived = false;

      scheduleSkeletonCheck(); // in case the model is slow before ANY text

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;

          let event;
          try {
            event = JSON.parse(line);
          } catch (err) {
            console.error('Failed to parse stream line:', line, err);
            continue;
          }

          if (event.type === 'delta') {
            if (!firstDeltaReceived) {
              firstDeltaReceived = true;
              setLoading(false);
            }
            updateLastMessage((msg) => ({ ...msg, content: msg.content + event.text }));
            scheduleSkeletonCheck(); // reset: still receiving text, not "done" yet
          } else if (event.type === 'done') {
            clearTimeout(skeletonTimer);
            updateLastMessage((msg) => ({
              ...msg,
              recs: event.recs || [],
              followUpQuestion: event.followUpQuestion || '',
              buildingRecs: false,
            }));
          } else if (event.type === 'error') {
            clearTimeout(skeletonTimer);
            updateLastMessage((msg) => ({
              ...msg,
              buildingRecs: false,
              content:
                msg.content ||
                'Groove hit a snag putting that together. Mind trying that message again?',
            }));
          }
        }
      }
    } catch (err) {
      clearTimeout(skeletonTimer);
      console.error('sendMessage failed:', err);
      updateLastMessage((msg) => ({
        ...msg,
        buildingRecs: false,
        content:
          msg.content ||
          'Groove hit a snag putting that together. Mind trying that message again?',
      }));
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

  function handleOutboundClick({ track, artist, service, url }) {
    const sessionId = getSessionId();
    logEvent(sessionId, 'outbound_click', { track, artist, service, url });
  }

  if (phase === 'landing') {
    return (
      <>
        <LandingScreen onEnter={() => setPhase('form')} />
        {showConsent && <ConsentBanner onAccept={() => setShowConsent(false)} />}
      </>
    );
  }

  return (
    <>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' }}>
        <h1>Riff Radar</h1>

        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
          <div
            style={{
              flex: '0 0 420px',
              display: phase === 'chat' && !videoLoaded ? 'none' : 'block',
              position: 'sticky',
              top: '1.5rem',
              alignSelf: 'flex-start',
            }}
          >
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
                {messages.map((msg, i) => {
                  const isStreamingPlaceholder =
                    msg.role === 'assistant' &&
                    i === messages.length - 1 &&
                    loading &&
                    msg.content === '';

                  if (isStreamingPlaceholder) return null;

                  const showSkeleton =
                    msg.role === 'assistant' &&
                    msg.buildingRecs &&
                    (!msg.recs || msg.recs.length === 0);

                  return (
                    <div key={i} className="chat-message">
                      <strong>{msg.role === 'user' ? 'You' : 'Groove'}:</strong>
                      <MessageContent content={msg.content} />

                      {showSkeleton && (
                        <div className="rec-skeleton-wrap">
                          <p className="rec-skeleton-label">Lining up your three tracks...</p>
                          <div className="rec-skeleton-grid">
                            <div className="rec-skeleton-card" />
                            <div className="rec-skeleton-card" />
                            <div className="rec-skeleton-card" />
                          </div>
                        </div>
                      )}

                      {msg.role === 'assistant' && msg.recs && msg.recs.length > 0 && (
                        <>
                          <div className="rec-grid">
                            {msg.recs.map((rec, j) => (
                              <RecommendationCard
                                key={`${i}-${j}`}
                                rec={rec}
                                isPlaying={activePreviewKey === previewKeyFor(rec)}
                                onTogglePlay={() => handleTogglePlay(rec)}
                                onOutboundClick={handleOutboundClick}
                              />
                            ))}
                          </div>

                          {msg.followUpQuestion && (
                            <p className="rec-followup">{msg.followUpQuestion}</p>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
                {loading && <p style={{ opacity: 0.6 }}>{loadingMessage}</p>}

                <div style={{ marginTop: '1.5rem', display: 'flex', gap: '8px', maxWidth: '640px' }}>
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