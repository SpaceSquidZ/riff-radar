// src/CratePanel.jsx
//
// The crate drawer: what the user kept, and the single place they leave from.
//
// A DRAWER, NOT A COLUMN. The conversation is centred with a fixed max width
// (Option A in the layout decision), and a static side column would push it
// off-centre, which is the exact thing that looked wrong. The drawer opens over
// the conversation instead. That also suits the device split: on desktop it
// slides, on mobile it is the same drawer rather than a squeezed column.
//
// The tab is ALWAYS VISIBLE, even at zero. It is the only hint that saving is
// possible at all, and something that materialises the first time you save is
// something you had no reason to try.

import { useEffect, useRef, useState } from 'react';
import { connectionLabel } from './RecommendationCard';
import { HuntChart } from './HuntCard';
import { readCrateTabPosition, writeCrateTabPosition } from './crate';

function StarIcon({ filled }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M12 3.6l2.5 5.4 5.9.7-4.4 4 1.2 5.8L12 16.6 6.8 19.5 8 13.7l-4.4-4 5.9-.7L12 3.6z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlayIcon({ playing }) {
  return playing ? (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <rect x="7" y="6" width="3.5" height="12" rx="1" fill="currentColor" />
      <rect x="13.5" y="6" width="3.5" height="12" rx="1" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5-10-6.5z" fill="currentColor" />
    </svg>
  );
}

function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#1DB954" />
      <path
        d="M6.5 9.2c3.6-1 7.6-.7 10.6 1.1M7.2 12.2c3-.8 6.3-.5 8.8 1M7.9 15.1c2.4-.6 5-.4 7 .8"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function AppleMusicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="5" fill="#FA243C" />
      <path
        d="M15.5 6.4l-6 1.3v6.9a1.9 1.9 0 1 0 1.2 1.8V9.9l4.8-1v4.3a1.9 1.9 0 1 0 1.2 1.8V6.4z"
        fill="#fff"
      />
    </svg>
  );
}

// §4b, P1-4-adjacent: hunt items saved to the crate get all three of
// HuntCard's own search destinations, not just Spotify -- these two plus
// spotifySearchUrl below mirror HuntCard.jsx exactly (same icons, same
// search-URL shape), duplicated rather than shared per this file's existing
// convention (SpotifyIcon/AppleMusicIcon above are already a second copy of
// RecommendationCard's own icons, not imports of them).
function BandcampIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#1DA0C3" />
      <path d="M7 15.5h6.2L17 8.5h-6.2L7 15.5z" fill="#fff" />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <rect x="1" y="4.5" width="22" height="15" rx="4" fill="#FF0000" />
      <path d="M10 8.3v7.4l6.5-3.7L10 8.3z" fill="#fff" />
    </svg>
  );
}

function spotifySearchUrl(track, artist) {
  return `https://open.spotify.com/search/${encodeURIComponent(`${track} ${artist}`)}`;
}

function bandcampSearchUrl(track, artist) {
  return `https://bandcamp.com/search?q=${encodeURIComponent(`${track} ${artist}`)}`;
}

function youtubeSearchUrl(track, artist) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${track} ${artist}`)}`;
}

// §4b: the crate tab is draggable, vertically only, along the left edge.
// Pointer events rather than HTML5 drag-and-drop -- drag-and-drop's default
// ghost-image/drop-target model is built for moving an item INTO a target,
// not repositioning a fixed control, and it fights touch scrolling in ways
// pointer events don't once touch-action: none is set (see .crate-tab).
// 10px, not 5 -- 5 is a pointer-device number. An ordinary tap on a
// touchscreen routinely travels 3-8px before release, and a threshold that
// tight reads real taps as drags: the crate stops opening on a phone, which
// is worse than not having drag at all. 10px is the conventional touch
// slop.
const DRAG_THRESHOLD_PX = 10;
// Gap kept from the wordmark/input-area edges the tab clamps against -- not
// flush against either, so it never reads as touching them.
const EDGE_MARGIN_PX = 12;

