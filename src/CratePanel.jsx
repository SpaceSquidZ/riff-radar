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

function spotifySearchUrl(track, artist) {
  return `https://open.spotify.com/search/${encodeURIComponent(`${track} ${artist}`)}`;
}

export default function CratePanel({
  open,
  items,
  onOpen,
  onClose,
  onRemove,
  onTogglePlay,
  activePreviewKey,
  onOutboundClick,
}) {
  const count = items.length;

  return (
    <>
      {/* Always present, count badge only when there is something in it. */}
      <button
        type="button"
        className={`crate-tab${open ? ' crate-tab-open' : ''}`}
        onClick={open ? onClose : onOpen}
        aria-label={open ? 'Close crate' : `Open crate, ${count} saved`}
        aria-expanded={open}
      >
        <StarIcon filled={count > 0} />
        <span className="crate-tab-label">Crate</span>
        {count > 0 && <span className="crate-tab-count">{count}</span>}
      </button>

      {open && <div className="crate-scrim" onClick={onClose} aria-hidden="true" />}

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

                return (
                  <li className="crate-item" key={key}>
                    {item.artworkUrl ? (
                      <img className="crate-item-art" src={item.artworkUrl} alt="" loading="lazy" />
                    ) : (
                      <div className="crate-item-art crate-item-art-empty" aria-hidden="true" />
                    )}

                    <div className="crate-item-body">
                      <p className="crate-item-title">{item.track}</p>
                      <p className="crate-item-artist">{item.artist}</p>
                    </div>

                    <div className="crate-item-actions">
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