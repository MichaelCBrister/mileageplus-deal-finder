// server.js — Express bridge between React frontend and Julia engine (port 4000)
// Phase 2: forwards /api/score to Julia engine on port 5000

const express = require('express');

const JULIA_ENGINE_URL = process.env.JULIA_ENGINE_URL || 'http://localhost:5000';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '4000', 10);

const app = express();
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// GET /health — bridge health + Julia status
app.get('/health', async (_req, res) => {
  let juliaStatus = 'unavailable';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const resp = await fetch(`${JULIA_ENGINE_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 'ok') juliaStatus = 'ok';
    }
  } catch {
    // Julia unreachable
  }
  res.json({ status: 'ok', julia_status: juliaStatus });
});

// POST /api/score — forward to Julia engine with 2s timeout
app.post('/api/score', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    // Map frontend field names to Julia engine field names
    const body = req.body;
    const juliaBody = {
      retailer: body.retailer,
      product_query: body.category || '',
      price: body.p_list,
      card_tier: mapCardTier(body.card_tier),
      tax_rate: (body.tax_rate || 0) / 100, // frontend sends percentage, Julia expects decimal
    };

    const resp = await fetch(`${JULIA_ENGINE_URL}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(juliaBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    const message = err.name === 'AbortError'
      ? 'Julia engine request timed out (2s)'
      : `Julia engine unreachable: ${err.message}`;
    res.status(503).json({ error: 'engine_unavailable', message });
  }
});

// POST /api/rank — forward to Julia engine with 5s timeout (Phase 4)
app.post('/api/rank', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const body = req.body;
    const juliaBody = {
      p_list: body.p_list,
      tax_rate: (body.tax_rate || 0) / 100, // frontend sends percentage, Julia expects decimal
      category: body.category || '',
      card_tier: mapCardTier(body.card_tier),
    };
    if (body.risk_filter) {
      juliaBody.risk_filter = body.risk_filter;
    }

    const resp = await fetch(`${JULIA_ENGINE_URL}/rank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(juliaBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    const message = err.name === 'AbortError'
      ? 'Julia engine request timed out (5s)'
      : `Julia engine unreachable: ${err.message}`;
    res.status(503).json({ error: 'engine_unavailable', message });
  }
});

// Map frontend card_tier values to Julia engine card_tier keys
function mapCardTier(tier) {
  const map = {
    none: 'none',
    one_x: 'explorer',
    one_five_x: 'club',
    two_x: 'quest',
  };
  return map[tier] || tier || 'none';
}

app.listen(BRIDGE_PORT, () => {
  console.log(`Bridge server listening on port ${BRIDGE_PORT}`);
  console.log(`Julia engine URL: ${JULIA_ENGINE_URL}`);
});
