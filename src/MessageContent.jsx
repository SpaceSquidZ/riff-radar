import ReactMarkdown from 'react-markdown';
import { getSessionId } from './sessionId';
import { logEvent } from './supabaseClient';

// Renders a chat message's content as real markdown (bold, links, dividers)
// instead of raw text. Links get a custom click handler that logs an
// outbound_click event before letting the browser navigate normally.

function handleLinkClick(href) {
  const sessionId = getSessionId();
  const service = href.includes('spotify') ? 'spotify' : 'apple_music';
  logEvent(sessionId, 'outbound_click', { service, url: href });
  // Don't preventDefault — let the link open normally in a new context.
  // Logging happens "fire and forget" alongside the navigation.
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