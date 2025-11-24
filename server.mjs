import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json());

// Create the OpenAI client using the API key from the environment
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Simple health check – lets us test the server is up
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'digital-tick-ai' });
});

// Main chat endpoint – Phase 1 (no tiers/limits yet)
app.post('/api/digital-tick-ai', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Add our “Digital Tick AI” instructions at the start
    const fullInput = [
      {
        role: 'system',
        content: `
You are Digital Tick AI, a professional but friendly assistant helping with:
- WiFi & broadband issues (including fibre, 4G/5G, and Starlink)
- Routers, mesh, interference, and coverage
- Smart home devices (cameras, lights, thermostats, hubs, etc.)
- Online safety, filtering, and parental controls

Tone:
- Clear, concise UK English
- Practical and step-by-step when needed
        `.trim(),
      },
      ...messages,
    ];

    // Ask OpenAI for a reply
    const response = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: fullInput,
    });

    const replyText =
      response.output_text || 'Sorry, I could not generate a response.';

    res.json({ reply: replyText });
  } catch (err) {
    console.error('Digital Tick AI error:', err);
    res.status(500).json({
      error: 'Digital Tick AI API error',
      detail: err?.message || String(err),
    });
  }
});

// Render will give us a PORT when it runs this
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Digital Tick AI backend listening on port ${port}`);
});
