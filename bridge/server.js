// server.js — Express bridge between React frontend and Julia engine (port 4000)
// Phase 2: forwards /api/score to Julia engine on port 5000

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { parseTAndC, parseBonus } = require('./tc-parser');
const { insertPurchase, listPurchases, markPosted, deletePurchase } = require('./purchase-log');

const JULIA_ENGINE_URL = process.env.JULIA_ENGINE_URL || 'http://localhost:5000';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '4000', 10);
const DB_PATH = path.resolve(__dirname, '..', 'db', 'mileageplus.db');

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

    // Inject log_template for the frontend "Log this purchase" button (Phase 7)
    if (resp.ok && data.total_miles != null) {
      const taxDecimal = (body.tax_rate || 0) / 100;
      const pList = body.p_list;
      const pathType = data.path || 'direct';
      const pCard = pList * (1 + taxDecimal);
      // For mpx and stacked paths, p_cash = p_list (gift card purchase amount equals list price)
      const pCash = (pathType === 'mpx' || pathType === 'stacked') ? pList : pCard;
      data.log_template = {
        retailer: body.retailer,
        path_type: pathType,
        p_list: pList,
        p_portal: pList,
        p_card: pCard,
        p_cash: pCash,
        miles_expected: Math.round(data.total_miles),
        risk_class: data.risk_class || 'uncertain',
        snapshot_id: data.snapshot_id || '',
      };
    }

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

    // Inject log_template on each rank result for the frontend "Log" button (Phase 7)
    if (resp.ok && data.results && Array.isArray(data.results)) {
      const taxDecimal = (body.tax_rate || 0) / 100;
      const pList = body.p_list;
      data.results = data.results.map((r) => {
        const pathType = r.path || 'direct';
        const pCard = pList * (1 + taxDecimal);
        const pCash = (pathType === 'mpx' || pathType === 'stacked') ? pList : pCard;
        r.log_template = {
          retailer: r.retailer_name || '',
          path_type: pathType,
          p_list: pList,
          p_portal: pList,
          p_card: pCard,
          p_cash: pCash,
          miles_expected: Math.round(r.total_miles || 0),
          risk_class: r.risk_class || 'uncertain',
          snapshot_id: data.snapshot_id || '',
        };
        return r;
      });
    }

    res.status(resp.status).json(data);
  } catch (err) {
    const message = err.name === 'AbortError'
      ? 'Julia engine request timed out (5s)'
      : `Julia engine unreachable: ${err.message}`;
    res.status(503).json({ error: 'engine_unavailable', message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/parse-tc — Parse T&C text via Claude API, update database
// ---------------------------------------------------------------------------

app.post('/api/parse-tc', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({
      error: 'api_key_missing',
      message: 'ANTHROPIC_API_KEY environment variable is not set. Set it before calling parse endpoints.',
    });
  }

  const { retailer_name, raw_text, snapshot_id } = req.body;
  if (!retailer_name || !raw_text || !snapshot_id) {
    return res.status(400).json({ error: 'missing_fields', message: 'Required: retailer_name, raw_text, snapshot_id' });
  }

  try {
    const parsed = await parseTAndC(raw_text, retailer_name);

    // Update database
    let dbUpdated = false;
    try {
      const db = new Database(DB_PATH);
      // Find retailer_id
      const retailer = db.prepare(
        "SELECT retailer_id FROM retailers WHERE LOWER(REPLACE(name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))"
      ).get(retailer_name);

      if (retailer) {
        const stmt = db.prepare(
          `UPDATE tc_rules SET inclusions = ?, exclusions = ?, confidence = ?, raw_text = ?
           WHERE retailer_id = ? AND snapshot_id = ?`
        );
        const result = stmt.run(
          parsed.inclusions.join(','),
          parsed.exclusions.join(','),
          parsed.confidence,
          raw_text,
          retailer.retailer_id,
          snapshot_id
        );
        dbUpdated = result.changes > 0;

        // If no row existed to update, insert one
        if (!dbUpdated) {
          const insertStmt = db.prepare(
            `INSERT INTO tc_rules (retailer_id, snapshot_id, inclusions, exclusions, raw_text, confidence, parsed_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
          );
          insertStmt.run(
            retailer.retailer_id,
            snapshot_id,
            parsed.inclusions.join(','),
            parsed.exclusions.join(','),
            raw_text,
            parsed.confidence
          );
          dbUpdated = true;
        }
      }
      db.close();
    } catch (dbErr) {
      console.error('Database error in /api/parse-tc:', dbErr.message);
    }

    res.json({ ...parsed, db_updated: dbUpdated });
  } catch (err) {
    res.status(500).json({ error: 'parse_failed', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/parse-bonus — Parse bonus offer text via Claude API, update database
// ---------------------------------------------------------------------------

app.post('/api/parse-bonus', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({
      error: 'api_key_missing',
      message: 'ANTHROPIC_API_KEY environment variable is not set. Set it before calling parse endpoints.',
    });
  }

  const { retailer_name, raw_text, snapshot_id, base_rate, bonus_type_hint } = req.body;
  if (!retailer_name || !raw_text || !snapshot_id) {
    return res.status(400).json({ error: 'missing_fields', message: 'Required: retailer_name, raw_text, snapshot_id' });
  }

  try {
    const parsed = await parseBonus(raw_text, retailer_name, base_rate || 1.0);

    // Update database
    let dbUpdated = false;
    try {
      const db = new Database(DB_PATH);
      const retailer = db.prepare(
        "SELECT retailer_id FROM retailers WHERE LOWER(REPLACE(name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))"
      ).get(retailer_name);

      if (retailer) {
        // Insert or replace bonus_offers row
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO bonus_offers (retailer_id, snapshot_id, bonus_type, config_json, raw_text, parsed_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`
        );
        stmt.run(
          retailer.retailer_id,
          snapshot_id,
          parsed.bonus_type,
          JSON.stringify(parsed.config),
          raw_text
        );
        dbUpdated = true;
      }
      db.close();
    } catch (dbErr) {
      console.error('Database error in /api/parse-bonus:', dbErr.message);
    }

    res.json({ ...parsed, db_updated: dbUpdated });
  } catch (err) {
    res.status(500).json({ error: 'parse_failed', message: err.message });
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

// ---------------------------------------------------------------------------
// GET /api/scraper/status — Latest scrape snapshot status (Phase 6)
// ---------------------------------------------------------------------------

app.get('/api/scraper/status', (_req, res) => {
  try {
    const db = new Database(DB_PATH);
    const snapshot = db.prepare(
      `SELECT snapshot_id, status, started_at, completed_at, retailer_count, error_count
       FROM scrape_snapshots ORDER BY started_at DESC LIMIT 1`
    ).get();
    db.close();

    if (!snapshot) {
      return res.json({ snapshot: null });
    }

    let ageHours = null;
    if (snapshot.completed_at) {
      ageHours = (Date.now() - new Date(snapshot.completed_at).getTime()) / (1000 * 3600);
      ageHours = Math.round(ageHours * 10) / 10;
    }

    res.json({
      snapshot_id: snapshot.snapshot_id,
      status: snapshot.status,
      started_at: snapshot.started_at,
      completed_at: snapshot.completed_at,
      retailer_count: snapshot.retailer_count,
      error_count: snapshot.error_count,
      age_hours: ageHours,
    });
  } catch (err) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/scraper/run-check — Can a new scrape be run? (Phase 6)
// ---------------------------------------------------------------------------

app.get('/api/scraper/run-check', (_req, res) => {
  try {
    const db = new Database(DB_PATH);
    const todayUTC = new Date().toISOString().slice(0, 10);
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM scrape_snapshots
       WHERE status IN ('complete', 'partial')
       AND started_at >= ? AND started_at < ?`
    ).get(todayUTC + 'T00:00:00', todayUTC + 'T99:99:99');
    db.close();

    if (row.cnt > 0) {
      res.json({ can_scrape: false, reason: 'already_scraped_today' });
    } else {
      res.json({ can_scrape: true, reason: 'ready' });
    }
  } catch (err) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/purchases — Log a new purchase (Phase 7)
// ---------------------------------------------------------------------------

app.post('/api/purchases', (req, res) => {
  try {
    const { retailer, path_type, p_list, miles_expected, risk_class, snapshot_id } = req.body;

    if (!retailer || !path_type || p_list == null || miles_expected == null || !risk_class || !snapshot_id) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'Required: retailer, path_type, p_list, miles_expected, risk_class, snapshot_id',
      });
    }

    if (!['direct', 'mpx', 'stacked'].includes(path_type)) {
      return res.status(400).json({ error: 'invalid_path_type', message: 'path_type must be direct, mpx, or stacked' });
    }

    if (!['confirmed', 'uncertain', 'excluded'].includes(risk_class)) {
      return res.status(400).json({ error: 'invalid_risk_class', message: 'risk_class must be confirmed, uncertain, or excluded' });
    }

    const db = new Database(DB_PATH);
    const result = insertPurchase(db, req.body);
    db.close();

    if (result.error === 'retailer_not_found') {
      return res.status(404).json({ error: 'retailer_not_found', retailer: result.retailer });
    }

    res.status(201).json(result);
  } catch (err) {
    console.error('Error in POST /api/purchases:', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/purchases — List all logged purchases (Phase 7)
// ---------------------------------------------------------------------------

app.get('/api/purchases', (_req, res) => {
  try {
    const db = new Database(DB_PATH);
    const result = listPurchases(db);
    db.close();
    res.json(result);
  } catch (err) {
    console.error('Error in GET /api/purchases:', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/purchases/:id/posted — Mark purchase as posted (Phase 7)
// ---------------------------------------------------------------------------

app.patch('/api/purchases/:id/posted', (req, res) => {
  try {
    const purchaseId = parseInt(req.params.id, 10);
    const { miles_posted, posted_at } = req.body;

    if (miles_posted == null || typeof miles_posted !== 'number' || miles_posted < 1 || !Number.isInteger(miles_posted)) {
      return res.status(400).json({
        error: 'invalid_miles_posted',
        message: 'miles_posted is required and must be a positive integer',
      });
    }

    const db = new Database(DB_PATH);
    const result = markPosted(db, purchaseId, miles_posted, posted_at || null);
    db.close();

    if (!result) {
      return res.status(404).json({ error: 'not_found', message: `Purchase ${purchaseId} not found` });
    }

    res.json(result);
  } catch (err) {
    console.error('Error in PATCH /api/purchases/:id/posted:', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/purchases/:id — Delete a purchase log entry (Phase 7)
// ---------------------------------------------------------------------------

app.delete('/api/purchases/:id', (req, res) => {
  try {
    const purchaseId = parseInt(req.params.id, 10);
    const db = new Database(DB_PATH);
    const deleted = deletePurchase(db, purchaseId);
    db.close();

    if (!deleted) {
      return res.status(404).json({ error: 'not_found', message: `Purchase ${purchaseId} not found` });
    }

    res.json({ deleted: true, purchase_id: purchaseId });
  } catch (err) {
    console.error('Error in DELETE /api/purchases/:id:', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

app.listen(BRIDGE_PORT, () => {
  console.log(`Bridge server listening on port ${BRIDGE_PORT}`);
  console.log(`Julia engine URL: ${JULIA_ENGINE_URL}`);
});
