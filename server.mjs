import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // allow image data URLs

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// In-memory usage tracking (per user/IP per month)
const usageByClient = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function getMonthKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`; // e.g. "2025-11"
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'digital-tick-ai' });
});

// Main chat endpoint – Free vs Plus + usage limits + optional image
app.post('/api/digital-tick-ai', async (req, res) => {
  try {
    const { messages, plan, userId, image } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const planType = plan === 'plus' ? 'plus' : 'free';
    const isPlus = planType === 'plus';

    const monthKey = getMonthKey();
    const baseKey = userId ? String(userId) : getClientIp(req);
    const usageKey = `${baseKey}:${monthKey}`;

    const record = usageByClient.get(usageKey) || { month: monthKey, count: 0 };

    const FREE_LIMIT = 10;
    if (!isPlus && record.count >= FREE_LIMIT) {
      return res.json({
        error: 'Free plan monthly limit reached',
        errorCode: 'FREE_LIMIT_REACHED',
        allowedPerMonth: FREE_LIMIT,
        usedThisMonth: record.count,
        plan: planType,
      });
    }

    if (!isPlus) {
      record.count += 1;
      usageByClient.set(usageKey, record);
    }

    const systemContent = `
You are Digital Tick AI, a professional but friendly assistant helping with:
- WiFi & broadband issues (including fibre, 4G/5G, and Starlink)
- Routers, mesh, interference, and coverage
- Smart home devices (cameras, lights, thermostats, hubs, etc.)
- Online safety, filtering, and parental controls

The user is on the "${isPlus ? 'Plus (Expert)' : 'Free (Basic)'}" plan.

For Free (Basic):
- Up to 10 questions per month.
- Keep answers short and concise.
- Focus on basic WiFi/broadband troubleshooting and simple device support.
- Provide high-level online-safety guidance.
- Avoid very long step-by-step walkthroughs; keep it brief and practical.

For Plus (Expert):
- Unlimited questions.
- Provide detailed step-by-step help.
- Offer brand & device-specific troubleshooting when useful.
- Go deeper into WiFi optimisation (mesh, channels, interference, coverage).
- Support fibre, broadband, 4G/5G, Starlink, and full-home setups.
- Include smart-home setup guidance and parental-control/filtering advice.
- It is fine to ask short follow-up questions to fully diagnose the issue.

If an image (e.g. a screenshot or photo of router lights, app errors, or wiring) is attached, use it alongside the text to give more precise and practical guidance.
`.trim();

    // Build chat history, upgrading the last user message to include the image if present (Plus only)
    let chatMessages = [...messages];

    if (image && isPlus && image.dataUrl) {
      const lastIndex = chatMessages.length - 1;
      if (lastIndex >= 0) {
        const last = chatMessages[lastIndex];
        const lastText =
          typeof last.content === 'string' ? last.content : '';

        chatMessages[lastIndex] = {
          role: 'user',
          content: [
            { type: 'input_text', text: lastText },
            { type: 'input_image', image_url: image.dataUrl },
          ],
        };
      }
    }

    const fullInput = [
      { role: 'system', content: systemContent },
      ...chatMessages,
    ];

    const response = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: fullInput,
    });

    const replyText =
      response.output_text || 'Sorry, I could not generate a response.';

    res.json({
      reply: replyText,
      plan: planType,
      usedThisMonth: !isPlus ? record.count : null,
      allowedPerMonth: !isPlus ? FREE_LIMIT : null,
    });
  } catch (err) {
    console.error('Digital Tick AI error:', err);
    res.status(500).json({
      error: 'Digital Tick AI API error',
      detail: err?.message || String(err),
    });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Digital Tick AI backend listening on port ${port}`);
});
