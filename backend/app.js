const { Mistral } = require('@mistralai/mistralai');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { ChatMistralAI } = require('@langchain/mistralai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { RunnableSequence } = require('@langchain/core/runnables');
const { StringOutputParser } = require('@langchain/core/output_parsers');
const { MistralAIEmbeddings } = require('@langchain/mistralai');
const { MemoryVectorStore } = require('langchain/vectorstores/memory');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');
const { SystemMessage, HumanMessage } = require('@langchain/core/messages');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');

dotenv.config();

if (!process.env.MISTRAL_API_KEY) {
  console.error('MISTRAL_API_KEY is not set in environment variables');
  process.exit(1);
}

// Initialize LangChain components
const embeddings = new MistralAIEmbeddings({
  apiKey: process.env.MISTRAL_API_KEY,
  modelName: 'mistral-embed',
});

// Initialize in-memory vector store
let vectorStore = new MemoryVectorStore(embeddings);

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
const chatModel = new ChatMistralAI({
  apiKey: process.env.MISTRAL_API_KEY,
  modelName: 'mistral-small-latest',
  temperature: 0.1,
});

// Configure axios retry for rate limits
axiosRetry(axios, { 
  retries: 3,
  retryDelay: (retryCount) => {
    return Math.min(1000 * Math.pow(2, retryCount), 10000); // Exponential backoff, max 10s
  },
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
           (error.response && error.response.status === 429);
  }
});

const app = express();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Initialize middleware
app.use(helmet()); // Add security headers
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: process.env.RATE_LIMIT_WINDOW_MS || 900000, // 15 minutes
  max: process.env.RATE_LIMIT_MAX_REQUESTS || 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Input validation middleware
const validateChatInput = [
  body('message').trim().notEmpty().withMessage('Message is required')
    .isLength({ max: 1000 }).withMessage('Message must be less than 1000 characters'),
];

// Store for RFI requirements
let currentRequirements = new Map();
let currentPDFText = '';

// Helper functions
function formatRequirementsForDisplay(requirementsMap) {
  // console.log('Current requirements in display format:', 
  //   Array.from(requirementsMap.entries()).map(([heading, description]) => ({
  //     heading,
  //     description
  //   }))
  // );
  return Array.from(requirementsMap.entries()).map(([heading, description]) => ({
    heading,
    description
  }));
}

function formatRequirementsForLLM(requirementsMap) {
  return Array.from(requirementsMap.entries())
    .map(([heading, description]) => `- **${heading}**: ${description}`)
    .join('\n');
}

// Router chain to determine query type
const queryRouterPrompt = PromptTemplate.fromTemplate(`
  Analyze the user's RFI query. Categorize as 'EDIT' (modifying requirements) or 'QUESTION' (general RFI inquiry).
  
  **EDIT examples:**
  - "Add: Must support SSO."
  - "Remove: Advanced Reporting."
  - "Change Data Security: Compliant with ISO 27001, GDPR."
  - "Include scalability section?"
  - "Omit legacy integration."
  
  **QUESTION examples:**
  - "RFI submission deadline?"
  - "Elaborate on Technical Architecture?"
  - "Main RFI contact?"
  - "Submission evaluation criteria?"
  - "Project background info?"
  
  User query: {query}
  
  Response (EDIT or QUESTION only):
  `);

const queryRouter = RunnableSequence.from([
  queryRouterPrompt,
  chatModel,
  new StringOutputParser(),
]);

