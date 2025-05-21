import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import './Chat.css';

export default function Chat() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [stage, setStage] = useState('upload'); // 'upload' or 'chat'
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryAfter, setRetryAfter] = useState(null);
  const [showBaselineModal, setShowBaselineModal] = useState(false);
  const [baselineQuestions, setBaselineQuestions] = useState('');
  
  const fileInputRef = useRef(null);
  const chatContainerRef = useRef(null);

  // Scroll to bottom on new message
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [messages]);

  // Handle retry countdown
  useEffect(() => {
    if (retryAfter && isRetrying) {
      const timer = setInterval(() => {
        setRetryAfter((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            setIsRetrying(false);
            return null;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [retryAfter, isRetrying]);

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
    setStage('chat');
    setMessages([
      {
        role: 'assistant',
        content: 'Processing your RFI document... This may take a few moments.',
      },
    ]);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await axios.post('http://localhost:3000/api/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setMessages([
        {
          role: 'assistant',
          content: `I've analyzed your RFI document and extracted the following requirements:\n\n${response.data.summary}\n\nYou can now ask questions about the requirements or edit them by providing instructions.`,
        },
      ]);
    } catch (error) {
      console.error('Error uploading file:', error);
      setMessages([
        {
          role: 'assistant',
          content: 'Sorry, there was an error processing your file. Please try again.',
        },
      ]);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || isRetrying) return;

    const userMessage = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');

    try {
      console.log('Sending request to backend...');
      const response = await axios.post('http://localhost:3000/api/chat', {
        message: input,
      }, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000, // 10 second timeout
      });
      console.log('Received response:', response.data);

      const aiMessage = {
        role: 'assistant',
        content:
          response.data.type === 'edit'
            ? `Requirements updated:\n\n${response.data.operation.fullRequirements
                .map((req) => `- **${req.heading}**: ${req.description}`)
                .join('\n')}\n\nChanges made:\n${response.data.operation.type}\n\n${response.data.operation.requirements
                .map((req) => `- **${req.heading}**: ${req.description}`)
                .join('\n')}`
            : response.data.response,
      };
      setMessages((prev) => [...prev, aiMessage]);
      setRetryAfter(null);
    } catch (error) {
      console.error('Error details:', {
        message: error.message,
        code: error.code,
        response: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        } : 'No response',
        request: error.request ? 'Request was made but no response received' : 'No request was made',
        config: error.config ? {
          url: error.config.url,
          method: error.config.method,
          headers: error.config.headers,
          timeout: error.config.timeout
        } : 'No config'
      });

      if (error.response) {
        if (error.response.status === 429) {
          const retryTime = error.response.data.retryAfter || 10;
          setRetryAfter(retryTime);
          setIsRetrying(true);
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: `The AI service is currently busy. Please try again in ${retryTime} seconds.`,
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: `Error ${error.response.status}: ${error.response.data.message || 'An error occurred while processing your request.'}`,
            },
          ]);
        }
      } else if (error.request) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: 'The server is not responding. Please check if the backend server is running.',
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `Error: ${error.message || 'Unable to reach the server. Please check your connection and try again.'}`,
          },
        ]);
      }
    }
  };

  // Function to handle baseline questions modal
  const handleBaselineModal = () => {
    setShowBaselineModal(true);
  };

  // Function to handle saving baseline questions
  const handleSaveBaselineQuestions = () => {
    // Here you can add logic to save the questions if needed
    setShowBaselineModal(false);
  };

  // Render Baseline Questions Modal
  const renderBaselineModal = () => (
    <div className="modal-overlay" onClick={(e) => {
      if (e.target === e.currentTarget) setShowBaselineModal(false);
    }}>
      <div className="modal">
        <div className="modal-header">
          <h3>Baseline Questions</h3>
          <button className="close-btn" onClick={() => setShowBaselineModal(false)} aria-label="Close">
            ×
          </button>
        </div>
        <textarea
          value={baselineQuestions}
          onChange={(e) => setBaselineQuestions(e.target.value)}
          placeholder="Enter your baseline questions here, one per line..."
        />
        <div className="modal-actions">
          <button className="cancel-btn" onClick={() => setShowBaselineModal(false)}>
            Cancel
          </button>
          <button 
            className="save-btn" 
            onClick={handleSaveBaselineQuestions}
          >
            Save Questions
          </button>
        </div>
      </div>
    </div>
  );

  // Render Upload Page
  if (stage === 'upload') {
    return (
      <div className="upload-stage">
        <div id="title">RFI Assistant</div>
        <div className="upload-content">
          <h2>Upload your RFI Document</h2>
          <p>Upload the PDF file to get started with the RFI analysis</p>
          <div className="upload-area">
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
            <button 
              type="button" 
              className="baseline-button-upload" 
              onClick={handleBaselineModal}
            >
              Baseline Questions
            </button>
          </div>
        </div>
        {showBaselineModal && renderBaselineModal()}
      </div>
    );
  }

  // Render Chat Page
  return (
    <div className="chat-stage">
      <div id="title">RFI Assistant</div>
      <div id="chat-container" ref={chatContainerRef}>
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role === 'user' ? 'user' : 'assistant'}`}>
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
          placeholder={isRetrying ? `Please wait ${retryAfter} seconds...` : 'Ask a question or provide instructions to edit requirements...'}
          disabled={isRetrying}
        />
        <button type="submit" id="enter" disabled={isRetrying} aria-label="Submit">
        </button>
        <button type="button" id="baseline-button" onClick={handleBaselineModal}>
          Baseline Questions
        </button>
      </form>
      {showBaselineModal && renderBaselineModal()}
    </div>
  );
}