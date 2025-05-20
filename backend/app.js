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
You are an expert at analyzing user queries about RFI documents. Your task is to determine if the user's query is about:
1. Editing the requirements list (adding, removing, or modifying requirements)
2. Asking general questions about the RFI document

Examples of requirement edits:
- "Add a requirement about cost analysis"
- "Remove the case studies requirement"
- "Update the risk analytics requirement to include more detail"

Examples of general questions:
- "What is the main goal of this RFI?"
- "Can you explain more about the deployment challenges?"
- "What technologies are they interested in?"

User query: {query}

Respond with ONLY one word: either "EDIT" or "QUESTION"
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

    // Create a new vector store instance for the new document
    vectorStore = new MemoryVectorStore(embeddings);
    await vectorStore.addDocuments([{
      pageContent: text,
      metadata: { source: 'uploaded_rfi' }
    }]);

    // Extract requirements using the existing prompt
    const chatResponse = await client.chat.complete({
      model: 'mistral-small-latest',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `You are an expert assistant specializing in analyzing Requests for Information (RFIs). Your task is to meticulously review the provided RFI document and extract the specific requirements that a submission must address. The goal is to create a definitive list of what the RFI is asking for, which will be used to evaluate future submissions.
    Focus on transforming the RFI's questions, requested information, and areas of interest into a clear, itemized list of requirements. For each requirement, include a succinct heading (1-3 words) that summarizes what the requirement details.
    Output ONLY a bulleted list of these requirements. Each bullet point should start with a heading in bold (using markdown **text**) followed by a colon and a succinct but detailed description of what a submission should provide or address based on the RFI. Do not include any introductory phrases, summaries, or explanations beyond the list itself.`
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
      requirements: formatRequirementsForDisplay(currentRequirements)
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
          new SystemMessage(`You are an expert assistant specializing in editing RFI requirements. Your task is to modify the provided list of requirements based on the user's instruction.

The requirements are provided in a specific format where each requirement has a heading (in bold) and a description. You must maintain this exact format in your response.

IMPORTANT: Your response must follow this exact structure:

1. First, output the complete updated list of all requirements in bullet point format
2. Then, on a new line, output one of these headers followed by the affected requirements:
   - "Added Requirements:" (if new requirements were added)
   - "Removed Requirements:" (if requirements were removed)
   - "Edited Requirements:" (if existing requirements were modified)

Rules:
1. Keep the same markdown format with bullet points and bold headings
2. Only modify what's necessary based on the instruction
3. If adding new requirements, add them to the end of the list
4. If removing requirements, exclude them from the main list
5. If editing requirements, update them in their original position
6. Do not add any explanations or additional text beyond the required structure
7. Maintain the clarity and specificity of each requirement

Current requirements:
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
        // Handle general RFI questions using RAG
        const relevantDocs = await vectorStore.similaritySearch(message, 3);
        const context = relevantDocs.map(doc => doc.pageContent).join('\n\n');

        const questionResponse = await chatModel.invoke([
          new SystemMessage(`You are an expert assistant helping users understand RFI documents. Use the following context from the RFI document to answer the user's question. If the answer cannot be found in the context, say so.

Context from RFI:
${context}

Current requirements (for reference):
${formatRequirementsForLLM(currentRequirements)}`),
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
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
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
      // Something happened in setting up the request that triggered an Error
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
  console.log(`Server running on port ${PORT}`);
});
