// api/chat.js
//
// Vercel serverless function. Takes a conversation history + session metadata,
// calls the Claude API with Groove's system prompt, and returns Groove's reply.
//
// Logs four event types to Supabase:
//   message_sent  — user and assistant messages (content_length, not content)
//   rec_generated — when Groove returns recommendations (with track titles)

import { GROOVE_BASE_PROMPT, getLoreAddendum } from '../src/groovePrompt.js';
import { logEvent } from '../src/supabaseClient.js';

// Parses track titles from Groove's markdown-formatted response.
// Looks for the Spotify search link format and extracts the query string,
// which Groove is instructed to format as "Track%20Name%20Artist".
function parseTracksFromReply(replyText) {
  const pattern = /open\.spotify\.com\/search\/([^\)"\s]+)/g;
  const matches = [...replyText.matchAll(pattern)];
  return matches.map((m) => decodeURIComponent(m[1].replace(/%20/g, ' ')));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, sessionCount = 0, sessionId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Log the user's incoming message (the last one in the array).
    const lastUserMessage = messages[messages.length - 1];
    if (sessionId && lastUserMessage?.role === 'user') {
      logEvent(sessionId, 'message_sent', {
        role: 'user',
        content_length: lastUserMessage.content.length,
      });
    }

    const loreAddendum = getLoreAddendum(sessionCount);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: GROOVE_BASE_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: loreAddendum || '(No lore addendum active yet — this is a new user.)',
          },
        ],
        messages: messages,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Anthropic API error:', response.status, errorBody);
      return res.status(response.status).json({ error: 'Claude API request failed' });
    }

    const data = await response.json();

    const replyText = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    // Log the assistant's reply.
    if (sessionId) {
      logEvent(sessionId, 'message_sent', {
        role: 'assistant',
        content_length: replyText.length,
      });

      // If the reply contains recommendation links, log rec_generated with
      // the actual track titles so we can see what Groove is recommending.
      const tracks = parseTracksFromReply(replyText);
      if (tracks.length > 0) {
        logEvent(sessionId, 'rec_generated', {
          recommendation_count: tracks.length,
          tracks,
        });
      }
    }

    return res.status(200).json({ reply: replyText });
  } catch (err) {
    console.error('Error in /api/chat:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}