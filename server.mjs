import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import fs from 'fs/promises';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // allow image data URLs

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Basic JSON logger ----------
function log(level, event, data = {}) {
  const logObj = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  console.log(JSON.stringify(logObj));
}

// In-memory usage tracking (per user/IP per month)
const usageByClient = new Map();
const USAGE_FILE = 'usage-data.json';

// In-memory chat history (per Plus user, per session)
const historyByUser = new Map();
const HISTORY_FILE = 'history-data.json';

// ---------- Persistent usage helpers (file-based) ----------
async function loadUsageFromFile() {
  try {
    const data = await fs.readFile(USAGE_FILE, 'utf8');
    const parsed = JSON.parse(data);
    usageByClient.clear();
    for (const [key, record] of Object.entries(parsed)) {
      usageByClient.set(key, record);
    }
    log('info', 'usage_loaded', { entries: usageByClient.size });
  } catch (err) {
    log('info', 'usage_init', { message: 'No existing usage file, starting fresh' });
  }
}

async function saveUsageToFile() {
  try {
    const obj = Object.fromEntries(usageByClient);
    await fs.writeFile(USAGE_FILE, JSON.stringify(obj), 'utf8');
    log('info', 'usage_saved', { entries: usageByClient.size });
  } catch (err) {
    log('error', 'usage_save_error', { message: err?.message || String(err) });
  }
}

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

// ---------- Persistent history helpers ----------
async function loadHistoryFromFile() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(data);
    historyByUser.clear();
    for (const [userId, sessions] of Object.entries(parsed)) {
      historyByUser.set(userId, sessions);
    }
    log('info', 'history_loaded', { users: historyByUser.size });
  } catch (err) {
    log('info', 'history_init', { message: 'No existing history file, starting fresh' });
  }
}

async function saveHistoryToFile() {
  try {
    const obj = Object.fromEntries(historyByUser);
    await fs.writeFile(HISTORY_FILE, JSON.stringify(obj), 'utf8');
    log('info', 'history_saved', { users: historyByUser.size });
  } catch (err) {
    log('error', 'history_save_error', { message: err?.message || String(err) });
  }
}

// ---------- Request logging middleware (JSON) ----------
app.use((req, res, next) => {
  const start = Date.now();
  const ip = getClientIp(req);

  res.on('finish', () => {
    const duration = Date.now() - start;
    const plan = (req.body && req.body.plan) || 'unknown';
    const sessionId = (req.body && req.body.sessionId) || 'none';

    log('info', 'http_request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: duration,
      ip,
      plan,
      sessionId,
    });
  });

  next();
});

// ---------- Health check ----------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'digital-tick-ai' });
});

// ---------- Simple admin usage endpoint (optional) ----------
// GET /api/admin/usage?key=ADMIN_API_KEY
app.get('/api/admin/usage', (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res
      .status(500)
      .json({ error: 'ADMIN_API_KEY not configured on server' });
  }

  const key = req.query.key;
  if (key !== adminKey) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const monthKey = getMonthKey();
  const usageSnapshot = [];

  for (const [usageKey, record] of usageByClient.entries()) {
    if (record.month === monthKey) {
      usageSnapshot.push({
        client: usageKey.split(':')[0],
        month: record.month,
        count: record.count,
      });
    }
  }

  res.json({
    month: monthKey,
    totalClients: usageSnapshot.length,
    usage: usageSnapshot,
  });
});

// ---------- Chat history endpoint for Plus users ----------
// GET /api/history?userId=...&sessionId=...&latest=true
app.get('/api/history', (req, res) => {
  const userIdRaw = req.query.userId;
  if (!userIdRaw) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const userId = String(userIdRaw);
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
  const latest = req.query.latest === 'true' || req.query.latest === '1';

  const userSessions = historyByUser.get(userId);
  if (!userSessions) {
    return res.json({ conversations: [] });
  }

  const allSessions = Object.values(userSessions);

  if (sessionId) {
    const conv = userSessions[sessionId];
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    return res.json(conv);
  }

  if (latest || !req.query.latest) {
    if (allSessions.length === 0) {
      return res.json({ conversations: [] });
    }
    const latestConv = allSessions.reduce((acc, curr) => {
      if (!acc) return curr;
      return new Date(curr.updatedAt) > new Date(acc.updatedAt) ? curr : acc;
    }, null);
    return res.json(latestConv);
  }

  // Otherwise return metadata for all conversations
  const metadata = allSessions.map((c) => ({
    sessionId: c.sessionId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
  }));

  return res.json({ conversations: metadata });
});