// Upload and process the RFI
app.post('/api/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!req.file.mimetype.includes('pdf')) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }

    const pdfPath = req.file.path;
    const dataBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text;
    currentPDFText = text;

    // Create text splitter for chunking
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000, // Size of each chunk in characters
      chunkOverlap: 200, // Overlap between chunks
      separators: ["\n\n", "\n", ".", "!", "?", ",", " ", ""], // Split on these characters in order
    });

    // Split the document into chunks
    const chunks = await textSplitter.createDocuments([text]);

    // Create a new vector store instance for the new document
    vectorStore = new MemoryVectorStore(embeddings);
    
    // Add chunks to vector store with metadata
    await vectorStore.addDocuments(chunks.map((chunk, index) => ({
      pageContent: chunk.pageContent,
      metadata: { 
        source: 'uploaded_rfi',
        chunk: index + 1,
        totalChunks: chunks.length
      }
    })));

    // Extract requirements using the existing prompt
    const chatResponse = await client.chat.complete({
      model: 'mistral-small-latest',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `Extract specific RFI requirements. Create a succinct heading (1-3 words) for each.
Output ONLY a bulleted list. Format: - **[Heading]**: [Detailed description].
No intro/summary.

**Example Output:**
- **Integration**: Describe CRM/ERP integration (APIs/methods).
- **Security**: Outline data protection measures/protocols.
- **Scalability**: Detail ability to scale for 50% user/data growth in 2 yrs.
- **Reporting**: Explain standard/custom report capabilities.
- **Support**: Describe support plans (response times/channels).
`
        },
        {
          role: 'user',
          content: text
        }
      ]
    });
    const summary = chatResponse.choices[0].message.content;

    // Extract and store requirements
    const newRequirements = new Map();
    summary
      .split('\n')
      .filter(line => line.trim().startsWith('-'))
      .forEach(line => {
        const content = line.replace(/^-\s*/, '').trim();
        const [heading, ...descParts] = content.split(':');
        const cleanHeading = heading.replace(/\*\*/g, '').trim();
        const description = descParts.join(':').trim();
        newRequirements.set(cleanHeading, description);
      });

    currentRequirements = newRequirements;

    // Clean up
    fs.unlinkSync(pdfPath);

    res.json({ 
      summary, 
      requirements: formatRequirementsForDisplay(currentRequirements),
      chunks: chunks.length // Add chunk count to response
    });
    
  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    next(error);
  }
});

