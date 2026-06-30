// api/chat.js
//
// Vercel serverless function. Takes a conversation history + new user message,
// calls the Claude API with Groove's system prompt (base + lore addendum),
// and returns Groove's response.
//
// Also logs message_sent (for the user's incoming message) and
// rec_generated (if Groove's reply contains recommendation links) to
// Supabase, per Week 4's instrumentation plan.
//
// Prompt caching: the large, static GROOVE_BASE_PROMPT is marked as a cache
// breakpoint so Claude only pays full input-token cost on the first call;
// repeated calls within the cache TTL reuse it at a steep discount. The
// per-user lore addendum is appended separately, uncached, since it varies.

import { GROOVE_BASE_PROMPT, getLoreAddendum } from '../src/groovePrompt.js';
import { logEvent } from '../src/supabaseClient.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, sessionCount = 0, sessionId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Log the user's incoming message (the last one in the array, since
    // the frontend sends the full history with the new message appended).
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
            cache_control: { type: 'ephemeral' }, // cache breakpoint — static across all calls
          },
          {
            type: 'text',
            text: loreAddendum || '(No lore addendum active yet — this is a new user.)',
            // intentionally NOT cached: this changes per-user / per-session-count
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

    // Log the assistant's reply, and separately log rec_generated if the
    // reply contains recommendation links (a rough heuristic: looks for
    // the Spotify search link format Groove is instructed to produce).
    if (sessionId) {
      logEvent(sessionId, 'message_sent', {
        role: 'assistant',
        content_length: replyText.length,
      });

      const spotifyLinkPattern = /open\.spotify\.com\/search\/([^\)]+)/g;
      const matches = [...replyText.matchAll(spotifyLinkPattern)];
      if (matches.length > 0) {
        logEvent(sessionId, 'rec_generated', {
          recommendation_count: matches.length,
        });
      }
    }

    return res.status(200).json({ reply: replyText });
  } catch (err) {
    console.error('Error in /api/chat:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}