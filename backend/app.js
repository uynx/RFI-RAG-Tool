const { Mistral } = require('@mistralai/mistralai');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const path = require('path');
const BASELINE_PATH = path.join(__dirname, 'baseline.json');
dotenv.config();

if (!process.env.MISTRAL_API_KEY) {
  console.error('MISTRAL_API_KEY is not set in environment variables');
  process.exit(1);
}

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Set up multer for PDF uploads
const upload = multer({ dest: 'uploads/' });

// Upload and summarize the RFI
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const pdfPath = req.file.path;
    const dataBuffer = fs.readFileSync(pdfPath);

    // Extract text from PDF
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text;


    const chatResponse = await client.chat.complete({
      model: 'mistral-small-latest', 
      temperature: 0.1, // Lower temperature for more deterministic, factual extraction
      messages: [
        {
          role: 'system',
          content: `You are an expert assistant specializing in analyzing Requests for Information (RFIs). Your task is to meticulously review the provided RFI document and extract the specific requirements that a submission must address. The goal is to create a definitive list of what the RFI is asking for, which will be used to evaluate future submissions.
Focus on transforming the RFI's questions, requested information, and areas of interest into a clear, itemized list of requirements.
Output ONLY a bulleted list of these requirements. Each bullet point should be a succinct but detailed description of what a submission should provide or address based on the RFI. Do not include any introductory phrases, summaries, or explanations beyond the list itself.`
        },
        {
          role: 'user',
          content: `Here is an example of how to extract requirements:

EXAMPLE INPUT RFI TEXT:
---
The Department seeks information on innovative approaches to improve pedestrian safety at unsignalized crosswalks. Specifically, we are interested in:
1. What new technologies or engineering treatments have proven effective in increasing driver yielding rates? Please describe their mechanisms and effectiveness.
2. How can data analytics be leveraged to identify high-risk locations before crashes occur? Include details on data sources and analytical methods.
3. Provide case studies of successful implementations in urban environments, detailing project scope, outcomes, and lessons learned.
We also request input on potential challenges in deploying such solutions and strategies to overcome them.
---
EXAMPLE OUTPUT REQUIREMENTS LIST:
---
- Description of new technologies or engineering treatments proven effective in increasing driver yielding rates at unsignalized crosswalks, including their mechanisms and effectiveness.
- Explanation of how data analytics can be leveraged to identify high-risk pedestrian locations before crashes occur, including details on data sources and analytical methods.
- Case studies of successful implementations of pedestrian safety approaches in urban environments, detailing project scope, outcomes, and lessons learned.
- Input on potential challenges in deploying pedestrian safety solutions and strategies to overcome them.
---

Now, analyze the following RFI document and extract the requirements as a bulleted list, following the format of the example output.

RFI DOCUMENT TEXT:
---
${text}
---
`
        }
      ]
    });

    const summary = chatResponse.choices[0].message.content;

    // Clean up the uploaded file
    fs.unlinkSync(pdfPath);

    res.json({ summary });
  } catch (error) {
    console.error('Error processing PDF:', error.message);
    res.status(500).json({ error: 'Failed to process PDF' });
  }
});

// Chat with LLM
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const chatResponse = await client.chat.complete({
      model: 'mistral-small-latest',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that formats responses using markdown. Use ** for bold text, * for italics, and # for headings. Format lists with - or numbers. Preserve all markdown formatting in your response.'
        },
        {
          role: 'user',
          content: message
        }
      ],
    });

    const responseMessage = chatResponse.choices[0].message.content;
    res.json({ response: responseMessage });
  } catch (error) {
    console.error('Mistral API error:', error.message);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Get baseline questions
app.get('/api/baseline', (req, res) => {
  try {
    const data = fs.readFileSync(BASELINE_PATH, 'utf-8');
    const json = JSON.parse(data);
    res.json({ questions: json.questions || '' });
  } catch (error) {
    console.error('Error reading baseline questions:', error.message);
    res.status(500).json({ error: 'Failed to load baseline questions' });
  }
});

// Save/update baseline questions
app.post('/api/baseline', (req, res) => {
  const { questions } = req.body;
  if (typeof questions !== 'string') {
    return res.status(400).json({ error: 'Invalid questions format' });
  }

  try {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ questions }, null, 2));
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving baseline questions:', error.message);
    res.status(500).json({ error: 'Failed to save baseline questions' });
  }
});