// Unified chat endpoint
app.post('/api/chat', validateChatInput, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { message } = req.body;
    
    try {
      // Determine query type
      const queryType = await queryRouter.invoke({ query: message });
      
      if (queryType.trim() === 'EDIT') {
        
        // Handle requirements editing
        const formattedRequirements = formatRequirementsForLLM(currentRequirements);
        
        const editResponse = await chatModel.invoke([
          new SystemMessage(`Your primary task is to edit RFI requirements based on the user's instruction.
            **Crucially, you MUST first output the ENTIRE, complete, updated list of ALL requirements after applying the changes.**
            
            Maintain format for all requirements: - **Heading**: Description.
            
            **Response Structure (Strictly Follow):**
            
            **Part 1: Full Updated Requirements List**
            *   Output the **ENTIRE updated list of all requirements** here. Every single requirement, new and existing (if not removed), must be listed in bullet points.
            
            **(Leave a single blank line here)**
            
            **Part 2: Summary of Changes**
            *   After the blank line, provide a brief summary of what changed. Use one of the following headers:
                *   Changes Made - Added: (followed by only the newly added items)
                *   Changes Made - Removed: (followed by only the removed items)
                *   Changes Made - Edited: (followed by only the items that were modified)
                *   Changes Made - Multiple: (if different types of changes occurred, list affected items under sub-headers like "Added:" and "Removed:")
            
            **Rules:**
            1.  **Full List is Paramount:** The complete updated list in Part 1 is the most important part of your response.
            2.  **Maintain Format:** Use - **Heading**: Description for all requirements in both Part 1 and Part 2.
            3.  **Clarity:** Ensure requirements remain clear.
            4.  **No Extra Text:** Only output what is specified in the structure.
            
            **Example:**
            Current:
            - **Data Storage**: How data is stored.
            - **UI**: Provide mockups.
            User: "Remove UI. Add reporting."
            
            Here is an example of what your outputs should always look like (Always reprint every requirement and then print the changes made): 

            Expected Output:
            - **Data Storage**: How data is stored.
            - **Reporting**: Detail reporting features.
            
            Changes Made - Multiple:
            Added:
            - **Reporting**: Detail reporting features.
            Removed:
            - **UI**: Provide mockups.
            
            **Current requirements:**
            ${formattedRequirements}`),
            new HumanMessage(message)
        ]);

        const response = editResponse.content;

        
        const [mainList, operationSummary] = response.split('\n\n');
        
        // Parse and update requirements
        const modifiedRequirements = new Map();
        mainList
          .split('\n')
          .filter(line => line.trim().startsWith('-'))
          .forEach(line => {
            const content = line.replace(/^-\s*/, '').trim();
            const [heading, ...descParts] = content.split(':');
            const cleanHeading = heading.replace(/\*\*/g, '').trim();
            const description = descParts.join(':').trim();
            modifiedRequirements.set(cleanHeading, description);
          });

        // console.log('\nCurrent requirements before edit:', 
        //   Array.from(currentRequirements.entries()).map(([k, v]) => `${k}: ${v}`)
        // );

        // console.log('\nModified requirements after edit:', 
        //   Array.from(modifiedRequirements.entries()).map(([k, v]) => `${k}: ${v}`)
        // );

        // Debug: Compare old and new requirements
        // const added = [...modifiedRequirements.keys()].filter(k => !currentRequirements.has(k));
        // const removed = [...currentRequirements.keys()].filter(k => !modifiedRequirements.has(k));
        // const changed = [...modifiedRequirements.keys()].filter(k => 
        //   currentRequirements.has(k) && currentRequirements.get(k) !== modifiedRequirements.get(k)
        // );

        // console.log('\nChanges detected:');
        // console.log('Added requirements:', added);
        // console.log('Removed requirements:', removed);
        // console.log('Modified requirements:', changed);

        currentRequirements = modifiedRequirements;

        // Parse operation summary
        const operationType = operationSummary.split(':')[0].trim();
        const changedRequirements = operationSummary
          .split('\n')
          .slice(1)
          .filter(line => line.trim().startsWith('-'))
          .map(line => {
            const content = line.replace(/^-\s*/, '').trim();
            const [heading, ...descParts] = content.split(':');
            return {
              heading: heading.replace(/\*\*/g, '').trim(),
              description: descParts.join(':').trim()
            };
          });

        res.json({ 
          type: 'edit',
          operation: {
            type: operationType,
            requirements: changedRequirements
          }
        });
      } else {
        // Handle general RFI questions using RAG with chunked context
        const relevantDocs = await vectorStore.similaritySearch(message, 5); // Increased from 3 to 5 for better context
        const context = relevantDocs
          .map(doc => `[Chunk ${doc.metadata.chunk}/${doc.metadata.totalChunks}]\n${doc.pageContent}`)
          .join('\n\n');

          const questionResponse = await chatModel.invoke([
            new SystemMessage(`Answer user's RFI question using provided context. If answer not in context, state so.
  Context (chunked):
  ${context}
  
  Requirements (reference):
  ${formatRequirementsForLLM(currentRequirements)}
  Chunks marked [Chunk X/Y].`),
            new HumanMessage(message)
          ]);

        res.json({
          type: 'question',
          response: questionResponse.content
        });
      }
    } catch (error) {
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.headers['retry-after'] || 10;
        return res.status(429).json({
          error: 'Rate limit exceeded',
          message: 'The AI service is currently busy. Please try again in a few seconds.',
          retryAfter: parseInt(retryAfter)
        });
      }
      throw error; // Re-throw other errors to be caught by the outer try-catch
    }
  } catch (error) {
    console.error('Error processing chat:', error);
    
    // Handle different types of errors
    if (error.response) {
      res.status(error.response.status).json({
        error: 'AI Service Error',
        message: error.response.data.message || 'An error occurred while processing your request.'
      });
    } else if (error.request) {
      // The request was made but no response was received
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Unable to reach the AI service. Please try again later.'
      });
    } else {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred. Please try again later.'
      });
    }
  }
});

// Get current requirements
app.get('/api/requirements', (req, res) => {
  res.json({ 
    requirements: formatRequirementsForDisplay(currentRequirements)
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Running!`);
});