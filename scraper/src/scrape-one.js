// scrape-one.js — Single-retailer on-demand scraper for Phase 10
// Exported as a module so the bridge freshness middleware can call it directly.
//
// Design: creates a new complete snapshot that contains:
//   - fresh data for the target retailer (from mock portal)
//   - copied data for all other retailers (from the previous snapshot)
// This ensures Julia's /rank endpoint always sees a full set of retailers.
// Bonus/TC data is preserved from the base snapshot when parsing is unavailable,
// to avoid degrading quality (e.g. dropping a 500-mile bonus from missing API key).

const path = require('path');
const Database = require('better-sqlite3');
const { getMockRetailers } = require('./portal-mock');
const { createSnapshot, completeSnapshot, failSnapshot } = require('./snapshot');
const { logRequest } = require('./request-log');

const DB_PATH = path.resolve(__dirname, '..', '..', 'db', 'mileageplus.db');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// scrapeOne — the exported function
// ---------------------------------------------------------------------------

/**
 * Scrape a single retailer by name and update the database.
 *
 * Uses mock portal data (portal-mock.js). Live scraping requires a manually
 * pre-authenticated Playwright browser session (see scripts/portal-login.sh).
 *
 * Creates a new complete snapshot that includes all existing retailers' data
 * plus fresh data for the target retailer, so Julia's /rank remains functional.
 * Updates retailers.last_scraped for the target retailer.
 *
 * @param {string} retailerName - Retailer name (case-insensitive, spaces stripped)
 * @param {object} [options]
 * @param {string} [options.dbPath] - Override DB path (for testing)
 * @returns {Promise<{success: boolean, retailer: string, snapshot_id?: string, error?: string}>}
 */
