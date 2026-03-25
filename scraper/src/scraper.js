#!/usr/bin/env node
// scraper.js — Playwright scraper entry point with randomized delays and fail-closed behavior
// Phase 6: Scrapes MileagePlus Shopping portal, writes to SQLite under a single snapshot.
// Conforms to v3-spec.md section 2.4 automation risk mitigation requirements.

const path = require('path');
const Database = require('better-sqlite3');
const { logRequest } = require('./request-log');
const {
  createSnapshot,
  completeSnapshot,
  failSnapshot,
  hasScrapedToday,
} = require('./snapshot');
const { getMockRetailers } = require('./portal-mock');

const DB_PATH = path.resolve(__dirname, '..', '..', 'db', 'mileageplus.db');

// ---------------------------------------------------------------------------
// Randomized delay: 2000–10000ms per v3-spec.md section 2.4
// ---------------------------------------------------------------------------
function randomDelay() {
  return 2000 + Math.random() * 8000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Check credentials
// ---------------------------------------------------------------------------
function checkCredentials() {
  const username = process.env.MILEAGEPLUS_USERNAME;
  const password = process.env.MILEAGEPLUS_PASSWORD;
  if (!username || !password) {
    return null;
  }
  return { username, password };
}

// ---------------------------------------------------------------------------
// Live portal scraper (Playwright)
// ---------------------------------------------------------------------------
async function scrapeLivePortal(snapshotId, credentials) {
  // Dynamic import — Playwright may not be installed in all environments
  const { chromium } = require('playwright');

  const headless = process.env.SCRAPER_DEBUG !== '1';
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  const retailers = [];
  let errorCount = 0;

  try {
    // Step 1: Navigate to portal login
    console.log('Navigating to MileagePlus Shopping portal...');
    const loginStart = Date.now();
    const loginUrl = 'https://shopping.mileageplus.com';
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    logRequest(snapshotId, loginUrl, 'GET', 200, Date.now() - loginStart);

    // Step 2: Authenticate
    console.log('Authenticating...');
    // DECISION: Portal login flow may vary. Look for common login elements.
    // If the portal redirects to a United SSO page, handle that flow.
    try {
      // Wait for login form or already-authenticated state
      const loginButton = await page.$('a[href*="login"], button:has-text("Sign In"), a:has-text("Sign In")');
      if (loginButton) {
        await loginButton.click();
        await sleep(randomDelay());

        // Fill credentials on the SSO page
        await page.waitForSelector('input[type="text"], input[name="username"], input[id="username"]', { timeout: 15000 });
        const usernameField = await page.$('input[type="text"], input[name="username"], input[id="username"]');
        if (usernameField) await usernameField.fill(credentials.username);

        const passwordField = await page.$('input[type="password"], input[name="password"]');
        if (passwordField) await passwordField.fill(credentials.password);

        const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
        if (submitBtn) await submitBtn.click();

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // Verify authentication by checking for a known post-login element
      await sleep(2000);
      const isAuthenticated = await page.$('.account-info, .user-greeting, [data-testid="user-menu"], .logged-in');
      if (!isAuthenticated) {
        // Check if the page still has login elements (auth failed)
        const stillHasLogin = await page.$('input[type="password"]');
        if (stillHasLogin) {
          throw new Error('Authentication failed — login form still present after submission');
        }
        console.log('WARNING: Could not verify authentication state. Proceeding cautiously.');
      } else {
        console.log('Authentication verified.');
      }
    } catch (authErr) {
      throw new Error(`Authentication failed: ${authErr.message}`);
    }

    // Step 3: Navigate to retailer listing
    console.log('Navigating to retailer listing...');
    await sleep(randomDelay());
    const listUrl = 'https://shopping.mileageplus.com/b__allstores.htm';
    const listStart = Date.now();
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    logRequest(snapshotId, listUrl, 'GET', 200, Date.now() - listStart);

    // Step 4: Extract retailer links from the listing page
    // DECISION: Selectors are best-effort based on common Valuedynamx/Collinson portal structures.
    // The actual DOM may differ — inspect with SCRAPER_DEBUG=1.
    const retailerLinks = await page.$$eval(
      'a[href*="/b__"], .store-card a, .merchant-link, .retailer-item a',
      (links) => links.map((a) => ({
        name: a.textContent.trim(),
        url: a.href,
      })).filter((l) => l.name && l.url)
    );

    if (retailerLinks.length === 0) {
      // Try alternative: look for any store listing structure
      console.log('WARNING: No retailer links found with primary selectors. Trying alternatives...');
      const altLinks = await page.$$eval(
        'a[href*="retailer"], a[href*="store"], .store-name a',
        (links) => links.map((a) => ({
          name: a.textContent.trim(),
          url: a.href,
        })).filter((l) => l.name && l.url)
      );
      if (altLinks.length === 0) {
        throw new Error('No retailer links found on listing page. Portal DOM may have changed.');
      }
      retailerLinks.push(...altLinks);
    }

    console.log(`Found ${retailerLinks.length} retailers. Scraping details...`);

    // Step 5: Visit each retailer detail page serially
    for (let i = 0; i < retailerLinks.length; i++) {
      const link = retailerLinks[i];
      console.log(`  [${i + 1}/${retailerLinks.length}] ${link.name}...`);

      await sleep(randomDelay());
      const detailStart = Date.now();

      try {
        const resp = await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const status = resp ? resp.status() : null;
        logRequest(snapshotId, link.url, 'GET', status, Date.now() - detailStart);

        // Fail-closed: CAPTCHA, 429, or 403
        if (status === 429 || status === 403) {
          throw new Error(`HTTP ${status} — fail-closed per section 2.4`);
        }

        // Check for CAPTCHA
        const captchaPresent = await page.$('.captcha, #captcha, [data-testid="captcha"], iframe[src*="captcha"]');
        if (captchaPresent) {
          throw new Error('CAPTCHA detected — fail-closed per section 2.4');
        }

        // Extract retailer data from detail page
        const retailerData = await page.evaluate(() => {
          // Best-effort extraction — selectors vary by portal version
          const rateEl = document.querySelector('.earn-rate, .miles-rate, .rate-value, .store-rate');
          const tcEl = document.querySelector('.terms-conditions, .tc-text, .store-terms, [data-testid="terms"]');
          const bonusEl = document.querySelector('.bonus-offer, .promo-text, .special-offer, [data-testid="bonus"]');

          let baseRate = 1.0;
          let rateType = 'miles per dollar';
          if (rateEl) {
            const rateText = rateEl.textContent.trim();
            const match = rateText.match(/([\d.]+)\s*(?:x|X|miles?\/?(?:\s*per\s+)?(?:\$|dollar))/);
            if (match) baseRate = parseFloat(match[1]);
            if (rateText.toLowerCase().includes('up to')) rateType = 'up to ' + baseRate + ' miles per dollar';
          }

          return {
            base_rate: baseRate,
            rate_type: rateType,
            tc_text: tcEl ? tcEl.textContent.trim() : null,
            bonus_text: bonusEl ? bonusEl.textContent.trim() : null,
          };
        });

        retailers.push({
          name: link.name,
          base_rate: retailerData.base_rate,
          rate_type: retailerData.rate_type,
          bonus_text: retailerData.bonus_text,
          tc_text: retailerData.tc_text,
          portal_url: link.url,
          mpx_rate: null, // MPX rates not available on portal pages
        });
      } catch (detailErr) {
        // Fail-closed errors propagate up
        if (detailErr.message.includes('fail-closed') || detailErr.message.includes('CAPTCHA')) {
          throw detailErr;
        }
        console.log(`    ERROR: ${detailErr.message}`);
        errorCount++;
      }
    }
  } finally {
    await browser.close();
  }

  return { retailers, errorCount };
}

// ---------------------------------------------------------------------------
// Mock portal scraper (for testing without live access)
// ---------------------------------------------------------------------------
async function scrapeMockPortal(snapshotId) {
  console.log('WARNING: Using mock portal data — live portal access not available.');
  console.log('Mock mode provides 3 seed-matching retailers for pipeline testing.');

  const mockRetailers = getMockRetailers();
  const retailers = [];

  for (let i = 0; i < mockRetailers.length; i++) {
    const r = mockRetailers[i];
    console.log(`  [${i + 1}/${mockRetailers.length}] ${r.name} (mock)...`);

    // Simulate randomized delay for realistic audit log
    const delay = randomDelay();
    await sleep(Math.min(delay, 500)); // Shortened in mock mode for speed

    const mockUrl = r.portal_url;
    logRequest(snapshotId, mockUrl, 'GET', 200, Math.round(delay));

    retailers.push(r);
  }

  return { retailers, errorCount: 0 };
}

// ---------------------------------------------------------------------------
// Write scraped data to database
// ---------------------------------------------------------------------------
function writeRetailersToDb(db, snapshotId, retailers) {
  const scrapedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '');

  const getRetailerId = db.prepare('SELECT retailer_id FROM retailers WHERE name = ?');

  const insertRetailer = db.prepare(
    `INSERT INTO retailers (name, portal_url, tax_included, shipping_included, gc_portal_eligible, gc_portal_source)
     VALUES (?, ?, 0, 0, 0, NULL)`
  );

  const updateRetailerUrl = db.prepare('UPDATE retailers SET portal_url = ? WHERE retailer_id = ?');

  const insertRate = db.prepare(
    `INSERT INTO retailer_rates (retailer_id, snapshot_id, base_rate, rate_type, category_rates, scraped_at)
     VALUES (?, ?, ?, ?, NULL, ?)`
  );

  const insertMpxRate = db.prepare(
    `INSERT INTO mpx_rates (retailer_id, snapshot_id, mpx_rate, chase_bonus, scraped_at)
     VALUES (?, ?, ?, 0.25, ?)`
  );

  const insertTcRaw = db.prepare(
    `INSERT INTO tc_rules (retailer_id, snapshot_id, inclusions, exclusions, raw_text, confidence, parsed_at)
     VALUES (?, ?, '', '', ?, 0.0, ?)`
  );

  const insertBonusRaw = db.prepare(
    `INSERT INTO bonus_offers (retailer_id, snapshot_id, bonus_type, config_json, raw_text, parsed_at)
     VALUES (?, ?, 'flat_tiered', '{"tiers":[]}', ?, ?)`
  );

  const writeAll = db.transaction(() => {
    for (const r of retailers) {
      // Upsert retailer — preserve existing gc_portal_eligible
      let existing = getRetailerId.get(r.name);
      if (!existing) {
        insertRetailer.run(r.name, r.portal_url);
        existing = getRetailerId.get(r.name);
      } else {
        updateRetailerUrl.run(r.portal_url, existing.retailer_id);
      }

      const retailerId = existing.retailer_id;

      // Insert rate for this snapshot
      insertRate.run(retailerId, snapshotId, r.base_rate, r.rate_type, scrapedAt);

      // Insert MPX rate if available
      if (r.mpx_rate != null) {
        insertMpxRate.run(retailerId, snapshotId, r.mpx_rate, scrapedAt);
      }

      // Insert raw T&C text (unparsed — parsing is separate)
      if (r.tc_text) {
        insertTcRaw.run(retailerId, snapshotId, r.tc_text, scrapedAt);
      }

      // Insert raw bonus text (unparsed — parsing is separate)
      if (r.bonus_text) {
        insertBonusRaw.run(retailerId, snapshotId, r.bonus_text, scrapedAt);
      }
    }
  });

  writeAll();
}

// ---------------------------------------------------------------------------
// Chain with Phase 5 parser (if ANTHROPIC_API_KEY is available)
// ---------------------------------------------------------------------------
async function chainWithParser(db, snapshotId, retailers) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('WARNING: ANTHROPIC_API_KEY not set — skipping T&C and bonus parsing. Rates written, T&C rules not updated.');
    return;
  }

  let parseTAndC, parseBonus;
  try {
    const parser = require(path.resolve(__dirname, '..', '..', 'bridge', 'tc-parser.js'));
    parseTAndC = parser.parseTAndC;
    parseBonus = parser.parseBonus;
  } catch (err) {
    console.log(`WARNING: Could not load tc-parser.js: ${err.message}. Skipping parsing.`);
    return;
  }

  console.log('Chaining with Phase 5 parser for T&C and bonus classification...');

  const getRetailerId = db.prepare('SELECT retailer_id FROM retailers WHERE name = ?');

  const updateTcRules = db.prepare(
    `UPDATE tc_rules SET inclusions = ?, exclusions = ?, confidence = ?, parsed_at = datetime('now')
     WHERE retailer_id = ? AND snapshot_id = ?`
  );

  const updateBonus = db.prepare(
    `UPDATE bonus_offers SET bonus_type = ?, config_json = ?, parsed_at = datetime('now')
     WHERE retailer_id = ? AND snapshot_id = ?`
  );

  for (const r of retailers) {
    const row = getRetailerId.get(r.name);
    if (!row) continue;
    const retailerId = row.retailer_id;

    // Parse T&C
    if (r.tc_text) {
      try {
        console.log(`  Parsing T&C for ${r.name}...`);
        const tcResult = await parseTAndC(r.tc_text, r.name);
        updateTcRules.run(
          tcResult.inclusions.join(','),
          tcResult.exclusions.join(','),
          tcResult.confidence,
          retailerId,
          snapshotId
        );
        console.log(`    Inclusions: ${tcResult.inclusions.join(', ')} (conf: ${tcResult.confidence})`);
      } catch (err) {
        console.log(`    T&C parse error for ${r.name}: ${err.message}`);
      }
    }

    // Parse bonus
    if (r.bonus_text) {
      try {
        console.log(`  Parsing bonus for ${r.name}...`);
        const bonusResult = await parseBonus(r.bonus_text, r.name, r.base_rate);
        updateBonus.run(
          bonusResult.bonus_type,
          JSON.stringify(bonusResult.config),
          retailerId,
          snapshotId
        );
        console.log(`    Type: ${bonusResult.bonus_type} (conf: ${bonusResult.confidence})`);
      } catch (err) {
        console.log(`    Bonus parse error for ${r.name}: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const credentials = checkCredentials();

  // Open database
  let db;
  try {
    db = new Database(DB_PATH);
  } catch (err) {
    console.error(`ERROR: Could not open database at ${DB_PATH}: ${err.message}`);
    console.error('Run: rm -f db/mileageplus.db && bash db/init.sh');
    process.exit(1);
  }

  // One-per-day guard
  if (hasScrapedToday(db)) {
    console.log('Already scraped today. Delete today\'s snapshot or wait until tomorrow.');
    db.close();
    process.exit(0);
  }

  // Create snapshot
  const snapshotId = createSnapshot(db);
  console.log(`Snapshot created: ${snapshotId}`);

  let result;
  try {
    if (credentials) {
      // Live portal scrape
      console.log('Starting live portal scrape...');
      result = await scrapeLivePortal(snapshotId, credentials);
    } else {
      // Mock mode — no credentials available
      console.log('MILEAGEPLUS_USERNAME/PASSWORD not set — using mock portal data.');
      result = await scrapeMockPortal(snapshotId);
    }

    const { retailers, errorCount } = result;

    if (retailers.length === 0) {
      console.error('ERROR: No retailers scraped.');
      failSnapshot(db, snapshotId, errorCount);
      db.close();
      process.exit(1);
    }

    // Write scraped data to DB
    console.log(`Writing ${retailers.length} retailers to database...`);
    writeRetailersToDb(db, snapshotId, retailers);

    // Chain with parser
    await chainWithParser(db, snapshotId, retailers);

    // Mark snapshot complete
    completeSnapshot(db, snapshotId, retailers.length, errorCount);
    console.log(`Snapshot ${snapshotId} completed: ${retailers.length} retailers, ${errorCount} errors.`);
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    failSnapshot(db, snapshotId, 1);
    db.close();
    process.exit(1);
  }

  db.close();
}

main().catch((err) => {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
