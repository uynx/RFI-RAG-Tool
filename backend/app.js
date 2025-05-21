const { Mistral } = require('@mistralai/mistralai');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
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

const app = express();

// Initialize middleware
app.use(helmet()); // Add security headers
app.use(cors());
app.use(express.json());

if (!process.env.MISTRAL_API_KEY) {
  console.error('MISTRAL_API_KEY is not set in environment variables');
  process.exit(1);
}

// Initialize LangChain components
const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
const chatModel = new ChatMistralAI({
  apiKey: process.env.MISTRAL_API_KEY,
  modelName: 'mistral-small-latest',
  temperature: 0.1,
});

const embeddings = new MistralAIEmbeddings({
  apiKey: process.env.MISTRAL_API_KEY,
  modelName: 'mistral-embed',
});

// Initialize in-memory vector store
let vectorStore = new MemoryVectorStore(embeddings);

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

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

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

// Store for RFI requirements
let currentRequirements = new Map();

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
    
    const loader = new PDFLoader(pdfPath);
    const docs = await loader.load();
    
    // Process each page to maintain page numbers
    const pageContents = docs.map((doc, index) => ({
      content: doc.pageContent,
      pageNumber: doc.metadata?.loc?.pageNumber || (index + 1)
    }));

    const rawFullText = pageContents.map(page => page.content+page.pageNumber).join('\n\n');
    currentPDFText = rawFullText;

    // ---- STAGE 1: Extract initial requirements from raw text ----
    const initialRequirementsChatResponse = await client.chat.complete({
      model: 'mistral-small-latest',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `You are an expert RFI evaluator. Your primary goal is to dissect the provided RFI text into its distinct informational requests or thematic areas of inquiry.
For each distinct RFI request or theme you identify:
1.  Internally understand what the RFI is asking respondents to provide or address.
2.  From that understanding, formulate an evaluation metric that describes the key elements, qualities, and characteristics of an ideal, comprehensive, and high-quality ("perfect") submission for that specific part of the RFI. This evaluation metric should reflect what a perfect submission would implement, include, demonstrate, or provide (e.g., specificity, examples, data, justifications, actionable recommendations, depth of analysis).

Create a succinct heading (2-4 words) for each evaluation metric.
The description for each metric should clearly define what aspect of a submission will be assessed and what constitutes excellence for that aspect.
Output ONLY a bulleted list of these evaluation metrics. Format: - **[Heading]**: [Description of the evaluation metric and the qualities of an excellent response].
No intro/summary.

**Example Output (Illustrating the desired format for succinct evaluation metrics):**

- **Procedural Clarity**: Detail and clarity of described existing operational procedures, including examples, relevant metrics, and acknowledgment of limitations.
- **Solution Viability**: Innovativeness, feasibility, thoroughness of technical explanation, and justification of the proposed technical solution, including risk assessment and mitigation.
- **Relevant Expertise**: Depth, direct relevance, and substantiation (with specific examples) of the team's experience and qualifications tailored to the RFI's scope.
- **Constructive Input**: Specificity, actionability, and clear rationale of the feedback provided on draft specifications or requested documents.
- **Plan Realism**: Clarity, completeness, logical phasing, and perceived realism of the proposed implementation plan and project timeline, including resource considerations.
- **Estimate Justification**: Transparency, detailed breakdown, and clear justification of cost projections and resource requirements based on the scope of work.
`
        },
        {
          role: 'user',
          content: rawFullText
        }
      ]
    });
    const summaryForUI = initialRequirementsChatResponse.choices[0].message.content;

    const newRequirements = new Map();
    summaryForUI
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

    // ---- STAGE 2: Chunk the raw text and add to vector store ----    
    const textSplitter = new RecursiveCharacterTextSplitter({
      separators: [
        "\n\n", ". ", "\n", // Prioritize semantic breaks
        "! ", "? ", "; ", ": ", ", ", 
        " ", ""
      ],
      chunkSize: 1500,
      chunkOverlap: 300,
      lengthFunction: (text) => text.length,
      isSeparatorRegex: false
    });

    // Create a mapping of text positions to page numbers
    const pageMapping = new Map();
    let currentPosition = 0;
    pageContents.forEach(page => {
      const pageLength = page.content.length;
      // Map each character position in the text to its page number
      for (let i = 0; i < pageLength; i++) {
        pageMapping.set(currentPosition + i, page.pageNumber);
      }
      currentPosition += pageLength + 2; // +2 for the '\n\n' separator
    });

    // Split the raw text into chunks
    const chunks = await textSplitter.createDocuments([rawFullText]);

    // Create a new vector store instance
    vectorStore = new MemoryVectorStore(embeddings);
    if (chunks.length > 0) {
      // Process each chunk to determine its page numbers
      const chunksWithPages = chunks.map((chunk, index) => {
        // Find the position of this chunk in the original text
        const chunkStart = rawFullText.indexOf(chunk.pageContent);
        const chunkEnd = chunkStart + chunk.pageContent.length;
        
        // Get all page numbers this chunk spans
        const pages = new Set();
        for (let i = chunkStart; i <= chunkEnd; i++) {
          const page = pageMapping.get(i);
          if (page) pages.add(page);
        }
        
        return {
          pageContent: chunk.pageContent,
          metadata: {
            source: 'raw_rfi',
            chunk: index + 1,
            totalChunks: chunks.length,
            pages: Array.from(pages).sort((a, b) => a - b), // Sorted array of page numbers
            pdfPath: pdfPath
          }
        };
      });

      await vectorStore.addDocuments(chunksWithPages);
      console.log(`${chunks.length} chunks added to vector store with page information.`);
    } else {
      console.log("No chunks were created. Vector store will be empty.");
    }

    fs.unlinkSync(pdfPath);

    res.json({ 
      summary: summaryForUI, 
      requirements: formatRequirementsForDisplay(currentRequirements),
      chunks: chunks.length
    });
    
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
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
            requirements: changedRequirements,
            fullRequirements: formatRequirementsForDisplay(modifiedRequirements)
          }
        });
      } else {
        // Handle general RFI questions using RAG with chunked context
        const relevantDocs = await vectorStore.similaritySearch(message, 5);
        
        const context = relevantDocs
          .map(doc => `[Pages ${doc.metadata.pages.join(', ')}]\n${doc.pageContent}`)
          .join('\n\n');

        const questionResponse = await chatModel.invoke([
          new SystemMessage(`You are an AI assistant tasked with answering questions *exclusively* from the provided "Context from RFI".
            Your entire response must be derived *solely* from this context.
            Do not use any external knowledge, infer information not explicitly stated, or make assumptions beyond what is written in the context.
            
            If the answer to your question cannot be found within the "Context from RFI", you MUST respond with the exact phrase: "The answer to your question is not found in the provided document excerpts." Do not try to guess or provide related information if it's not in the context.
            
            Context from RFI:
            ---
            ${context}
            ---
          `),
          new HumanMessage(message)
        ]);

        // Include page information in the response
        const sourcePages = relevantDocs.map(doc => ({
          pages: doc.metadata.pages,
          pdfPath: doc.metadata.pdfPath
        }));

        res.json({
          type: 'question',
          response: questionResponse.content,
          sources: sourcePages // Include page information for frontend reference
        });
      }
    } catch (error) {
      next(error);
    }
  } catch (error) {
    next(error);
  }
}); // End of /api/chat endpoint

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server is running on port ${process.env.PORT || 3000}`);
});
