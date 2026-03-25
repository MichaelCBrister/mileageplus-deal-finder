// request-log.js — Audit log of every HTTP request made during a scrape session
// Phase 6: writes NDJSON to logs/scrape-requests.log per v3-spec.md section 2.4

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(__dirname, '..', '..', 'logs');
const LOG_PATH = path.join(LOG_DIR, 'scrape-requests.log');

/**
 * Append one NDJSON audit line for a scrape request.
 * Synchronous to ensure no dropped entries.
 * @param {string} snapshotId
 * @param {string} url
 * @param {string} method
 * @param {number|null} status - HTTP status code or null if request failed
 * @param {number} durationMs
 */
function logRequest(snapshotId, url, method, status, durationMs) {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  const entry = {
    timestamp: new Date().toISOString(),
    url,
    method,
    status,
    duration_ms: durationMs,
    snapshot_id: snapshotId,
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

module.exports = { logRequest };
