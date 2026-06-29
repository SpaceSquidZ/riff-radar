import { useState } from 'react';
import MomentForm from './MomentForm';

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [momentSubmitted, setMomentSubmitted] = useState(false);

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
            <p key={i}>
              <strong>{msg.role === 'user' ? 'You' : 'Groove'}:</strong> {msg.content}
            </p>
          ))}
          {loading && <p>Groove is thinking...</p>}

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