// ---------- Main chat endpoint ----------
app.post('/api/digital-tick-ai', async (req, res) => {
  try {
    const { messages, plan, userId, image, sessionId } = req.body || {};

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
      log('info', 'free_limit_reached', {
        client: baseKey,
        month: monthKey,
        count: record.count,
        sessionId: sessionId || null,
      });

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
      // Fire-and-forget save (no await to avoid blocking response)
      saveUsageToFile().catch(() => {});
    }

    log('info', 'chat_request', {
      plan: planType,
      client: baseKey,
      usedThisMonth: !isPlus ? record.count : null,
      month: monthKey,
      sessionId: sessionId || null,
    });

    const systemContent = `
You are Digital Tick AI, a professional but friendly assistant helping UK consumers with:
- WiFi & broadband issues (including fibre, 4G/5G, and Starlink)
- Routers, mesh, interference, and coverage
- Smart home devices (cameras, lights, thermostats, hubs, etc.)
- Online safety, filtering, and parental controls

Always assume the user is in the United Kingdom unless they clearly say otherwise.

When recommending shops, services, installers, ISPs, or websites, only suggest UK-relevant options
(e.g. Currys, John Lewis, Argos, Richer Sounds, AO, UK-based online retailers and installers) and
avoid US-only or non-UK chains such as Best Buy, Walmart, Target, Home Depot, etc.

Use British English spelling and prices in GBP (£). When discussing regulations, safety, or consumer
rights, answer from a UK perspective (e.g. Ofcom, UK consumer law, Online Safety Act, UK data and
privacy rules). If something is not available or not applicable in the UK, say so and offer the
closest UK-relevant alternative.

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

If an image (e.g. a screenshot or photo of router lights, app errors, or wiring) is attached,
use it alongside the text to give more precise and practical guidance.
`.trim();

    // ----- Build chat history for the model (trimmed) -----
    let chatMessages = [...messages];
    const MAX_HISTORY = 8;
    if (chatMessages.length > MAX_HISTORY) {
      chatMessages = chatMessages.slice(chatMessages.length - MAX_HISTORY);
    }

    // Upgrade the last user message to include the image if present (Plus only)
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

    const maxOutputTokens = isPlus ? 600 : 300;

    const response = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: fullInput,
      max_output_tokens: maxOutputTokens,
      temperature: 0.4,
    });

    const replyText =
      response.output_text || 'Sorry, I could not generate a response.';

    log('info', 'chat_response', {
      plan: planType,
      client: baseKey,
      sessionId: sessionId || null,
    });

    // ---------- Save chat history for Plus users with an account ----------
    try {
      if (isPlus && userId) {
        const userKey = String(userId);
        const sid = sessionId || 'default';
        const nowIso = new Date().toISOString();

        // messages from the client are the full conversation so far
        const updatedMessages = [
          ...messages,
          { role: 'assistant', content: replyText },
        ];

        const existingSessions = historyByUser.get(userKey) || {};
        const existingConv = existingSessions[sid];

        const convo = {
          sessionId: sid,
          createdAt: existingConv?.createdAt || nowIso,
          updatedAt: nowIso,
          messages: updatedMessages,
        };

        existingSessions[sid] = convo;
        historyByUser.set(userKey, existingSessions);

        // fire-and-forget save
        saveHistoryToFile().catch(() => {});
      }
    } catch (historyErr) {
      log('error', 'history_update_error', {
        message: historyErr?.message || String(historyErr),
      });
    }

    res.json({
      reply: replyText,
      plan: planType,
      usedThisMonth: !isPlus ? record.count : null,
      allowedPerMonth: !isPlus ? FREE_LIMIT : null,
    });
  } catch (err) {
    log('error', 'chat_error', {
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
    res.status(500).json({
      error: 'Digital Tick AI API error',
      detail: err?.message || String(err),
    });
  }
});

const port = process.env.PORT || 4000;

// Load usage & history from file at startup
loadUsageFromFile().catch(() => {});
loadHistoryFromFile().catch(() => {});

app.listen(port, () => {
  log('info', 'server_start', { port });

  // Optional keep-warm pings (mostly cosmetic on Starter, but available)
  if (process.env.KEEP_WARM === 'true') {
    const KEEP_WARM_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
    setInterval(() => {
      fetch(`http://localhost:${port}/api/health`).catch((err) => {
        log('error', 'keep_warm_error', {
          message: err?.message || String(err),
        });
      });
    }, KEEP_WARM_INTERVAL_MS);

    log('info', 'keep_warm_enabled', { interval_ms: KEEP_WARM_INTERVAL_MS });
  }
});
