import ReactMarkdown from 'react-markdown';
import { getSessionId } from './sessionId';
import { logEvent } from './supabaseClient';

// Renders a chat message's content as real markdown (bold, links, dividers)
// instead of raw text. Links get a custom click handler that logs an
// outbound_click event before letting the browser navigate normally.

// Extracts a clean track name from a Spotify search URL.
// e.g. "https://open.spotify.com/search/In%20My%20Room%20Frank%20Ocean"
// becomes "In My Room Frank Ocean"
function extractTrackFromUrl(href) {
  try {
    const url = new URL(href);
    if (url.hostname === 'open.spotify.com') {
      const parts = url.pathname.split('/search/');
      if (parts[1]) return decodeURIComponent(parts[1].replace(/%20/g, ' '));
    }
  } catch {
    // malformed URL — fall through to returning the raw href
  }
  return href;
}

function handleLinkClick(href) {
  const sessionId = getSessionId();
  const service = href.includes('spotify') ? 'spotify' : 'apple_music';
  const track = extractTrackFromUrl(href);
  logEvent(sessionId, 'outbound_click', { service, track, url: href });
}

export default function MessageContent({ content }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => handleLinkClick(href)}
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}