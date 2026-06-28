// api/chat.js
//
// Vercel serverless function. Takes a conversation history + new user message,
// calls the Claude API with Groove's system prompt (base + lore addendum),
// and returns Groove's response.
//
// Prompt caching: the large, static GROOVE_BASE_PROMPT is marked as a cache
// breakpoint so Claude only pays full input-token cost on the first call;
// repeated calls within the cache TTL reuse it at a steep discount. The
// per-user lore addendum is appended separately, uncached, since it varies.

import { GROOVE_BASE_PROMPT, getLoreAddendum } from '../src/groovePrompt.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, sessionCount = 0 } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
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

    // data.content is an array of blocks; for a plain text reply this is
    // typically a single block, but we join defensively in case of multiple.
    const replyText = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return res.status(200).json({ reply: replyText });
  } catch (err) {
    console.error('Error in /api/chat:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}