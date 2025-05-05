import React, { useState } from 'react';
import axios from 'axios';
import './Chat.css';

export default function Chat() {
  const [input, setInput] = useState(''); // Track user input
  const [messages, setMessages] = useState([]); // Track conversation history

  const handleInputChange = (e) => {
    setInput(e.target.value);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim()) return; // Ignore empty input

    // Add user message to conversation
    const userMessage = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);

    try {
      // Send input to backend
      const response = await axios.post('http://localhost:3000/api/chat', {
        message: input,
      });

      // Add AI response to conversation
      const aiMessage = { role: 'assistant', content: response.data.response };
      setMessages((prev) => [...prev, aiMessage]);
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Error: Failed to get response' },
      ]);
    }

    setInput(''); // Clear input field
  };

  return (
    <>
      <div id="title">RFI Summarizer</div>
      <div id="chat-container">
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`message ${msg.role === 'user' ? 'user' : 'assistant'}`}
          >
            {msg.content}
          </div>
        ))}
      </div>
      <form id="chatbar" onSubmit={handleSubmit}>
        <input
          type="text"
          name="bar"
          id="bar"
          value={input}
          onChange={handleInputChange}
          placeholder="Type your message..."
        />
        <button type="submit" id="enter">
          Enter
        </button>
      </form>
    </>
  );
}