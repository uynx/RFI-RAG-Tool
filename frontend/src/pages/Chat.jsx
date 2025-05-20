// import React, { useState, useRef, useEffect } from 'react';
// import axios from 'axios';
// import ReactMarkdown from 'react-markdown';
// import './Chat.css';



// export default function Chat() {
//   const [input, setInput] = useState('');
//   const [messages, setMessages] = useState([]);
//   const [isUploading, setIsUploading] = useState(false);
//   const [stage, setStage] = useState('upload'); // 'upload' or 'chat'
//   const fileInputRef = useRef(null);
//   const chatContainerRef = useRef(null);
//   const [showBaselineModal, setShowBaselineModal] = useState(false);
//   const [baselineQuestions, setBaselineQuestions] = useState('');

//   // Function to scroll to bottom
//   const scrollToBottom = () => {
//     if (chatContainerRef.current) {
//       const scrollOptions = {
//         top: chatContainerRef.current.scrollHeight,
//         behavior: 'smooth'
//       };
//       chatContainerRef.current.scrollTo(scrollOptions);
//     }
//   };

//   // Scroll to bottom whenever messages change
//   useEffect(() => {
//     scrollToBottom();
//   }, [messages]);

//   const handleInputChange = (e) => {
//     setInput(e.target.value);
//   };

//   const handleFileUpload = async (e) => {
//     const file = e.target.files[0];
//     if (!file) return;

//     // Check if file is PDF
//     if (file.type !== 'application/pdf') {
//       alert('Please upload only PDF files.');
//       return;
//     }

//     setIsUploading(true);
//     const formData = new FormData();
//     formData.append('file', file);

//     try {
//       const response = await axios.post('http://localhost:3000/api/upload', formData, {
//         headers: {
//           'Content-Type': 'multipart/form-data',
//         },
//       });

//       setStage('chat');
      
//       // Add initial messages with the summary
//       setMessages([
//         {
//           role: 'assistant',
//           content: `I've analyzed your RFI document. Here is the outline for what a good submission should contain:\n\n${response.data.summary}\n\nYou can now ask me any questions about the document.`
//         }
//       ]);
//     } catch (error) {
//       console.error('Error uploading file:', error);
//       alert('Error uploading file. Please try again.');
//     } finally {
//       setIsUploading(false);
//       if (fileInputRef.current) {
//         fileInputRef.current.value = '';
//       }
//     }
//   };

//   const handleSubmit = async (e) => {
//     e.preventDefault();
//     if (!input.trim()) return;

//     const userMessage = { role: 'user', content: input };
//     setMessages((prev) => [...prev, userMessage]);

//     try {
//       const response = await axios.post('http://localhost:3000/api/chat', {
//         message: input,
//       });

//       const aiMessage = { role: 'assistant', content: response.data.response };
//       setMessages((prev) => [...prev, aiMessage]);
//     } catch (error) {
//       console.error('Error sending message:', error);
//       setMessages((prev) => [
//         ...prev,
//         { role: 'assistant', content: 'Error: Failed to get response' },
//       ]);
//     }

//     setInput('');
//   };
  

//   if (stage === 'upload') {
//     return (
//       <div className="upload-stage">
//         <div id="title">RFI Assistant</div>
//         <div className="upload-content">
//           <h2>Upload your RFI Document</h2>
//           <p>Upload the PDF file to get started with the RFI analysis</p>
//           <div className="upload-area">
//             <input
//               type="file"
//               id="file-upload"
//               accept=".pdf"
//               onChange={handleFileUpload}
//               ref={fileInputRef}
//               style={{ display: 'none' }}
//             />
//             <label htmlFor="file-upload" className="upload-button">
//               {isUploading ? 'Uploading...' : 'Upload PDF'}
//             </label>
//           </div>
//         </div>
//       </div>
//     );
//   }
  

//   return (
//     <div className="chat-stage">
//       <div id="title">RFI Assistant</div>
//       <div id="chat-container" ref={chatContainerRef}>
//         {messages.map((msg, index) => (
//           <div
//             key={index}
//             className={`message ${msg.role === 'user' ? 'user' : 'assistant'}`}
//           >
//             <ReactMarkdown>{msg.content}</ReactMarkdown>
//           </div>
//         ))}
//       </div>
//       <form id="chatbar" onSubmit={handleSubmit}>
//         <input
//           type="text"
//           name="bar"
//           id="bar"
//           value={input}
//           onChange={handleInputChange}
//           placeholder="Ask a question about the RFI..."
//         />
//         <button type="submit" id="enter">
//         </button>
//         <button
//           type="button"
//           id="baseline-button"
//           onClick={() => {openBaselineModel}}
//         >
//           Baseline Questions
//         </button>
//       </form>
        
//       {/* Baseline Questions Modal */}
//       {showBaselineModal && (
//         <div className="modal-overlay">
//           <div className="modal">
//             <div className="modal-header">
//               <h3>Baseline Questions</h3>
//               <button className="close-btn" onClick={() => setShowBaselineModal(false)}>×</button>
//             </div>
//             <textarea
//               value={baselineQuestions}
//               onChange={(e) => setBaselineQuestions(e.target.value)}
//               placeholder="Enter your baseline questions here..."
//             />
//           </div>
//         </div>
//       )}
      
      
//     </div>
//   );
// }
import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import './Chat.css';

export default function Chat() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [stage, setStage] = useState('upload'); // 'upload' or 'chat'
  const fileInputRef = useRef(null);
  const chatContainerRef = useRef(null);
  const [showBaselineModal, setShowBaselineModal] = useState(false);
  const [baselineQuestions, setBaselineQuestions] = useState('');

  // Scroll to bottom on new message
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
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
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setStage('chat');
      setMessages([
        {
          role: 'assistant',
          content: `I've analyzed your RFI document. Here is the outline for what a good submission should contain:\n\n${response.data.summary}\n\nYou can now ask me any questions about the document.`
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
    setMessages((prev) => [...prev, userMessage]);

    try {
      const response = await axios.post('http://localhost:3000/api/chat', {
        message: input,
      });

      const aiMessage = { role: 'assistant', content: response.data.response };
      setMessages((prev) => [...prev, aiMessage]);
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Error: Failed to get response' },
      ]);
    }

    setInput('');
  };

  // Show Upload Page
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
              id="file-upload"
              accept=".pdf"
              onChange={handleFileUpload}
              ref={fileInputRef}
              style={{ display: 'none' }}
            />
            <label htmlFor="file-upload" className="upload-button">
              {isUploading ? 'Uploading...' : 'Upload PDF'}
            </label>
          </div>
        </div>
      </div>
    );
  }

  // Chat Interface
  return (
    <div className="chat-stage">
      <div id="title">RFI Assistant</div>
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
          placeholder="Ask a question about the RFI..."
        />
        <button type="submit" id="enter"></button>
        <button
          type="button"
          id="baseline-button"
          onClick={() => setShowBaselineModal(true)}
        >
          Baseline Questions
        </button>
      </form>

      {/* Modal for Baseline Questions */}
      {showBaselineModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h3>Baseline Questions</h3>
              <button
                className="close-btn"
                onClick={() => setShowBaselineModal(false)}
              >
                ×
              </button>
            </div>
            <textarea
              value={baselineQuestions}
              onChange={(e) => setBaselineQuestions(e.target.value)}
              placeholder="Enter your baseline questions here..."
            />
          </div>
        </div>
      )}
    </div>
  );
}
