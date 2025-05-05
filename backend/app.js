const { Mistral } = require('@mistralai/mistralai');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors'); 

dotenv.config();

const apiKey = process.env.MISTRAL_API_KEY;
const app = express();


app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const client = new Mistral({ apiKey });


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