async function scrapeOne(retailerName, options = {}) {
  const dbPath = options.dbPath || DB_PATH;

  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    return { success: false, retailer: retailerName, error: `Cannot open database: ${err.message}` };
  }

  // Match retailer name against mock data (case-insensitive, spaces stripped)
  const allMock = getMockRetailers();
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, '');
  const mockData = allMock.find((r) => normalize(r.name) === normalize(retailerName));

  if (!mockData) {
    db.close();
    return { success: false, retailer: retailerName, error: `'${retailerName}' not found in mock data. Available: ${allMock.map((r) => r.name).join(', ')}` };
  }

  // Load base snapshot (the latest complete one — we'll copy its data forward)
  const baseSnapshot = db.prepare(
    `SELECT snapshot_id, retailer_count FROM scrape_snapshots
     WHERE status = 'complete' ORDER BY completed_at DESC LIMIT 1`
  ).get() || null;

  // Create a new snapshot for this scrape
  const snapshotId = createSnapshot(db);

  // Simulate a short delay (shortened mock delay so freshness checks aren't slow)
  const delay = 200 + Math.random() * 300; // 200-500ms in mock mode
  await sleep(delay);
  logRequest(snapshotId, mockData.portal_url, 'GET', 200, Math.round(delay));

  const scrapedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '');

  try {
    // Resolve or create the retailer row
    let retailerRow = db.prepare(
      `SELECT retailer_id FROM retailers
       WHERE LOWER(REPLACE(name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))`
    ).get(retailerName);

    if (!retailerRow) {
      db.prepare(
        `INSERT INTO retailers (name, portal_url, tax_included, shipping_included, gc_portal_eligible, gc_portal_source)
         VALUES (?, ?, 0, 0, 0, NULL)`
      ).run(mockData.name, mockData.portal_url);
      retailerRow = db.prepare(`SELECT retailer_id FROM retailers WHERE name = ?`).get(mockData.name);
    } else {
      db.prepare(`UPDATE retailers SET portal_url = ? WHERE retailer_id = ?`).run(mockData.portal_url, retailerRow.retailer_id);
    }

    const retailerId = retailerRow.retailer_id;

    // --- Copy other retailers' data from base snapshot into the new snapshot ---
    if (baseSnapshot) {
      const baseId = baseSnapshot.snapshot_id;

      db.prepare(
        `INSERT OR IGNORE INTO retailer_rates (retailer_id, snapshot_id, base_rate, rate_type, category_rates, scraped_at)
         SELECT retailer_id, ?, base_rate, rate_type, category_rates, scraped_at
         FROM retailer_rates WHERE snapshot_id = ? AND retailer_id != ?`
      ).run(snapshotId, baseId, retailerId);

      db.prepare(
        `INSERT OR IGNORE INTO mpx_rates (retailer_id, snapshot_id, mpx_rate, chase_bonus, scraped_at)
         SELECT retailer_id, ?, mpx_rate, chase_bonus, scraped_at
         FROM mpx_rates WHERE snapshot_id = ? AND retailer_id != ?`
      ).run(snapshotId, baseId, retailerId);

      db.prepare(
        `INSERT OR IGNORE INTO bonus_offers
           (retailer_id, snapshot_id, bonus_type, config_json, active_from, active_until, raw_text, parsed_at)
         SELECT retailer_id, ?, bonus_type, config_json, active_from, active_until, raw_text, parsed_at
         FROM bonus_offers WHERE snapshot_id = ? AND retailer_id != ?`
      ).run(snapshotId, baseId, retailerId);

      db.prepare(
        `INSERT OR IGNORE INTO tc_rules
           (retailer_id, snapshot_id, inclusions, exclusions, raw_text, confidence, parsed_at)
         SELECT retailer_id, ?, inclusions, exclusions, raw_text, confidence, parsed_at
         FROM tc_rules WHERE snapshot_id = ? AND retailer_id != ?`
      ).run(snapshotId, baseId, retailerId);
    }

    // --- Write fresh rates for target retailer ---
    db.prepare(
      `INSERT INTO retailer_rates (retailer_id, snapshot_id, base_rate, rate_type, category_rates, scraped_at)
       VALUES (?, ?, ?, ?, NULL, ?)`
    ).run(retailerId, snapshotId, mockData.base_rate, mockData.rate_type, scrapedAt);

    if (mockData.mpx_rate != null) {
      db.prepare(
        `INSERT INTO mpx_rates (retailer_id, snapshot_id, mpx_rate, chase_bonus, scraped_at)
         VALUES (?, ?, ?, 0.25, ?)`
      ).run(retailerId, snapshotId, mockData.mpx_rate, scrapedAt);
    }

    // --- Write bonus and TC data for target retailer ---
    // Preference: parse via Claude API → copy base snapshot → write raw with confidence=0
    let bonusWritten = false;
    let tcWritten = false;

    if (process.env.ANTHROPIC_API_KEY) {
      const parserPath = path.resolve(__dirname, '..', '..', 'bridge', 'tc-parser.js');
      let parser;
      try {
        parser = require(parserPath);
      } catch (e) {
        console.log(`scrapeOne: could not load tc-parser: ${e.message}`);
      }

      if (parser && mockData.bonus_text) {
        try {
          const bonusResult = await parser.parseBonus(mockData.bonus_text, mockData.name, mockData.base_rate);
          db.prepare(
            `INSERT INTO bonus_offers (retailer_id, snapshot_id, bonus_type, config_json, raw_text, parsed_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(retailerId, snapshotId, bonusResult.bonus_type, JSON.stringify(bonusResult.config), mockData.bonus_text, scrapedAt);
          bonusWritten = true;
        } catch (e) {
          console.log(`scrapeOne: bonus parse failed for ${retailerName}: ${e.message}`);
        }
      }

      if (parser && mockData.tc_text) {
        try {
          const tcResult = await parser.parseTAndC(mockData.tc_text, mockData.name);
          db.prepare(
            `INSERT INTO tc_rules (retailer_id, snapshot_id, inclusions, exclusions, raw_text, confidence, parsed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(retailerId, snapshotId, tcResult.inclusions.join(','), tcResult.exclusions.join(','), mockData.tc_text, tcResult.confidence, scrapedAt);
          tcWritten = true;
        } catch (e) {
          console.log(`scrapeOne: tc parse failed for ${retailerName}: ${e.message}`);
        }
      }
    }

    // Fall back: copy existing parsed data from base snapshot (preserves quality)
    if (!bonusWritten && baseSnapshot) {
      const existingBonuses = db.prepare(
        `SELECT bonus_type, config_json, active_from, active_until, raw_text, parsed_at
         FROM bonus_offers WHERE retailer_id = ? AND snapshot_id = ?`
      ).all(retailerId, baseSnapshot.snapshot_id);
      for (const b of existingBonuses) {
        db.prepare(
          `INSERT INTO bonus_offers
             (retailer_id, snapshot_id, bonus_type, config_json, active_from, active_until, raw_text, parsed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(retailerId, snapshotId, b.bonus_type, b.config_json, b.active_from, b.active_until, b.raw_text, b.parsed_at);
      }
      bonusWritten = existingBonuses.length > 0;
    }

    if (!tcWritten && baseSnapshot) {
      const existingTc = db.prepare(
        `SELECT inclusions, exclusions, raw_text, confidence, parsed_at
         FROM tc_rules WHERE retailer_id = ? AND snapshot_id = ?`
      ).all(retailerId, baseSnapshot.snapshot_id);
      for (const tc of existingTc) {
        db.prepare(
          `INSERT INTO tc_rules
             (retailer_id, snapshot_id, inclusions, exclusions, raw_text, confidence, parsed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(retailerId, snapshotId, tc.inclusions, tc.exclusions, tc.raw_text, tc.confidence, tc.parsed_at);
      }
      tcWritten = existingTc.length > 0;
    }

    // Last resort: write raw text with confidence=0 (per Phase 10 spec)
    if (!bonusWritten && mockData.bonus_text) {
      db.prepare(
        `INSERT INTO bonus_offers (retailer_id, snapshot_id, bonus_type, config_json, raw_text, parsed_at)
         VALUES (?, ?, 'flat_tiered', '{"tiers":[]}', ?, ?)`
      ).run(retailerId, snapshotId, mockData.bonus_text, scrapedAt);
    }

    if (!tcWritten && mockData.tc_text) {
      db.prepare(
        `INSERT INTO tc_rules (retailer_id, snapshot_id, inclusions, exclusions, raw_text, confidence, parsed_at)
         VALUES (?, ?, '', '', ?, 0.0, ?)`
      ).run(retailerId, snapshotId, mockData.tc_text, scrapedAt);
    }

    // Count retailers in new snapshot and mark complete
    const countRow = db.prepare(
      `SELECT COUNT(DISTINCT retailer_id) as cnt FROM retailer_rates WHERE snapshot_id = ?`
    ).get(snapshotId);
    completeSnapshot(db, snapshotId, countRow ? countRow.cnt : 1, 0);

    // Update last_scraped timestamp for this retailer
    db.prepare(`UPDATE retailers SET last_scraped = ? WHERE retailer_id = ?`).run(scrapedAt, retailerId);

    console.log(`scrapeOne: ${retailerName} scraped → snapshot ${snapshotId}`);
    db.close();

    return { success: true, retailer: mockData.name, snapshot_id: snapshotId };

  } catch (err) {
    console.error(`scrapeOne: fatal error for ${retailerName}: ${err.message}`);
    try { failSnapshot(db, snapshotId, 1); } catch (_) {}
    db.close();
    return { success: false, retailer: retailerName, error: err.message };
  }
}

module.exports = { scrapeOne };
