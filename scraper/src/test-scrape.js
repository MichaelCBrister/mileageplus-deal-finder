#!/usr/bin/env node
// test-scrape.js — Test the live scraper by scraping a single retailer
// Uses the saved browser context from portal-login.js.
// Updates the database with real data if the scrape succeeds.

const path = require('path');
const { scrapeOne, scrapeOneRetailer, hasLiveSession } = require('./scrape-one');

const RETAILER = process.argv[2] || 'Best Buy';

async function main() {
  console.log(`=== Test Scrape: "${RETAILER}" ===\n`);

  if (hasLiveSession()) {
    console.log('Live browser session found. Using LIVE mode.\n');
  } else {
    console.log('No live browser session found. Using MOCK mode.');
    console.log("Run 'npm run portal-login' first to enable live scraping.\n");
  }

  // If live session exists, first test the raw scraper to show extracted data
  if (hasLiveSession()) {
    console.log('--- Raw scraper output ---');
    try {
      const raw = await scrapeOneRetailer(RETAILER);
      console.log(JSON.stringify(raw, null, 2));
      console.log();
    } catch (err) {
      console.error('Raw scraper failed:', err.message);
      if (err.message === 'SESSION_EXPIRED') {
        console.error("Run 'npm run portal-login' to re-authenticate.");
        process.exit(1);
      }
    }
  }

  // Now run the full scrapeOne pipeline (writes to DB)
  console.log('--- Database update ---');
  const result = await scrapeOne(RETAILER);

  if (result.success) {
    console.log(`\nSuccess! Retailer "${result.retailer}" updated.`);
    console.log(`  Mode: ${result.mode}`);
    console.log(`  Snapshot: ${result.snapshot_id}`);

    // Read back the data from DB to confirm
    const Database = require('better-sqlite3');
    const dbPath = path.resolve(__dirname, '..', '..', 'db', 'mileageplus.db');
    try {
      const db = new Database(dbPath);
      const retailer = db.prepare(
        `SELECT r.name, r.portal_url, r.last_scraped,
                rr.base_rate, rr.rate_type,
                bo.bonus_type, bo.config_json, bo.raw_text as bonus_raw,
                tc.inclusions, tc.exclusions, tc.raw_text as tc_raw, tc.confidence
         FROM retailers r
         LEFT JOIN retailer_rates rr ON r.retailer_id = rr.retailer_id AND rr.snapshot_id = ?
         LEFT JOIN bonus_offers bo ON r.retailer_id = bo.retailer_id AND bo.snapshot_id = ?
         LEFT JOIN tc_rules tc ON r.retailer_id = tc.retailer_id AND tc.snapshot_id = ?
         WHERE LOWER(REPLACE(r.name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))`
      ).get(result.snapshot_id, result.snapshot_id, result.snapshot_id, RETAILER);
      db.close();

      if (retailer) {
        console.log('\n--- Database record ---');
        console.log(JSON.stringify(retailer, null, 2));
      }
    } catch (err) {
      console.warn('Could not read back from DB:', err.message);
    }
  } else {
    console.error(`\nFailed: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
