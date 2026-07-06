// api/chat.js
//
// Vercel serverless function. Takes a conversation history + session metadata,
// calls the Claude API with Groove's system prompt, and returns Groove's reply.
//
// Logs five event types to Supabase:
//   message_sent            — user and assistant messages (content_length, not content)
//   rec_generated            — when Groove returns recommendations (with track titles)
//   itunes_validation_failed — when a recommended track fails iTunes lookup (Week 5)

import { GROOVE_BASE_PROMPT, getLoreAddendum } from '../src/groovePrompt.js';
import { logEvent } from '../src/supabaseClient.js';
import { validateAndEnrichRecs } from './lib/validateTracks.js';

// Groove's prose still ends with the human-readable Spotify links (unchanged,
// keeps the voice/formatting rules in groovePrompt.js intact). In addition,
// per REC_METADATA_INSTRUCTION below, Groove appends one hidden JSON block
// with clean {track, artist} pairs so we can validate against iTunes without
// guessing where "Track Name Artist" splits in a decoded search-link string.
//
// Expected block, always the last thing in the reply:
//   <!--RIFF_RADAR_RECS:[{"track":"...","artist":"..."}, ...]-->
function extractStructuredRecs(replyText) {
  const match = replyText.match(/<!--RIFF_RADAR_RECS:(\[.*?\])-->/s);
  if (!match) return { recs: [], cleanedReply: replyText };

  let recs = [];
  try {
    recs = JSON.parse(match[1]);
  } catch (err) {
    console.error('Failed to parse RIFF_RADAR_RECS block:', err, match[1]);
  }

  // Strip the hidden block out before it ever reaches the user.
  const cleanedReply = replyText.replace(match[0], '').trimEnd();
  return { recs, cleanedReply };
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
        model: 'claude-sonnet-5',
        max_tokens: 1536,
        system: [
          {
            type: 'text',
            text: GROOVE_BASE_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
          {
            // REC_METADATA_INSTRUCTION: appended as its own cached-separately
            // block so it doesn't disturb the existing GROOVE_BASE_PROMPT
            // cache_control boundary. See groovePrompt.js Section
            // "Recommendation structure" for the human-facing format this
            // supplements, not replaces.
            type: 'text',
            text:
              (loreAddendum || '(No lore addendum active yet — this is a new user.)') +
              `\n\n# Machine-readable recommendation metadata (internal, never shown to the user)\n` +
              `Whenever your reply includes the 3-recommendation block, end your entire response ` +
              `with exactly one HTML comment on its own line, after everything else, in this exact format:\n` +
              `<!--RIFF_RADAR_RECS:[{"track":"Song Title","artist":"Artist Name"},{"track":"...","artist":"..."},{"track":"...","artist":"..."}]-->\n` +
              `This must contain exactly the 3 tracks you just recommended, in the same order, with the ` +
              `exact track and artist names (not URL-encoded, not abbreviated). Do not include this comment ` +
              `if your reply does not contain recommendations. This comment is stripped before the user sees ` +
              `your reply, so it does not need to fit your voice or formatting rules.`,
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

    // stop_reason 'max_tokens' means Claude got cut off mid-reply — usually
    // shows up as a truncated sentence and a missing RIFF_RADAR_RECS block.
    // Logging this makes a future max_tokens ceiling issue visible in Vercel
    // logs instead of just looking like "recs silently didn't show up."
    if (data.stop_reason === 'max_tokens') {
      console.warn('Groove reply was truncated by max_tokens. Consider raising the limit further.');
    }

    const rawReplyText = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const { recs, cleanedReply } = extractStructuredRecs(rawReplyText);
    let replyText = cleanedReply;
    let enrichedRecs = [];

    if (recs.length > 0) {
      enrichedRecs = await validateAndEnrichRecs(recs);

      const failed = enrichedRecs.filter((r) => r.itunesValidation === 'not_found');

      if (sessionId && failed.length > 0) {
        logEvent(sessionId, 'itunes_validation_failed', {
          failed_tracks: failed.map((r) => ({ track: r.track, artist: r.artist })),
          failed_count: failed.length,
          total_recs: recs.length,
        });
      }

      // One retry pass: ask Claude to replace only the failed tracks.
      // Capped at 1 pass so a stubborn genre cluster can't loop forever
      // (per PRD Automation 3 and the integration sketch in validateTracks.js).
      if (failed.length > 0) {
        const retryResult = await retryFailedRecs({
          messages,
          loreAddendum,
          failed,
          goodRecs: enrichedRecs.filter((r) => r.itunesValidation !== 'not_found'),
        });
        if (retryResult) {
          enrichedRecs = retryResult;
        }
      }
    }

    // Log the assistant's reply.
    if (sessionId) {
      logEvent(sessionId, 'message_sent', {
        role: 'assistant',
        content_length: replyText.length,
      });

      if (enrichedRecs.length > 0) {
        logEvent(sessionId, 'rec_generated', {
          recommendation_count: enrichedRecs.length,
          tracks: enrichedRecs.map((r) => `${r.track} - ${r.artist}`),
        });
      }
    }

    return res.status(200).json({ reply: replyText, recs: enrichedRecs });
  } catch (err) {
    console.error('Error in /api/chat:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Re-prompts Claude to replace only the tracks that failed iTunes validation,
// reusing the same conversation + system prompt. Silent to the user — this
// happens before any reply is returned. Returns null (caller keeps the
// original enrichedRecs, hallucinations and all) if the retry itself fails
// for any reason; we never want a retry-path bug to break the whole response.
async function retryFailedRecs({ messages, loreAddendum, failed, goodRecs }) {
  try {
    const retryInstruction = {
      role: 'user',
      content:
        `[internal, do not mention this message to the user] The following recommendations ` +
        `could not be verified against a real music catalog and must be replaced with different, ` +
        `real, existing tracks that fit the same match axis: ` +
        failed.map((r) => `"${r.track}" by ${r.artist}`).join(', ') +
        `. Keep these existing recommendations as-is: ` +
        goodRecs.map((r) => `"${r.track}" by ${r.artist}`).join(', ') +
        `. Respond with the full corrected 3-recommendation block in your normal voice and format, ` +
        `ending with the RIFF_RADAR_RECS metadata comment as instructed.`,
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1536,
        system: [
          { type: 'text', text: GROOVE_BASE_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: loreAddendum || '(No lore addendum active yet.)' },
        ],
        messages: [...messages, retryInstruction],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const rawReplyText = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const { recs: retriedRecs } = extractStructuredRecs(rawReplyText);
    if (retriedRecs.length === 0) return null;

    // Validate the retry once. If it still fails, we ship what we have —
    // no second retry loop.
    return await validateAndEnrichRecs(retriedRecs);
  } catch (err) {
    console.error('Retry-for-hallucination pass failed:', err);
    return null;
  }
}