export default function CratePanel({
  open,
  items,
  onOpen,
  onClose,
  onRemove,
  onTogglePlay,
  activePreviewKey,
  onOutboundClick,
  lastRemoved,
  onUndoRemove,
  wordmarkRef,
  inputAreaRef,
}) {
  const count = items.length;

  const tabRef = useRef(null);
  // The pointer sequence currently in progress, or null between drags.
  // Plain object in a ref rather than state -- nothing here needs to
  // trigger a render on its own; only the derived top (below) does.
  const dragRef = useRef(null);
  // Set true the instant a drag crosses DRAG_THRESHOLD_PX, so the click
  // event that naturally follows a pointerup can be told apart from a
  // genuine tap and suppressed -- see handleClick. Cleared by that same
  // click, not by pointerup, since the click always arrives after.
  const draggedRef = useRef(false);
  // null = "never dragged, use the default CSS position" (top: 50%
  // desktop, top: 90px mobile -- see riff-radar.css). Only ever becomes
  // non-null once the visitor actually drags the tab.
  const [tabTop, setTabTop] = useState(() => readCrateTabPosition());

  // Available drag range right now, in viewport pixels -- read live rather
  // than cached, since the wordmark and input area can both move (resize,
  // rotation, the textarea growing with typed text).
  function clampTop(top) {
    const tabHeight = tabRef.current?.offsetHeight || 0;
    const wordmarkBottom = wordmarkRef?.current?.getBoundingClientRect().bottom ?? 0;
    const inputTop = inputAreaRef?.current?.getBoundingClientRect().top ?? window.innerHeight;
    const min = wordmarkBottom + EDGE_MARGIN_PX;
    const max = Math.max(min, inputTop - tabHeight - EDGE_MARGIN_PX);
    return Math.min(Math.max(top, min), max);
  }

  // A position saved last session (or even earlier this one, before a
  // resize or rotation) can be stale against the CURRENT layout -- re-clamp
  // on mount and on every resize, so a saved position never leaves the tab
  // sitting on top of the wordmark or the input area. Safe to run
  // unconditionally: the functional update below is a no-op whenever
  // tabTop is still null (never dragged), which is when the default CSS
  // position applies and there is nothing here to correct.
  useEffect(() => {
    function reclamp() {
      setTabTop((prev) => (prev == null ? prev : clampTop(prev)));
    }
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePointerDown(e) {
    if (open) return; // opacity:0/pointer-events:none while open makes this
    // unreachable in practice, but guard explicitly rather than rely on CSS.
    const rect = tabRef.current.getBoundingClientRect();
    dragRef.current = { startY: e.clientY, startTop: rect.top, currentTop: rect.top };
    tabRef.current.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e) {
    const drag = dragRef.current;
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!draggedRef.current && Math.abs(dy) > DRAG_THRESHOLD_PX) {
      draggedRef.current = true;
    }
    if (draggedRef.current) {
      const next = clampTop(drag.startTop + dy);
      drag.currentTop = next;
      setTabTop(next);
    }
  }

  function handlePointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (draggedRef.current) {
      writeCrateTabPosition(drag.currentTop);
    }
  }

  // A cancelled pointer sequence (rare -- a system gesture interrupting,
  // for instance) is neither a completed drag nor a tap. Nothing gets
  // persisted, and draggedRef is set (not cleared) so that IF a click still
  // follows -- the pointer-events spec says it shouldn't after a cancel,
  // but this costs nothing to guard against -- handleClick treats it as a
  // drag to discard rather than as a tap that opens or closes the crate.
  function handlePointerCancel() {
    dragRef.current = null;
    draggedRef.current = true;
  }

  function handleClick() {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    (open ? onClose : onOpen)();
  }

  return (
    <>
      {/* Always present, count badge only when there is something in it. */}
      <button
        ref={tabRef}
        type="button"
        className={`crate-tab${open ? ' crate-tab-open' : ''}`}
        style={tabTop != null ? { top: `${tabTop}px`, transform: 'none' } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={handleClick}
        aria-label={open ? 'Close crate' : `Open crate, ${count} saved`}
        aria-expanded={open}
      >
        <StarIcon filled={count > 0} />
        <span className="crate-tab-label">Crate</span>
        {count > 0 && <span className="crate-tab-count">{count}</span>}
      </button>

      {open && <div className="crate-scrim" onClick={onClose} aria-hidden="true" />}

      {/* Not nested inside the drawer: a misclick should be recoverable even if
          the drawer gets closed right after, which is a natural thing to do
          right after removing something you meant to keep. */}
      {lastRemoved && (
        <div className="crate-undo-toast" role="status">
          <span className="crate-undo-text">Removed "{lastRemoved.track}"</span>
          <button type="button" className="crate-undo-button" onClick={onUndoRemove}>
            Undo
          </button>
        </div>
      )}

      <aside
        className={`crate-drawer${open ? ' crate-drawer-open' : ''}`}
        aria-hidden={!open}
      >
        <header className="crate-header">
          <h2 className="crate-title">The crate</h2>
          <button
            type="button"
            className="crate-close"
            onClick={onClose}
            aria-label="Close crate"
          >
            ×
          </button>
        </header>

        {count === 0 ? (
          <div className="crate-empty">
            <p>Nothing in here yet.</p>
            <p className="crate-empty-hint">
              Star anything worth keeping and it lands here. Open them all at
              once when you are done, rather than one at a time.
            </p>
          </div>
        ) : (
          <>
            <ul className="crate-list">
              {items.map((item) => {
                const key = `${item.track}::${item.artist}`;
                const isPlaying = activePreviewKey === key;
                const spotifyUrl = spotifySearchUrl(item.track, item.artist);
                // Only ever read for a hunt item (see crate-item-actions
                // below), but built unconditionally here alongside
                // spotifyUrl rather than inside a branch -- these two lines
                // cost nothing for a non-hunt item and keep every URL this
                // row might need built in one place.
                const bandcampUrl = bandcampSearchUrl(item.track, item.artist);
                const youtubeUrl = youtubeSearchUrl(item.track, item.artist);
                // K3d: connection labels carry through onto crate rows -- six
                // months later the label is the only record of why something
                // was kept. Same per-card-type pill logic as RecommendationCard
                // and HuntCard: hunt items never had a resolvable label to
                // begin with, so they get "Worth the dig" instead.
                const label = item.isHunt ? null : connectionLabel(item.connectionType);

                return (
                  <li className="crate-item" key={key}>
                    {/* §4b, P1-4-adjacent: a hunt item never had artwork to
                        begin with (D-037 -- there's no confirmed catalogue
                        entry to pull it from), so it used to fall through to
                        a blank grey square. The same chart mark HuntCard.jsx
                        shows on the actual card goes here instead -- same
                        object, same meaning, not a missing image. */}
                    {item.isHunt ? (
                      <div className="crate-item-art crate-item-art-hunt" aria-hidden="true">
                        <HuntChart />
                      </div>
                    ) : item.artworkUrl ? (
                      <img className="crate-item-art" src={item.artworkUrl} alt="" loading="lazy" />
                    ) : (
                      <div className="crate-item-art crate-item-art-empty" aria-hidden="true" />
                    )}

                    <div className="crate-item-body">
                      <div className="crate-item-header">
                        {/* No distant/"Far signal" label here (removed, not
                            hidden -- see .crate-pill-distant's removal in
                            riff-radar.css). item.distant itself is
                            untouched; this is a label removal, not a data
                            removal. Exactly one tag per row until the
                            tap-to-define treatment distant actually needs
                            lands (deferred, P2). */}
                        {item.isHunt && <span className="crate-pill crate-pill-hunt">Worth the dig</span>}
                        {label && <span className="crate-pill">{label}</span>}
                      </div>
                      <p className="crate-item-title">{item.track}</p>
                      <p className="crate-item-artist">{item.artist}</p>
                    </div>

                    <div className="crate-item-actions">
                      {/* §4b: hunt cards in the crate get all three of
                          HuntCard's own search destinations, structurally --
                          always exactly these three, in this order, never
                          conditional on which fields happen to be populated.
                          A hunt item never has a previewUrl or trackViewUrl
                          (D-037: nothing was ever confirmed to exist), so the
                          old conditional rendering below left it with only
                          the one unconditional Spotify link -- one button
                          where the card itself promises three. */}
                      {item.isHunt ? (
                        <>
                          <a
                            className="crate-item-link"
                            href={spotifyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() =>
                              onOutboundClick?.({
                                track: item.track,
                                artist: item.artist,
                                service: 'spotify',
                                url: spotifyUrl,
                                source: 'crate',
                              })
                            }
                            aria-label={`Search ${item.track} on Spotify`}
                            title="Spotify"
                          >
                            <SpotifyIcon />
                          </a>
                          <a
                            className="crate-item-link"
                            href={bandcampUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() =>
                              onOutboundClick?.({
                                track: item.track,
                                artist: item.artist,
                                service: 'bandcamp',
                                url: bandcampUrl,
                                source: 'crate',
                              })
                            }
                            aria-label={`Search ${item.track} on Bandcamp`}
                            title="Bandcamp"
                          >
                            <BandcampIcon />
                          </a>
                          <a
                            className="crate-item-link"
                            href={youtubeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() =>
                              onOutboundClick?.({
                                track: item.track,
                                artist: item.artist,
                                service: 'youtube',
                                url: youtubeUrl,
                                source: 'crate',
                              })
                            }
                            aria-label={`Search ${item.track} on YouTube`}
                            title="YouTube"
                          >
                            <YouTubeIcon />
                          </a>
                        </>
                      ) : (
                        <>
                          {item.previewUrl && (
                            <button
                              type="button"
                              className="crate-item-play"
                              onClick={() => onTogglePlay(item)}
                              aria-label={isPlaying ? 'Pause preview' : 'Play 30 second preview'}
                              title={isPlaying ? 'Pause' : '30s preview'}
                            >
                              <PlayIcon playing={isPlaying} />
                            </button>
                          )}

                          {item.trackViewUrl && (
                            <a
                              className="crate-item-link"
                              href={item.trackViewUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() =>
                                onOutboundClick?.({
                                  track: item.track,
                                  artist: item.artist,
                                  service: 'apple_music',
                                  url: item.trackViewUrl,
                                  source: 'crate',
                                })
                              }
                              aria-label={`Open ${item.track} in Apple Music`}
                              title="Apple Music"
                            >
                              <AppleMusicIcon />
                            </a>
                          )}

                          <a
                            className="crate-item-link"
                            href={spotifyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() =>
                              onOutboundClick?.({
                                track: item.track,
                                artist: item.artist,
                                service: 'spotify',
                                url: spotifyUrl,
                                source: 'crate',
                              })
                            }
                            aria-label={`Search ${item.track} on Spotify`}
                            title="Spotify"
                          >
                            <SpotifyIcon />
                          </a>
                        </>
                      )}

                      <button
                        type="button"
                        className="crate-item-remove"
                        onClick={() => onRemove(item)}
                        aria-label={`Remove ${item.track} from crate`}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* The honest limit, stated rather than discovered. Cross-session
                persistence needs accounts (November). */}
            <p className="crate-note">
              This crate lasts for tonight. Open what you want before you go.
            </p>
          </>
        )}
      </aside>
    </>
  );
}