const { Mistral } = require('@mistralai/mistralai');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const path = require('path');

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

// --- Upload and summarize RFI PDF ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const pdfPath = req.file.path;
    const dataBuffer = fs.readFileSync(pdfPath);

    // Extract text from PDF
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text;

    // Call Mistral to summarize the text with markdown formatting
    const chatResponse = await client.chat.complete({
      model: 'mistral-small-latest',
      messages: [
        {
          role: 'system',
          content: 'You are an assistant designed to analyze Requests for Information (RFIs) for the Massachusetts Department of Transportation (MassDOT). Your task is to review the provided RFI document and extract the key criteria that define a high-quality submission. Focus solely on identifying and listing the specific elements, requirements, and considerations that a submission must address to meet the RFI’s objectives effectively. Do not provide a summary or additional commentary. Output the criteria in a clear, concise list, ensuring all relevant aspects from the RFI are captured for use in evaluating future submissions.'
        },
        {
          role: 'user',
          content: `Analyze the provided RFI document and output a list of criteria that a high-quality submission must address to meet the RFI’s requirements. Include only the specific elements, requirements, and considerations outlined in the RFI that are essential for a complete and compliant response. The criteria will be used to evaluate and score future submissions for MassDOT. Provide a very concise response that just listsi the requirements. Do not include extra information.\n\n${text}`
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

// --- Chat with Mistral ---
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
