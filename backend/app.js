const { Mistral } = require('@mistralai/mistralai');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const path = require('path');

dotenv.config();

const apiKey = process.env.MISTRAL_API_KEY;
const client = new Mistral({ apiKey });

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

    // Call Mistral to summarize the text
    const chatResponse = await client.chat.complete({
      model: 'mistral-small-latest',
      messages: [
        {
          role: 'user',
          content: `Please summarize this RFI document in bullet points:\n\n${text}`,
        },
      ],
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
      messages: [{ role: 'user', content: message }],
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
