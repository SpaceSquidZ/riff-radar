import { useState } from 'react';

// Week 2 test moment, per the roadmap: hard-code one opening message
// to confirm Groove responds with the correct 3-rec structure.
const TEST_MOMENT = "I love the vocal stack at 3:20 in Superposition by Daniel Caesar";

function App() {
  const [messages, setMessages] = useState([
    { role: 'user', content: TEST_MOMENT },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  async function sendMessage(newMessages) {
    setLoading(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, sessionCount: 0 }),
      });
      const data = await response.json();
      setMessages([...newMessages, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setMessages([...newMessages, { role: 'assistant', content: 'Error: ' + err.message }]);
    } finally {
      setLoading(false);
    }
  }

  function handleSend() {
    if (!input.trim()) return;
    const newMessages = [...messages, { role: 'user', content: input }];
    setMessages(newMessages);
    setInput('');
    sendMessage(newMessages);
  }

  // Send the hard-coded test moment on first load.
  const [hasSentInitial, setHasSentInitial] = useState(false);
  if (!hasSentInitial) {
    setHasSentInitial(true);
    sendMessage(messages);
  }

  return (
    <div>
      <h1>Riff Radar — Groove chat (test)</h1>

      <div>
        {messages.map((msg, i) => (
          <p key={i}>
            <strong>{msg.role === 'user' ? 'You' : 'Groove'}:</strong> {msg.content}
          </p>
        ))}
        {loading && <p>Groove is thinking...</p>}
      </div>

      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSend()}
        placeholder="Type a message..."
      />
      <button onClick={handleSend}>Send</button>
    </div>
  );
}

export default App;