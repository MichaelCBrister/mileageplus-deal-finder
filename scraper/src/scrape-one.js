// scrape-one.js — Single-retailer on-demand scraper for Phase 10
// Exported as a module so the bridge freshness middleware can call it directly.
//
// Design: creates a new complete snapshot that contains:
//   - fresh data for the target retailer (from live portal or mock)
//   - copied data for all other retailers (from the previous snapshot)
// This ensures Julia's /rank endpoint always sees a full set of retailers.
// Bonus/TC data is preserved from the base snapshot when parsing is unavailable,
// to avoid degrading quality (e.g. dropping a 500-mile bonus from missing API key).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { getMockRetailers } = require('./portal-mock');
const { createSnapshot, completeSnapshot, failSnapshot } = require('./snapshot');
const { logRequest } = require('./request-log');

const DB_PATH = path.resolve(__dirname, '..', '..', 'db', 'mileageplus.db');
const AUTH_DIR = path.join(__dirname, '..', 'auth', 'browser-context');
const PORTAL_URL = 'https://shopping.mileageplus.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min = 1000, max = 3000) {
  return min + Math.random() * (max - min);
}

/**
 * Check if a live browser session exists on disk.
 */
function hasLiveSession() {
  try {
    return fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared persistent browser context (reused across multiple scrapeOne calls)
// ---------------------------------------------------------------------------
let _sharedContext = null;
let _contextCloseTimer = null;

/**
 * Get or create a shared persistent browser context.
 * Auto-closes after 60 seconds of inactivity.
 */
async function getSharedContext() {
  // Reset inactivity timer
  if (_contextCloseTimer) clearTimeout(_contextCloseTimer);
  _contextCloseTimer = setTimeout(async () => {
    if (_sharedContext) {
      try { await _sharedContext.close(); } catch {}
      _sharedContext = null;
      console.log('scrapeOne: shared browser context closed (idle timeout)');
    }
  }, 60000);

  if (_sharedContext) return _sharedContext;

  const { chromium } = require('playwright');
  _sharedContext = await chromium.launchPersistentContext(AUTH_DIR, {
    headless: true,
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  return _sharedContext;
}

// ---------------------------------------------------------------------------
// Live scraper: scrape one retailer from the real portal
// ---------------------------------------------------------------------------

/**
 * Scrape a single retailer from the live MileagePlus Shopping portal.
 * Uses the persistent browser context saved by portal-login.js.
 *
 * @param {string} retailerName
 * @returns {Promise<{name, baseRate, bonusText, portalUrl, tcText, scrapedAt} | null>}
 */
async function scrapeOneRetailer(retailerName) {
  const context = await getSharedContext();
  const page = await context.newPage();

  try {
    // Navigate to portal home
    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(randomDelay(1000, 2000));

    // Check for session expiry — if redirected to login
    const url = page.url();
    if (url.includes('login') || url.includes('signin') || url.includes('sso')) {
      throw new Error('SESSION_EXPIRED');
    }

    // Also check for login form on the page
    const loginForm = await page.$('input[type="password"]');
    if (loginForm) {
      throw new Error('SESSION_EXPIRED');
    }

    // Search for the retailer using the portal search bar
    const searchSelectors = [
      'input[type="search"]',
      'input[placeholder*="search" i]',
      'input[placeholder*="Search" i]',
      'input[name="search"]',
      'input[name="q"]',
      '#search',
      '.search-input',
      '[data-testid="search-input"]',
      'input[aria-label*="search" i]',
    ];

    let searchInput = null;
    for (const sel of searchSelectors) {
      searchInput = await page.$(sel);
      if (searchInput) break;
    }

    if (!searchInput) {
      // Try clicking a search icon/button first to reveal the input
      const searchTriggers = [
        'button[aria-label*="search" i]',
        '.search-icon',
        '.search-trigger',
        'a[href*="search"]',
      ];
      for (const sel of searchTriggers) {
        const trigger = await page.$(sel);
        if (trigger) {
          await trigger.click();
          await sleep(500);
          // Retry finding input
          for (const inputSel of searchSelectors) {
            searchInput = await page.$(inputSel);
            if (searchInput) break;
          }
          if (searchInput) break;
        }
      }
    }

    if (!searchInput) {
      throw new Error('Could not find search bar on portal page. DOM may have changed.');
    }

    // Type retailer name and search
    await searchInput.click();
    await searchInput.fill(retailerName);
    await sleep(randomDelay(500, 1500));

    // Press Enter or click search button
    await searchInput.press('Enter');
    await sleep(randomDelay(2000, 3000));

    // Find and click the retailer result
    // Look for a link/card matching the retailer name
    const resultSelectors = [
      `a:has-text("${retailerName}")`,
      `.store-card:has-text("${retailerName}")`,
      `.merchant-name:has-text("${retailerName}")`,
      `.retailer-item:has-text("${retailerName}")`,
      `[data-store-name*="${retailerName}" i]`,
    ];

    let resultLink = null;
    for (const sel of resultSelectors) {
      try {
        resultLink = await page.$(sel);
        if (resultLink) break;
      } catch {
        // Selector might be invalid for some retailer names
      }
    }

    if (!resultLink) {
      // Fallback: look for any link containing the retailer name (case-insensitive)
      const links = await page.$$('a');
      for (const link of links) {
        const text = await link.textContent();
        if (text && text.toLowerCase().includes(retailerName.toLowerCase())) {
          resultLink = link;
          break;
        }
      }
    }

    if (!resultLink) {
      throw new Error(`No search results found for "${retailerName}".`);
    }

    await resultLink.click();
    await sleep(randomDelay(2000, 3000));

    // Extract data from the retailer detail page
    const data = await page.evaluate(() => {
      const body = document.body.innerText || '';

      // Extract base rate: look for patterns like "2x", "2 miles/$", "Earn 2 miles per dollar"
      let baseRate = null;
      const ratePatterns = [
        /(\d+(?:\.\d+)?)\s*(?:mile|mi)s?\s*(?:per|\/)\s*(?:\$|dollar)/i,
        /earn\s*(\d+(?:\.\d+)?)\s*(?:mile|mi)s?/i,
        /(\d+(?:\.\d+)?)\s*x\s*(?:mile|mi)s?/i,
        /(\d+(?:\.\d+)?)\s*x/i,
      ];
      for (const pattern of ratePatterns) {
        const match = body.match(pattern);
        if (match) {
          baseRate = parseFloat(match[1]);
          break;
        }
      }

      // Extract bonus text — look for bonus/promo sections
      let bonusText = null;
      const bonusEl = document.querySelector(
        '.bonus-offer, .promo-text, .special-offer, [data-testid="bonus"], .promotion, .offer-text'
      );
      if (bonusEl) {
        bonusText = bonusEl.textContent.trim();
      } else {
        // Look in body for bonus-like patterns
        const bonusMatch = body.match(
          /(earn\s+\d+\s+bonus\s+miles[^.]*\.|bonus[^.]*miles[^.]*\.)/i
        );
        if (bonusMatch) bonusText = bonusMatch[0].trim();
      }

      // Extract T&C text
      let tcText = null;
      const tcEl = document.querySelector(
        '.terms-conditions, .tc-text, .store-terms, [data-testid="terms"], .terms, .conditions'
      );
      if (tcEl) {
        tcText = tcEl.textContent.trim();
      }

      // Extract portal click-through URL (the "Shop Now" or "Earn miles" link)
      let portalUrl = null;
      const shopLinks = document.querySelectorAll(
        'a[href*="redirect"], a[href*="clickthrough"], a[href*="XID"], a:has-text("Shop Now"), a:has-text("Earn miles"), a:has-text("Start Shopping"), .shop-now-btn, .earn-miles-btn'
      );
      for (const link of shopLinks) {
        if (link.href) {
          portalUrl = link.href;
          break;
        }
      }

      return { baseRate, bonusText, tcText, portalUrl };
    });

    // Also capture the current page URL as fallback portal URL
    const pageUrl = page.url();

    return {
      name: retailerName,
      baseRate: data.baseRate,
      bonusText: data.bonusText || null,
      portalUrl: data.portalUrl || pageUrl,
      tcText: data.tcText || null,
      scrapedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
    };
  } catch (err) {
    if (err.message === 'SESSION_EXPIRED') {
      console.error(
        "Session expired. Run 'npm run portal-login' to re-authenticate."
      );
      // Close shared context so next attempt gets a fresh one after re-auth
      try { await _sharedContext.close(); } catch {}
      _sharedContext = null;
    }
    throw err;
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// scrapeOne — the exported function (live or mock)
// ---------------------------------------------------------------------------

/**
 * Scrape a single retailer by name and update the database.
 *
 * If a live browser session exists (scraper/auth/browser-context/), uses Playwright
 * to scrape the real portal. Otherwise falls back to mock data.
 *
 * Creates a new complete snapshot that includes all existing retailers' data
 * plus fresh data for the target retailer, so Julia's /rank remains functional.
 * Updates retailers.last_scraped for the target retailer.
 *
 * @param {string} retailerName - Retailer name (case-insensitive, spaces stripped)
 * @param {object} [options]
 * @param {string} [options.dbPath] - Override DB path (for testing)
 * @param {boolean} [options.forceMock] - Force mock mode even if live session exists
 * @returns {Promise<{success: boolean, retailer: string, snapshot_id?: string, mode?: string, error?: string}>}
 */
async function scrapeOne(retailerName, options = {}) {
  const dbPath = options.dbPath || DB_PATH;
  const useLive = !options.forceMock && hasLiveSession();

  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    return { success: false, retailer: retailerName, error: `Cannot open database: ${err.message}` };
  }

  // Determine data source
  let scrapedData = null;

  if (useLive) {
    // Live mode: scrape from real portal
    try {
      console.log(`scrapeOne: LIVE mode — scraping "${retailerName}" from portal...`);
      const result = await scrapeOneRetailer(retailerName);
      if (result && result.baseRate != null) {
        scrapedData = {
          name: result.name,
          base_rate: result.baseRate,
          rate_type: 'miles per dollar',
          bonus_text: result.bonusText,
          tc_text: result.tcText,
          portal_url: result.portalUrl,
          mpx_rate: null,
        };
      } else {
        console.warn(`scrapeOne: live scrape returned no rate for "${retailerName}", falling back to mock`);
      }
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        db.close();
        return { success: false, retailer: retailerName, error: "Session expired. Run 'npm run portal-login' to re-authenticate." };
      }
      console.warn(`scrapeOne: live scrape failed for "${retailerName}": ${err.message}, falling back to mock`);
    }
  }

  // Fall back to mock data
  if (!scrapedData) {
    const allMock = getMockRetailers();
    const normalize = (s) => s.toLowerCase().replace(/\s+/g, '');
    const mockData = allMock.find((r) => normalize(r.name) === normalize(retailerName));

    if (!mockData) {
      db.close();
      return { success: false, retailer: retailerName, error: `'${retailerName}' not found in mock data and live scrape unavailable. Available mock: ${allMock.map((r) => r.name).join(', ')}` };
    }

    console.log(`scrapeOne: MOCK mode — using mock data for "${retailerName}"`);
    scrapedData = mockData;
  }

  const mode = useLive && scrapedData !== null ? 'live' : 'mock';

  // Load base snapshot (the latest complete one — we'll copy its data forward)
  const baseSnapshot = db.prepare(
    `SELECT snapshot_id, retailer_count FROM scrape_snapshots
     WHERE status = 'complete' ORDER BY completed_at DESC LIMIT 1`
  ).get() || null;

  // Create a new snapshot for this scrape
  const snapshotId = createSnapshot(db);

  // Simulate delay in mock mode; live mode already has natural delays
  if (mode === 'mock') {
    const delay = 200 + Math.random() * 300;
    await sleep(delay);
    logRequest(snapshotId, scrapedData.portal_url, 'GET', 200, Math.round(delay));
  } else {
    logRequest(snapshotId, scrapedData.portal_url || PORTAL_URL, 'GET', 200, 0);
  }

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
      ).run(scrapedData.name, scrapedData.portal_url);
      retailerRow = db.prepare(`SELECT retailer_id FROM retailers WHERE name = ?`).get(scrapedData.name);
    } else {
      // Update portal_url if we have a new one
      if (scrapedData.portal_url) {
        db.prepare(`UPDATE retailers SET portal_url = ? WHERE retailer_id = ?`).run(scrapedData.portal_url, retailerRow.retailer_id);
      }
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
    ).run(retailerId, snapshotId, scrapedData.base_rate, scrapedData.rate_type, scrapedAt);

    if (scrapedData.mpx_rate != null) {
      db.prepare(
        `INSERT INTO mpx_rates (retailer_id, snapshot_id, mpx_rate, chase_bonus, scraped_at)
         VALUES (?, ?, ?, 0.25, ?)`
      ).run(retailerId, snapshotId, scrapedData.mpx_rate, scrapedAt);
    }

    // --- Write bonus and TC data for target retailer ---
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

      if (parser && scrapedData.bonus_text) {
        try {
          const bonusResult = await parser.parseBonus(scrapedData.bonus_text, scrapedData.name, scrapedData.base_rate);
          db.prepare(
            `INSERT INTO bonus_offers (retailer_id, snapshot_id, bonus_type, config_json, raw_text, parsed_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(retailerId, snapshotId, bonusResult.bonus_type, JSON.stringify(bonusResult.config), scrapedData.bonus_text, scrapedAt);
          bonusWritten = true;
        } catch (e) {
          console.log(`scrapeOne: bonus parse failed for ${retailerName}: ${e.message}`);
        }
      }

      if (parser && scrapedData.tc_text) {
        try {
          const tcResult = await parser.parseTAndC(scrapedData.tc_text, scrapedData.name);
          db.prepare(
            `INSERT INTO tc_rules (retailer_id, snapshot_id, inclusions, exclusions, raw_text, confidence, parsed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(retailerId, snapshotId, tcResult.inclusions.join(','), tcResult.exclusions.join(','), scrapedData.tc_text, tcResult.confidence, scrapedAt);
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

    // Last resort: write raw text with confidence=0
    if (!bonusWritten && scrapedData.bonus_text) {
      db.prepare(
        `INSERT INTO bonus_offers (retailer_id, snapshot_id, bonus_type, config_json, raw_text, parsed_at)
         VALUES (?, ?, 'flat_tiered', '{"tiers":[]}', ?, ?)`
      ).run(retailerId, snapshotId, scrapedData.bonus_text, scrapedAt);
    }

    if (!tcWritten && scrapedData.tc_text) {
      db.prepare(
        `INSERT INTO tc_rules (retailer_id, snapshot_id, inclusions, exclusions, raw_text, confidence, parsed_at)
         VALUES (?, ?, '', '', ?, 0.0, ?)`
      ).run(retailerId, snapshotId, scrapedData.tc_text, scrapedAt);
    }

    // Count retailers in new snapshot and mark complete
    const countRow = db.prepare(
      `SELECT COUNT(DISTINCT retailer_id) as cnt FROM retailer_rates WHERE snapshot_id = ?`
    ).get(snapshotId);
    completeSnapshot(db, snapshotId, countRow ? countRow.cnt : 1, 0);

    // Update last_scraped timestamp for this retailer
    db.prepare(`UPDATE retailers SET last_scraped = ? WHERE retailer_id = ?`).run(scrapedAt, retailerId);

    console.log(`scrapeOne: ${retailerName} scraped (${mode}) → snapshot ${snapshotId}`);
    db.close();

    return { success: true, retailer: scrapedData.name, snapshot_id: snapshotId, mode };

  } catch (err) {
    console.error(`scrapeOne: fatal error for ${retailerName}: ${err.message}`);
    try { failSnapshot(db, snapshotId, 1); } catch (_) {}
    db.close();
    return { success: false, retailer: retailerName, error: err.message };
  }
}

module.exports = { scrapeOne, scrapeOneRetailer, hasLiveSession };
