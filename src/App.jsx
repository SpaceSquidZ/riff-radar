import { useState, useEffect, useRef } from 'react';
import LandingScreen, { hasSeenLanding } from './LandingScreen';
import ConsentBanner, { hasSeenConsent } from './ConsentBanner';
import MomentForm from './MomentForm';
import MessageContent from './MessageContent';
import YouTubeMomentPicker from './YouTubeMomentPicker';
import RecommendationCard from './RecommendationCard';
import { getSessionId } from './sessionId';
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
  // The song the user actually bookmarked. Sent on EVERY turn so the server can
  // look up its real genre/year/artist and ground Groove in what the track
  // actually is, instead of letting it guess from a title that may collide with
  // a famous song of the same name.
  const [sourceTrack, setSourceTrack] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  // True from the moment a send starts until its stream fully finishes.
  // Used to disable the input/send button, so the user can't start a second
  // stream while one is still writing — the situation that produced empty
  // Groove bubbles with their text fused into a later turn.
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

  // Every event goes through here so the tester flag is attached automatically.
  // Relying on remembering to add it at each call site is how analytics data
  // quietly rots.
  function emit(eventType, payload = {}) {
    const sessionId = getSessionId();
    logEvent(sessionId, eventType, { ...payload, ...(isTester() ? { is_tester: true } : {}) });
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
    emit('session_start');
  }, []);

  // Targets a SPECIFIC message by its stable id, rather than "whatever is
  // last in the array right now".
  //
  // The old updateLastMessage() wrote to messages[length - 1], which was the
  // root cause of the empty-Groove-bubble bug: if the user sent a new message
  // while a stream was still in flight, "last" became the NEW assistant slot,
  // so the in-flight stream's remaining text (and its 'done' event, which
  // clears buildingRecs) landed in the wrong bubble. The original bubble
  // stayed empty and its "pulling a few records..." line never cleared.
  //
  // Keying on an id makes that structurally impossible: each stream only ever
  // writes to the message it created, no matter what else is added meanwhile.
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

    // Every assistant message gets a stable id at creation. This stream will
    // ONLY ever write to this id — see updateMessageById above.
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
          sessionCount: 0,
          sessionId,
          previousRecommendations,
          // Pass the override on the very first turn, because setSourceTrack
          // has not flushed to state yet at that point.
          sourceTrack: sourceTrackOverride || sourceTrack,
          isTester: isTester(),
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
            // Progressive reveal: each card arrives on its own as its iTunes
            // lookup resolves. Append it so the grid grows 0 -> 1 -> 2 -> 3.
            updateMessageById(assistantId, (msg) => ({
              ...msg,
              recs: [...(msg.recs || []), event.rec],
            }));
          } else if (event.type === 'done') {
            // recs already arrived via rec_ready; done just carries the
            // closing question and clears the "preparing" state.
            updateMessageById(assistantId, (msg) => ({
              ...msg,
              followUpQuestion: event.followUpQuestion || '',
              buildingRecs: false,
            }));
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
    // MomentForm already collects these as separate fields; we were only using
    // the formatted sentence and throwing the structured version away.
    const track = { track: moment.song, artist: moment.artist };
    setSourceTrack(track);

    // THE key funnel conversion event: someone got all the way through the form.
    // Everything before this is intent; this is the first real commitment.
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
    // Hard guard: never start a second stream while one is still running.
    // The UI also disables the button, but this covers Enter-key presses and
    // any other path into handleSend.
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
                  // Never render an assistant bubble with no content. This
                  // covers both the normal "waiting for the first token" case
                  // AND any bubble left empty by an interrupted stream —
                  // previously this only checked the LAST message, so an empty
                  // bubble stranded mid-conversation still rendered as a bare
                  // "Groove:" with nothing under it.
                  if (msg.role === 'assistant' && !msg.content) return null;

                  // Show the "preparing" line only while recs are coming AND
                  // none have arrived yet. Once the first rec_ready lands,
                  // the growing card grid replaces it. A plain text line
                  // (vs. 3 skeleton cards) can never look like it "dwindled"
                  // to 2, because it never promised a count.
                  const showPreparing =
                    msg.role === 'assistant' &&
                    msg.buildingRecs &&
                    (!msg.recs || msg.recs.length === 0);

                  return (
                    <div key={msg.id || i} className="chat-message">
                      <strong>{msg.role === 'user' ? 'You' : 'Groove'}:</strong>
                      <MessageContent content={msg.content} />

                      {showPreparing && (
                        <p className="rec-preparing-line">Groove is pulling a few records...</p>
                      )}

                      {msg.role === 'assistant' && msg.recs && msg.recs.length > 0 && (
                        <>
                          <div className="rec-grid">
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
                  );
                })}
                {loading && <p style={{ opacity: 0.6 }}>{loadingMessage}</p>}

                {/* Input and Send are disabled while a reply is streaming —
                    same pattern as ChatGPT/Claude. This is the UX half of the
                    empty-bubble fix: it prevents the user from starting a
                    second stream mid-reply. (updateMessageById is the
                    correctness half — it makes cross-turn writes impossible
                    even if a second stream somehow started.) */}
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