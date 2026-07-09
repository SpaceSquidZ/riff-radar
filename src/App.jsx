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

  function collectPreviousRecommendations(msgs) {
    const seen = new Set();
    const list = [];
    for (const msg of msgs) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.recs)) continue;
      for (const rec of msg.recs) {
        const key = `${rec.track}::${rec.artist}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ track: rec.track, artist: rec.artist });
        }
      }
    }
    return list;
  }

  async function sendMessage(newMessages) {
    setLoading(true);
    setLoadingMessage(getRandomLoadingMessage());

    const previousRecommendations = collectPreviousRecommendations(newMessages);

    setMessages([
      ...newMessages,
      { role: 'assistant', content: '', recs: [], followUpQuestion: '', buildingRecs: false },
    ]);

    try {
      const sessionId = getSessionId();
      const apiMessages = newMessages.map(({ role, content }) => ({ role, content }));
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          sessionCount: 0,
          sessionId,
          previousRecommendations,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let firstDeltaReceived = false;

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
          } else if (event.type === 'recs_starting') {
            updateLastMessage((msg) => ({ ...msg, buildingRecs: true }));
          } else if (event.type === 'done') {
            updateLastMessage((msg) => ({
              ...msg,
              recs: event.recs || [],
              followUpQuestion: event.followUpQuestion || '',
              buildingRecs: false,
            }));
          } else if (event.type === 'error') {
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

  const videoColStyle = phase === 'chat' && !videoLoaded ? { display: 'none' } : undefined;

  return (
    <>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' }}>
        <h1>Riff Radar</h1>

        <div className="app-layout">
          <div className="app-layout-video-col" style={videoColStyle}>
            <YouTubeMomentPicker
              onTimestampCaptured={setYoutubeTimestamp}
              onTitleGuessed={setTitleGuess}
              onVideoLoadedChange={setVideoLoaded}
            />
            {phase === 'chat' && videoLoaded && (
              <p style={{ fontSize: '0.8em', opacity: 0.6, marginTop: '8px' }}>
                Want to describe another moment from this video? Type it in the message box.
              </p>
            )}
          </div>

          <div className="app-layout-content-col">
            {phase === 'form' && (
              <>
                {!videoLoaded && (
                  <p className="section-intro-line">
                    Already know the song? Fill it in below.
                  </p>
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
                          <p className="rec-skeleton-label">Lining up your tracks...</p>
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
                    style={{ flex: 1, fontSize: '16px' }}
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