import { useState, useEffect, useRef } from 'react';
import ConsentPanel, { hasSeenConsent, hasDeclinedConsent } from './ConsentPanel';
import MessageContent from './MessageContent';
import RecommendationCard, { connectionLabel } from './RecommendationCard';
import HuntCard from './HuntCard';
import OpenerRecord from './OpenerRecord';
import InputTrackCard from './InputTrackCard';
import CratePanel from './CratePanel';
import { getSessionId } from './sessionId';
import {
  initSession,
  getDaysSeen,
  getVisitorId,
  getDaysSinceLast,
  markEngaged,
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
import { FIRST_CONTACT, ACQUIRE_MS, pickReturnGreeting } from './grooveOpeners';
import { pickOpenerPair } from './openerPairs';
import { crateKey, readCrate, writeCrate, toCrateItem } from './crate';
import { saveConversation, loadConversation } from './conversationPersistence';
import { installFacilitatorExport } from './facilitatorExport';
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
  // D-031 (rebuilt 2026-08-31 -- the July 2026 "closed" version still gated
  // the opener behind consent; see the Decision Log status note on D-031).
  // No landing phase, no form phase, no gate before the conversation. The
  // consent panel is a right-edge drawer (ConsentPanel.jsx), open by
  // default until read.
  //
  // Brief N, N-4: the opener SEQUENCE is now held until this is dismissed
  // (see the effects below) -- Jackie's call, and distinct from D-031's
  // gate. D-031 forbade blocking access to the conversation behind a
  // click; this doesn't block anything, it only sequences a presentation
  // the visitor cannot see anyway while the panel covers it. Without this,
  // a first-time visitor read a privacy notice while Groove's opener
  // played out unseen behind it.
  const [consentOpen, setConsentOpen] = useState(!hasSeenConsent());
  // Deliberately separate from consentOpen, which purely controls the
  // panel's own visibility. openerCanStart is what actually gates the
  // opener effect below. Splitting them matters for the mount-failure
  // guard a few lines down: it needs to unblock the opener if the panel
  // ever fails to RENDER, but it must never visually yank a panel a
  // genuinely slow reader still has open out from under them -- sharing
  // one flag for both would risk auto-closing their panel with no consent
  // decision recorded.
  const [openerCanStart, setOpenerCanStart] = useState(hasSeenConsent());
  // Set from ConsentPanel's own onMount, below. Lets the render-failure
  // guard distinguish "the panel never mounted" from "it mounted and is
  // just open," which a flat timer alone cannot do.
  const consentPanelMountedRef = useRef(false);

  // Roadmap v2 Wave 2 item 8 / Milestone 1 DoD: conversation persistence
  // across refresh (see conversationPersistence.js). Read once, lazily, on
  // first render -- same pattern as the crate's `useState(() => readCrate())`
  // below. Null unless there is an actual conversation to resume.
  const [restoredConversation] = useState(() => loadConversation());

  const [sourceTrack, setSourceTrack] = useState(() => restoredConversation?.sourceTrack ?? null);
  // Brief B, Change 1. Separate from sourceTrack on purpose: sourceTrack only
  // updates on a full track confirmation and still drives the "ON THE TABLE"
  // card; orbitArtist updates on EITHER an artist-only mention or a track
  // confirmation, whichever was most recent, and exists only to seed the
  // Last.fm pool server-side. See resolveSeedArtist in api/lib/lastfm.js.
  const [orbitArtist, setOrbitArtist] = useState(() => restoredConversation?.orbitArtist ?? null);

  const [messages, setMessages] = useState(() => restoredConversation?.messages ?? []);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const audioElRef = useRef(null);
  const [activePreviewKey, setActivePreviewKey] = useState(null);
  const loggedPreviewKeysRef = useRef(new Set());
  const inputRef = useRef(null);

  // The pair shown this session. Held in a ref so re-renders never reshuffle it
  // mid-conversation, which would rewrite a moment the user was part of.
  // Restored alongside messages: it's what opener_pair_id logging and the
  // API's openerPair field resolve against, and it isn't recoverable from
  // rendered message text alone.
  const openerPairRef = useRef(restoredConversation?.openerPair ?? null);
  // Guards the opener against running twice on mount. No longer gated on
  // consent -- the opener starts unconditionally (D-031, AC-1). Also true
  // on mount when a conversation was restored: the opener already ran in
  // the tab this session came from and must not run again.
  const openerStartedRef = useRef(!!restoredConversation);
  // True while the channel is pulling the next bubble in. Rendered as
  // acquisition, not as a typing indicator: the design note is that a loading
  // state should be answerable to "what part of the apparatus is this."
  const [acquiring, setAcquiring] = useState(false);
  // Brief M, P0-3, reverting Brief K 3b. Status text used to be carried
  // inline by the acquisition indicator, interleaved between bubbles -- it
  // wrapped mid-phrase, sat at low contrast, and collided with the
  // wordmark on first load. Replaced by a discrete sequence rendered once,
  // before any bubble, that stays on screen once complete (see
  // openerStatusLines below). The acquiring indicator itself goes back to
  // being label-less everywhere, first contact included.
  const [openerStatusLines, setOpenerStatusLines] = useState([]);

  // The crate. Session-scoped on purpose: it survives a refresh but not a new
  // day, which is what it is. Cross-session persistence needs accounts.
  const [crate, setCrate] = useState(() => readCrate());
  const [crateOpen, setCrateOpen] = useState(false);
  const [lastRemoved, setLastRemoved] = useState(null);
  // Counts only USER messages. Arc beats and pool asks are suppressed until
  // this reaches 2, so turn one is just the opener and one real exchange.
  // Derived from restored messages on resume, not reset to 0 -- a refresh on
  // real turn 3 must not report turn 1 to the server, which would wrongly
  // re-trigger first-exchange-only behavior (e.g. the turn-1 question rule).
  const userTurnCountRef = useRef(
    restoredConversation?.messages?.filter((m) => m.role === 'user').length ?? 0
  );

  useEffect(() => {
    const audio = new Audio();
    audio.addEventListener('ended', () => setActivePreviewKey(null));
    audioElRef.current = audio;
    return () => {
      audio.pause();
      audio.src = '';
    };
  }, []);

  // Brief K5, item 2. No visible control; see facilitatorExport.js.
  useEffect(() => installFacilitatorExport(), []);

  // Every event goes through here so the tester flag and visitor id are attached
  // automatically. visitor_id on EVERY event is what lets any session
  // definition be computed retroactively from created_at later.
  function emit(eventType, payload = {}) {
    // PRD v4.0 §9. Declining is a real opt-out, not a hidden card: checked
    // fresh from localStorage on every call (not from React state, which
    // could go stale across the session) and short-circuits BEFORE
    // logEvent -- nothing reaches Supabase once declined, not even this
    // event's own name.
    if (hasDeclinedConsent()) return;
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

  function handleTogglePlay(rec, source) {
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
      // `source` distinguishes a preview played off the opener from one played
      // off a recommendation. Without it, "listened and left" and "got recs and
      // left" are indistinguishable in the funnel, and they mean very different
      // things about whether the opener is working.
      emit('preview_played', {
        track: rec.track,
        artist: rec.artist,
        source: source || 'recommendation',
      });
    }
  }

  // Session accounting runs on mount regardless. Counting a visit does not
  // depend on whether the notice has been read.
  const sessionInfoRef = useRef(null);
  useEffect(() => {
    const info = initSession();
    sessionInfoRef.current = info;
    emit('session_start', {
      days_seen: info.daysSeen,
      days_since_last: info.daysSinceLast,
      is_new_day: info.isNewDay,
      is_returning: info.isReturning,
    });
  }, []);

  // Brief N, N-4 guard: if the consent panel is ever absent or fails to
  // RENDER, the opener must still start eventually rather than staying
  // blocked forever. Deliberately checks whether ConsentPanel.jsx actually
  // mounted (via consentPanelMountedRef, set from its own onMount below),
  // not a flat timer -- a flat timer can't distinguish "the panel never
  // rendered" from "a real visitor is genuinely still reading it," and
  // firing for the second case would defeat N-4's whole point (starting
  // the sequence invisibly behind a still-open panel) for exactly the
  // readers most engaged with the notice. 2s is far longer than this
  // simple a component takes to mount and far shorter than any plausible
  // reading time, so this can only fire on genuine render failure.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!consentPanelMountedRef.current) setOpenerCanStart(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // D-031, AC-1 still holds: no landing phase, no form phase, nothing
  // blocks ACCESS to the conversation behind a click. What changed (Brief
  // N, N-4) is that the opener SEQUENCE now waits for openerCanStart
  // before it stages anything -- not a re-gate, since nothing is
  // withheld: the sequence plays out unseen behind the panel otherwise,
  // and by the time a first-time visitor dismisses it, was already over.
  // openerCanStart starts true already for a returning visitor who
  // consented on a prior visit (hasSeenConsent() true) -- no wait at all
  // in that case, matching the brief exactly ("or immediately if consent
  // was already recorded on a previous visit").
  useEffect(() => {
    if (!openerCanStart) return;
    if (openerStartedRef.current) return;
    if (!sessionInfoRef.current) return;
    openerStartedRef.current = true;

    const { daysSinceLast, isReturning } = sessionInfoRef.current;
    const pair = pickOpenerPair();
    openerPairRef.current = pair;
    emit('opener_pair_shown', {
      pair_id: pair.id,
      is_first_contact: !isReturning,
    });

    // Staged, not dumped. The delays are part of the writing: the long gap
    // before the third bubble is what makes "I was waiting to see if you'd
    // speak first" literally true instead of a claim about a pause that never
    // happened. Rendering all four at once would have the interface lie.
    //
    // Each bubble is preceded by an acquisition state, so text resolves out of
    // the channel rather than appearing from nowhere.
    const timers = [];

    function pushBubble(id, text, withRecords) {
      setAcquiring(false);
      setMessages((prev) => [
        ...prev,
        {
          id,
          role: 'assistant',
          content: text,
          recs: [],
          openerTracks: withRecords ? pair.tracks : null,
          followUpQuestion: '',
          buildingRecs: false,
        },
      ]);
    }

    /**
     * Shows acquisition at `at`, resolves the bubble `acquireMs` later
     * (defaults to ACQUIRE_MS).
     */
    function schedule(at, id, text, withRecords, acquireMs = ACQUIRE_MS) {
      timers.push(setTimeout(() => setAcquiring(true), at));
      timers.push(
        setTimeout(() => pushBubble(id, text, withRecords), at + acquireMs)
      );
      return at + acquireMs;
    }

    if (!isReturning) {
      // Brief M, P0-3. A discrete sequence, staged before any bubble, that
      // stays on screen once complete rather than being carried inline by
      // the acquisition indicator (Brief K 3b, reverted -- it wrapped
      // mid-phrase and collided with the wordmark on first load). Sourced
      // from FIRST_CONTACT's own statusLabel fields so the three lines
      // have one home, not two. STATUS_LINE_MS matches K3b's own finding
      // that 600ms isn't long enough to read a two-word line.
      const STATUS_LINE_MS = 900;
      const statusLines = FIRST_CONTACT.map((b) => b.statusLabel).filter(Boolean);
      statusLines.forEach((line, i) => {
        timers.push(
          setTimeout(() => {
            setOpenerStatusLines((prev) => [...prev, line]);
          }, i * STATUS_LINE_MS)
        );
      });
      // Brief settle after the last line before Groove's own bubble timing
      // picks up beneath the sequence.
      let cursor = statusLines.length * STATUS_LINE_MS + 400;
      FIRST_CONTACT.forEach((bubble, i) => {
        cursor += bubble.delayMs;
        cursor = schedule(cursor, `opener-${i}`, bubble.text, !!bubble.showRecords);
      });
    } else {
      // The first-contact script only works once. Replaying it would have
      // Groove failing to remember the most significant thing that has ever
      // happened to him (Bible 0c).
      const greeting = pickReturnGreeting(daysSinceLast);
      let cursor = schedule(0, 'opener-0', greeting.text, false);
      schedule(cursor + 1400, 'opener-1', greeting.records, true);
    }

    return () => {
      timers.forEach(clearTimeout);
      setAcquiring(false);
    };
  }, [openerCanStart]);

  useEffect(() => {
    writeCrate(crate);
  }, [crate]);

  // Saves on every turn, including the opener's own staged bubbles, so a
  // refresh mid-opener also resumes cleanly rather than only after the first
  // real exchange. openerPairRef is a ref (not reactive) but is always set
  // before the first message that could exist, so reading it here is safe.
  useEffect(() => {
    saveConversation({
      messages,
      sourceTrack,
      orbitArtist,
      openerPair: openerPairRef.current,
    });
  }, [messages, sourceTrack, orbitArtist]);

  const savedKeys = new Set(crate.map(crateKey));

  // K5b. Derived from `messages` itself rather than a separate "shown" flag:
  // whichever assistant message is chronologically first to carry a labeled
  // (non-hunt) card is where the explainer renders, every render. That
  // guarantees exactly one appearance without any extra state to track, and
  // it survives a refresh for free since `messages` itself is now persisted
  // (see conversationPersistence.js) -- a restored session correctly finds
  // the same message it already found before the refresh, not a new one.
  const firstLabeledMessage = messages.find(
    (m) =>
      m.role === 'assistant' &&
      Array.isArray(m.recs) &&
      m.recs.some((r) => !r.isHunt && connectionLabel(r.connectionType))
  );

  function handleToggleSave(item, source = 'recommendation') {
    const key = crateKey(item);
    setCrate((prev) => {
      if (prev.some((c) => crateKey(c) === key)) {
        return prev.filter((c) => crateKey(c) !== key);
      }
      // Only saves are logged, not removes. A save is a signal about taste; a
      // remove is usually a correction and would just add noise to the funnel.
      emit('rec_marked', { track: item.track, artist: item.artist, source });
      return [...prev, toCrateItem(item, source)];
    });
  }

  // Removed items are held briefly so an accidental click can be undone. This
  // is a toast pattern rather than a permanent "recently removed" list: it
  // solves the actual problem (a misclick) without adding a second list the
  // drawer has to explain.
  const undoTimerRef = useRef(null);

  function handleRemoveFromCrate(item) {
    const key = crateKey(item);
    setCrate((prev) => prev.filter((c) => crateKey(c) !== key));
    setLastRemoved(item);

    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setLastRemoved(null), 6000);
  }

  function handleUndoRemove() {
    if (!lastRemoved) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setCrate((prev) => {
      // Guards against double-adding if they saved the same track again by
      // hand before hitting undo.
      if (prev.some((c) => crateKey(c) === crateKey(lastRemoved))) return prev;
      return [...prev, lastRemoved];
    });
    setLastRemoved(null);
  }

  function handleOpenCrate() {
    setCrateOpen(true);
    emit('crate_viewed', { track_count: crate.length });
  }

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

      // Strip the opener bubbles out of the history sent to the API.
      //
      // Two reasons. First, the Anthropic Messages API expects the first message
      // to be a user turn, and the opener is up to four consecutive assistant
      // messages before the user has said anything, which is malformed.
      //
      // Second, they carry no information anyway: the record titles render as
      // cards, so the text is "These are just what I had on" with nothing named.
      // The records reach Groove properly via openerPair in the system prompt,
      // where he can actually reason about them.
      const apiMessages = newMessages
        .filter((m) => !String(m.id || '').startsWith('opener-'))
        .map(({ role, content }) => ({ role, content }));

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          sessionId,
          previousRecommendations,
          sourceTrack: sourceTrackOverride || sourceTrack,
          orbitArtist,
          isTester: isTester(),

          // v2a progress context. daysSeen replaces sessionCount: gating is
          // distinct days now, per D-019.
          daysSeen: getDaysSeen(),
          daysSinceLast: getDaysSinceLast(),
          userTurnCount: userTurnCountRef.current,
          openerPair: openerPairRef.current,
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

            // Groove read a track out of what they typed and the server
            // verified it. Attaching it to the USER's message rather than his
            // reply puts the label next to the thing it describes.
            //
            // BUG THIS FIXES: this used to fire on every turn where the server
            // returned inputTrack at all, including turns where the track was
            // identical to what was already confirmed. Since Groove reports
            // inputTrack whenever a track is being discussed (not only when it
            // is newly named), a multi-turn conversation about the same song
            // showed the "ON THE TABLE" card again on every reply. The card
            // should mark a NEW confirmation, not restate an old one.
            const isSameAsCurrent =
              event.inputTrack &&
              sourceTrack &&
              event.inputTrack.track === sourceTrack.track &&
              event.inputTrack.artist === sourceTrack.artist;

            if (event.inputTrack && !isSameAsCurrent) {
              setSourceTrack({
                track: event.inputTrack.track,
                artist: event.inputTrack.artist,
              });
              const lastUserId = [...newMessages]
                .reverse()
                .find((m) => m.role === 'user')?.id;
              if (lastUserId) {
                updateMessageById(lastUserId, (msg) => ({
                  ...msg,
                  inputTrack: event.inputTrack,
                }));
              }
            }

            // Brief B, Change 1. The server already resolved this turn's
            // freshest named artist (requestedArtists, falling back to
            // inputTrack) against what we sent it, so just take its answer —
            // no comparison needed here the way sourceTrack's isSameAsCurrent
            // check above needs one, since the server itself already carries
            // the old value forward when nothing new was named this turn.
            if (event.orbitArtist) {
              setOrbitArtist(event.orbitArtist);
            }

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

  function handleSend() {
    if (!input.trim()) return;
    if (isStreaming) return;

    userTurnCountRef.current += 1;
    if (userTurnCountRef.current === 1) {
      // Marks this visitor as having actually talked to Groove, which is what
      // makes them "returning" next time. A page load alone must not spend the
      // first-contact script.
      markEngaged();
      emit('first_message_sent', {
        char_count: input.trim().length,
        opener_pair_id: openerPairRef.current?.id || null,
      });
    }

    const newMessages = [
      ...messages,
      { id: `u-${Date.now()}`, role: 'user', content: input },
    ];
    setMessages(newMessages);
    setInput('');
    sendMessage(newMessages);
  }

  // Tapping the label and fixing it is the whole reason the card is visible.
  // A guess the user cannot see is a guess they cannot correct.
  function handleInputTrackCorrect(messageId, corrected) {
    setSourceTrack(corrected);
    updateMessageById(messageId, (msg) => ({
      ...msg,
      inputTrack: { ...corrected, confidence: 'user_corrected' },
    }));
    emit('input_track_corrected', {
      track: corrected.track,
      artist: corrected.artist,
    });
  }

  // K1. Re-tappable: a mis-tap must be correctable, and correcting it logs a
  // SECOND event rather than silently overwriting the first -- the first
  // answer is the honest one and needs to stay recoverable. is_change is
  // keyed off the prior value already on the card, so a mis-tap-and-fix
  // produces exactly one is_change:true event, not a chain of them.
  function handleNoveltyReport(messageId, recIndex, novelty) {
    const msg = messages.find((m) => m.id === messageId);
    const rec = msg?.recs?.[recIndex];
    if (!rec) return;
    const isChange = rec.novelty != null && rec.novelty !== novelty;

    updateMessageById(messageId, (m) => ({
      ...m,
      recs: m.recs.map((r, idx) => (idx === recIndex ? { ...r, novelty } : r)),
    }));

    emit('rec_novelty_reported', {
      track: rec.track,
      artist: rec.artist,
      connection_type: rec.connectionType || null,
      surfaced_rank: rec._rank ?? null,
      novelty,
      is_change: isChange,
      is_hunt_card: !!rec.isHunt,
    });
  }

  function handleOutboundClick({ track, artist, service, url, source }) {
    emit('outbound_click', {
      track,
      artist,
      service,
      url,
      source: source || 'recommendation',
    });
    // Leaving FROM the crate is the batched exit the whole feature exists for,
    // so it is worth being able to separate from an impulse click mid-chat.
    if (source === 'crate') {
      emit('crate_link_clicked', { track, artist, service });
    }
    if (source === 'opener') {
      emit('opener_track_engaged', {
        pair_id: openerPairRef.current?.id || null,
        track,
        action: 'outbound',
      });
    }
  }

  return (
    <>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' }}>
        <h1 className="app-logo">Riff Radar</h1>

        <div className="app-layout">
          <div className="app-layout-content-col">
            {/* D-031: no landing phase, this always renders -- the vestigial
                `phase === 'chat'` gate (phase never left its initial value,
                setPhase had no callers) is removed, not just satisfied. */}
              <div>
                {/* Brief M, P0-3. Discrete pre-bubble sequence, first contact
                    only (openerStatusLines only ever gets populated in the
                    !isReturning branch). Renders once, above the whole log,
                    and is never cleared -- it stays on screen as Groove's
                    bubbles accumulate beneath it. */}
                {openerStatusLines.length > 0 && (
                  <div className="opener-status-sequence" role="status">
                    {openerStatusLines.map((line, i) => (
                      <p key={i} className="opener-status-line">{line}</p>
                    ))}
                  </div>
                )}
                {messages.map((msg, i) => {
                  // Hide an assistant turn only when it carries NOTHING at all.
                  //
                  // This used to be `!msg.content`, which meant a turn whose
                  // text failed to arrive took its recommendation cards down
                  // with it: the user saw an empty gap rather than the cards
                  // that had already loaded. Text is the usual reason to
                  // render, but not the only one.
                  const hasNothing =
                    !msg.content &&
                    !(msg.recs && msg.recs.length > 0) &&
                    !(msg.openerTracks && msg.openerTracks.length > 0) &&
                    !msg.followUpQuestion &&
                    !msg.buildingRecs;
                  if (msg.role === 'assistant' && hasNothing) return null;

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
                        {msg.content && (
                          <div className="chat-bubble">
                            <MessageContent content={msg.content} />
                          </div>
                        )}

                        {msg.role === 'user' && msg.inputTrack && (
                          <InputTrackCard
                            inputTrack={msg.inputTrack}
                            onCorrect={(corrected) =>
                              handleInputTrackCorrect(msg.id, corrected)
                            }
                          />
                        )}

                        {showPreparing && (
                          <p className="rec-preparing-line">Groove is pulling a few records...</p>
                        )}

                        {msg.openerTracks && msg.openerTracks.length > 0 && (
                          <div className="opener-records">
                            {msg.openerTracks.map((t, j) => (
                              <OpenerRecord
                                key={`${msg.id}-op-${j}`}
                                record={t}
                                isPlaying={activePreviewKey === previewKeyFor(t)}
                                onTogglePlay={() => handleTogglePlay(t, 'opener')}
                                onOutboundClick={handleOutboundClick}
                                isSaved={savedKeys.has(crateKey(t))}
                                onToggleSave={(rec) => handleToggleSave(rec, 'opener')}
                              />
                            ))}
                          </div>
                        )}

                        {msg.role === 'assistant' && msg.recs && msg.recs.length > 0 && (
                          <>
                            {/* K5b. Placed with the first card set, not before it --
                                the line makes sense once there is something to
                                point at. Static and hand-written, never model text
                                (same reasoning as the opener script, D-030): a line
                                this load-bearing should not be left to paraphrase. */}
                            {firstLabeledMessage?.id === msg.id && (
                              <p className="rec-label-explainer">
                                I sort these by how they&apos;re connected, not by how they sound.
                              </p>
                            )}
                            <div className="rec-rows">
                              {msg.recs.map((rec, j) =>
                                rec.isHunt ? (
                                  <HuntCard
                                    key={`${msg.id || i}-${j}`}
                                    rec={rec}
                                    onOutboundClick={handleOutboundClick}
                                    isSaved={savedKeys.has(crateKey(rec))}
                                    onToggleSave={(r) => handleToggleSave(r, 'recommendation')}
                                    onNoveltyReport={(novelty) =>
                                      handleNoveltyReport(msg.id, j, novelty)
                                    }
                                  />
                                ) : (
                                  <RecommendationCard
                                    key={`${msg.id || i}-${j}`}
                                    rec={rec}
                                    isPlaying={activePreviewKey === previewKeyFor(rec)}
                                    onTogglePlay={() => handleTogglePlay(rec, 'recommendation')}
                                    onOutboundClick={handleOutboundClick}
                                    isSaved={savedKeys.has(crateKey(rec))}
                                    onToggleSave={(r) => handleToggleSave(r, 'recommendation')}
                                    onNoveltyReport={(novelty) =>
                                      handleNoveltyReport(msg.id, j, novelty)
                                    }
                                  />
                                )
                              )}
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
                {acquiring && (
                  <div className="chat-row chat-row-groove">
                    <div className="chat-avatar chat-avatar-groove" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="17" height="17">
                        <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.9" />
                        <circle cx="12" cy="12" r="6.2" fill="none" stroke="#16171d" strokeWidth="0.9" opacity="0.55" />
                        <circle cx="12" cy="12" r="3.6" fill="#16171d" opacity="0.75" />
                        <circle cx="12" cy="12" r="1.1" fill="currentColor" />
                      </svg>
                    </div>
                    <div className="chat-content">
                      <div className="signal-acquiring" role="status" aria-label="Incoming transmission">
                        <span /><span /><span /><span /><span /><span />
                      </div>
                    </div>
                  </div>
                )}

                {loading && <p style={{ opacity: 0.6 }}>{loadingMessage}</p>}

                <div className="chat-input-row" style={{ marginTop: '1.5rem' }}>
                  <div className="chat-input-wrap">
                    <textarea
                      ref={inputRef}
                      value={input}
                      rows={1}
                      onChange={(e) => {
                        setInput(e.target.value);
                        // Auto-grow: reset to 'auto' first so the box can SHRINK
                        // when text is deleted, not only expand.
                        const el = e.target;
                        el.style.height = 'auto';
                        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                      }}
                      onKeyDown={(e) => {
                        // Enter sends. Shift+Enter inserts a newline, matching
                        // the convention every chat app already uses, and only
                        // possible with a textarea in the first place.
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSend();
                          if (inputRef.current) inputRef.current.style.height = 'auto';
                        }
                      }}
                      placeholder={isStreaming ? 'Groove is replying...' : 'Type a message...'}
                      disabled={isStreaming}
                      className="chat-input"
                      style={{
                        opacity: isStreaming ? 0.6 : 1,
                        cursor: isStreaming ? 'not-allowed' : 'text',
                      }}
                    />
                    {/* Brief M, P0-6. Inside the field, right side, vertically
                        centred -- the messaging-app convention, and it
                        recovers width the separate button was costing on a
                        phone. */}
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={isStreaming || !input.trim()}
                      className="chat-send-btn"
                      aria-label="Send message"
                      title="Send"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                        <path d="M12 19V5M12 5l-6 6M12 5l6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
          </div>
        </div>

        {/* Required attribution under Apple's and Last.fm's terms, not
            decorative fine print -- 0.55 opacity read as arguably too faint
            to count as displayed; raised to 0.70. */}
        <div
          style={{
            margin: '1.5rem 0 0 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          {/* K4: Apple's terms require the "provided courtesy of iTunes" text
              AND promotional content sitting proximate to an official Apple
              badge asset, not a generic icon. The badge itself is a
              trademarked file Apple issues through its own marketing-tools
              site under license terms -- not something to reconstruct from
              scratch here. TEXT is shipped; the badge asset still needs to
              be sourced and dropped in next to it, e.g. as
              /public/badges/apple-music-badge.svg, then rendered here. */}
          <p style={{ fontSize: '0.75rem', opacity: 0.7, margin: 0 }}>
            Preview audio provided courtesy of iTunes.
          </p>

          {/* K4: Last.fm credit is blocked on written approval for BUTTON
              placement (clause 2.7), not yet answered. This text line is a
              separate, already-compliant attribution and stays as-is. The
              slot below is reserved for the approved button and must stay
              empty -- no substitute button -- until that approval lands. */}
          <p style={{ fontSize: '0.75rem', opacity: 0.7, margin: 0 }}>
            Recommendation data powered by AudioScrobbler from Last.fm.
          </p>
          {/* <LastFmAttributionButton /> -- slot, pending clause 2.7 */}
        </div>
      </div>

      <CratePanel
        open={crateOpen}
        items={crate}
        onOpen={handleOpenCrate}
        onClose={() => setCrateOpen(false)}
        onRemove={handleRemoveFromCrate}
        onTogglePlay={(item) => handleTogglePlay(item, 'crate')}
        activePreviewKey={activePreviewKey}
        onOutboundClick={handleOutboundClick}
        lastRemoved={lastRemoved}
        onUndoRemove={handleUndoRemove}
      />

      <ConsentPanel
        open={consentOpen}
        onMount={() => {
          consentPanelMountedRef.current = true;
        }}
        onClose={() => {
          setConsentOpen(false);
          // Brief N, N-4: a genuine dismissal (Accept, Decline, the close
          // button, or the scrim -- ConsentPanel.jsx calls onClose for all
          // four) unblocks the opener immediately, same tick as the panel
          // closing. No need to wait on the mount-failure guard above.
          setOpenerCanStart(true);
        }}
      />
    </>
  );
}