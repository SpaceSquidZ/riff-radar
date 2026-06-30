import { useState, useEffect } from 'react';
import MomentForm from './MomentForm';
import MessageContent from './MessageContent';
import { getSessionId } from './sessionId';
import { logEvent } from './supabaseClient';

// In-character loading messages, shown while waiting on Groove's response.
// Picked randomly per request rather than reused every time.
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

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [momentSubmitted, setMomentSubmitted] = useState(false);

  // Log session_start exactly once, when the app first mounts.
  useEffect(() => {
    const sessionId = getSessionId();
    logEvent(sessionId, 'session_start');
  }, []);

  async function sendMessage(newMessages) {
    setLoading(true);
    setLoadingMessage(getRandomLoadingMessage());
    try {
      const sessionId = getSessionId();
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, sessionCount: 0, sessionId }),
      });
      const data = await response.json();
      setMessages([...newMessages, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setMessages([...newMessages, { role: 'assistant', content: 'Error: ' + err.message }]);
    } finally {
      setLoading(false);
    }
  }

  function handleMomentSubmit(moment) {
    setMomentSubmitted(true);
    const newMessages = [{ role: 'user', content: moment.formattedMessage }];
    setMessages(newMessages);
    sendMessage(newMessages);
  }

  function handleSend() {
    if (!input.trim()) return;
    const newMessages = [...messages, { role: 'user', content: input }];
    setMessages(newMessages);
    setInput('');
    sendMessage(newMessages);
  }

  return (
    <div>
      <h1>Riff Radar</h1>

      {!momentSubmitted && <MomentForm onSubmit={handleMomentSubmit} />}

      {momentSubmitted && (
        <div>
          {messages.map((msg, i) => (
            <div key={i}>
              <strong>{msg.role === 'user' ? 'You' : 'Groove'}:</strong>
              <MessageContent content={msg.content} />
            </div>
          ))}
          {loading && <p>{loadingMessage}</p>}

          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a message..."
          />
          <button onClick={handleSend}>Send</button>
        </div>
      )}
    </div>
  );
}

export default App;