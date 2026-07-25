import { useState, useEffect, useRef } from 'react';
import LandingScreen, { hasSeenLanding } from './LandingScreen';
import ConsentBanner, { hasSeenConsent } from './ConsentBanner';
import MomentForm from './MomentForm';
import MessageContent from './MessageContent';
import YouTubeMomentPicker from './YouTubeMomentPicker';
import RecommendationCard from './RecommendationCard';
import { getSessionId } from './sessionId';
import {
  initSession,
  getDaysSeen,
  getVisitorId,
  getDaysSinceLast,
} from './sessionCount';
import {
  getProgressContext,
  markArcBeatDelivered,
  markAskOffered,
  markAskAnswered,
  setPendingAsk,
  clearPendingAsk,
  agePendingAsk,
} from './loreProgress';
import { logEvent } from './supabaseClient';
import { isTester } from './isTester';
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
  const [sourceTrack, setSourceTrack] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

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

  // Every event goes through here so the tester flag and visitor id are attached
  // automatically. visitor_id on EVERY event is what lets any session
  // definition be computed retroactively from created_at later.
  function emit(eventType, payload = {}) {
    const sessionId = getSessionId();
    logEvent(sessionId, eventType, {
      ...payload,
      visitor_id: getVisitorId(),
      ...(isTester() ? { is_tester: true } : {}),
    });
  }

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
      emit('preview_played', { track: rec.track, artist: rec.artist });
    }
  }

  useEffect(() => {
    const { daysSeen, daysSinceLast, isNewDay, isReturning } = initSession();
    emit('session_start', {
      days_seen: daysSeen,
      days_since_last: daysSinceLast,
      is_new_day: isNewDay,
      is_returning: isReturning,
    });
  }, []);

  function updateMessageById(id, updater) {
    setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
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

  async function sendMessage(newMessages, sourceTrackOverride) {
    setLoading(true);
    setIsStreaming(true);
    setLoadingMessage(getRandomLoadingMessage());

    const previousRecommendations = collectPreviousRecommendations(newMessages);
    const assistantId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setMessages([
      ...newMessages,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        recs: [],
        followUpQuestion: '',
        buildingRecs: false,
      },
    ]);

    try {
      const sessionId = getSessionId();
      const apiMessages = newMessages.map(({ role, content }) => ({ role, content }));

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          sessionId,
          previousRecommendations,
          sourceTrack: sourceTrackOverride || sourceTrack,
          isTester: isTester(),

          // v2a progress context. daysSeen replaces sessionCount: gating is
          // distinct days now, per D-019.
          daysSeen: getDaysSeen(),
          daysSinceLast: getDaysSinceLast(),
          ...getProgressContext(),
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
            updateMessageById(assistantId, (msg) => ({
              ...msg,
              content: msg.content + event.text,
            }));
          } else if (event.type === 'recs_starting') {
            updateMessageById(assistantId, (msg) => ({ ...msg, buildingRecs: true }));
          } else if (event.type === 'rec_ready') {
            updateMessageById(assistantId, (msg) => ({
              ...msg,
              recs: [...(msg.recs || []), event.rec],
            }));
          } else if (event.type === 'done') {
            updateMessageById(assistantId, (msg) => ({
              ...msg,
              followUpQuestion: event.followUpQuestion || '',
              buildingRecs: false,
            }));

            // --- persist lore/arc/ask progress ---------------------------
            //
            // The server reports what it offered and what Groove said he
            // actually delivered. Marking an arc beat delivered is permanent,
            // so it only happens when Groove confirms the beat is present in
            // his visible reply. A false positive burns that beat forever.

            if (event.arcBeatId) {
              markArcBeatDelivered(event.arcBeatId);
              emit('arc_beat_delivered', { beat_id: event.arcBeatId });
            }

            if (event.askAnsweredId) {
              markAskAnswered(event.askAnsweredId);
              clearPendingAsk();
            } else {
              // Not answered this turn. Age it so it drops after one follow-up.
              agePendingAsk();
            }

            if (event.askOfferedId) {
              markAskOffered(event.askOfferedId);
              setPendingAsk(event.askOfferedId, event.askOfferedText);
            }
          } else if (event.type === 'error') {
            updateMessageById(assistantId, (msg) => ({
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
      updateMessageById(assistantId, (msg) => ({
        ...msg,
        buildingRecs: false,
        content:
          msg.content ||
          'Groove hit a snag putting that together. Mind trying that message again?',
      }));
    } finally {
      setLoading(false);
      setIsStreaming(false);
    }
  }

  function handleMomentSubmit(moment) {
    const newMessages = [
      { id: `u-${Date.now()}`, role: 'user', content: moment.formattedMessage },
    ];
    const track = { track: moment.song, artist: moment.artist };
    setSourceTrack(track);

    emit('moment_submitted', {
      has_timestamp: !!moment.timestamp,
      what_caught_you_length: moment.whatCaughtYou?.length ?? 0,
      used_youtube: !!videoLoaded,
    });

    setMessages(newMessages);
    setPhase('chat');
    sendMessage(newMessages, track);
  }

  function handleSend() {
    if (!input.trim()) return;
    if (isStreaming) return;
    const newMessages = [
      ...messages,
      { id: `u-${Date.now()}`, role: 'user', content: input },
    ];
    setMessages(newMessages);
    setInput('');
    sendMessage(newMessages);
  }

  function handleOutboundClick({ track, artist, service, url }) {
    emit('outbound_click', { track, artist, service, url });
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
        <h1 className="app-logo">Riff Radar</h1>

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
              <MomentForm
                onSubmit={handleMomentSubmit}
                youtubeTimestamp={youtubeTimestamp}
                videoLoaded={videoLoaded}
                titleGuess={titleGuess}
                onEvent={emit}
              />
            )}

            {phase === 'chat' && (
              <div>
                {messages.map((msg, i) => {
                  if (msg.role === 'assistant' && !msg.content) return null;

                  const showPreparing =
                    msg.role === 'assistant' &&
                    msg.buildingRecs &&
                    (!msg.recs || msg.recs.length === 0);

                  return (
                    <div
                      key={msg.id || i}
                      className={`chat-row ${msg.role === 'user' ? 'chat-row-user' : 'chat-row-groove'}`}
                    >
                      <div
                        className={`chat-avatar ${msg.role === 'user' ? 'chat-avatar-user' : 'chat-avatar-groove'}`}
                        aria-hidden="true"
                      >
                        {msg.role === 'user' ? (
                          <svg viewBox="0 0 24 24" width="16" height="16">
                            <circle cx="12" cy="8.5" r="3.8" fill="currentColor" />
                            <path
                              d="M4.5 20c0-3.8 3.4-6.2 7.5-6.2s7.5 2.4 7.5 6.2z"
                              fill="currentColor"
                            />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="17" height="17">
                            <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.9" />
                            <circle cx="12" cy="12" r="6.2" fill="none" stroke="#16171d" strokeWidth="0.9" opacity="0.55" />
                            <circle cx="12" cy="12" r="3.6" fill="#16171d" opacity="0.75" />
                            <circle cx="12" cy="12" r="1.1" fill="currentColor" />
                          </svg>
                        )}
                      </div>

                      <div className="chat-content">
                        <div className="chat-bubble">
                          <MessageContent content={msg.content} />
                        </div>

                        {showPreparing && (
                          <p className="rec-preparing-line">Groove is pulling a few records...</p>
                        )}

                        {msg.role === 'assistant' && msg.recs && msg.recs.length > 0 && (
                          <>
                            <div className="rec-rows">
                              {msg.recs.map((rec, j) => (
                                <RecommendationCard
                                  key={`${msg.id || i}-${j}`}
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
                    placeholder={isStreaming ? 'Groove is replying...' : 'Type a message...'}
                    disabled={isStreaming}
                    style={{
                      flex: 1,
                      fontSize: '16px',
                      opacity: isStreaming ? 0.6 : 1,
                      cursor: isStreaming ? 'not-allowed' : 'text',
                    }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={isStreaming || !input.trim()}
                    style={{
                      opacity: isStreaming || !input.trim() ? 0.5 : 1,
                      cursor: isStreaming || !input.trim() ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Send
                  </button>
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