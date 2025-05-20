import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import './Chat.css';

export default function Chat() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  const chatContainerRef = useRef(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryAfter, setRetryAfter] = useState(null);

  // Function to scroll to bottom
  const scrollToBottom = () => {
    if (chatContainerRef.current) {
      const scrollOptions = {
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth'
      };
      chatContainerRef.current.scrollTo(scrollOptions);
    }
  };

  // Scroll to bottom whenever messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleInputChange = (e) => {
    setInput(e.target.value);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      alert('Please upload only PDF files.');
      return;
    }

    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await axios.post('http://localhost:3000/api/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      setMessages([
        {
          role: 'assistant',
          content: `I've analyzed your RFI document and extracted the following requirements:\n\n${response.data.summary}\n\nYou can now ask questions about the requirements or edit them by providing instructions.`
        }
      ]);
    } catch (error) {
      console.error('Error uploading file:', error);
      alert('Error uploading file. Please try again.');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');

    try {
      const response = await axios.post('http://localhost:3000/api/chat', {
        message: input,
      });

      const aiMessage = { 
        role: 'assistant', 
        content: response.data.type === 'edit' 
          ? `Requirements updated:\n\n${response.data.operation.type}\n\n${response.data.operation.requirements.map(req => `- **${req.heading}**: ${req.description}`).join('\n')}`
          : response.data.response 
      };
      setMessages(prev => [...prev, aiMessage]);
      setRetryAfter(null);
    } catch (error) {
      console.error('Error sending message:', error);
      
      if (error.response) {
        if (error.response.status === 429) {
          // Rate limit exceeded
          const retryTime = error.response.data.retryAfter || 10;
          setRetryAfter(retryTime);
          setMessages(prev => [
            ...prev,
            { 
              role: 'assistant', 
              content: `The AI service is currently busy. Please try again in ${retryTime} seconds.` 
            },
          ]);
          
          // Start countdown
          setIsRetrying(true);
          const timer = setInterval(() => {
            setRetryAfter(prev => {
              if (prev <= 1) {
                clearInterval(timer);
                setIsRetrying(false);
                return null;
              }
              return prev - 1;
            });
          }, 1000);
        } else {
          // Other API errors
          setMessages(prev => [
            ...prev,
            { 
              role: 'assistant', 
              content: error.response.data.message || 'An error occurred while processing your request.' 
            },
          ]);
        }
      } else {
        // Network or other errors
        setMessages(prev => [
          ...prev,
          { 
            role: 'assistant', 
            content: 'Unable to reach the server. Please check your connection and try again.' 
          },
        ]);
      }
    }
  };

  return (
    <div className="chat-stage">
      <div id="title">RFI Assistant</div>
      {messages.length === 0 ? (
        <div className="upload-stage">
          <div className="upload-content">
            <h2>Upload RFI Document</h2>
            <p>Upload a PDF file to analyze the RFI requirements.</p>
            <input
              type="file"
              accept=".pdf"
              onChange={handleFileUpload}
              ref={fileInputRef}
              style={{ display: 'none' }}
              id="file-upload"
            />
            <label htmlFor="file-upload" className="upload-button">
              {isUploading ? 'Uploading...' : 'Upload PDF'}
            </label>
          </div>
        </div>
      ) : (
        <>
          <div id="chat-container" ref={chatContainerRef}>
            {messages.map((msg, index) => (
              <div
                key={index}
                className={`message ${msg.role === 'user' ? 'user' : 'assistant'}`}
              >
                <ReactMarkdown>{msg.content}</ReactMarkdown>
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
              placeholder={isRetrying ? `Please wait ${retryAfter} seconds...` : "Ask a question or provide instructions to edit requirements..."}
              disabled={isRetrying}
            />
            <button 
              type="submit" 
              id="enter"
              disabled={isRetrying}
            >
            </button>
          </form>
        </>
      )}
    </div>
  );
}