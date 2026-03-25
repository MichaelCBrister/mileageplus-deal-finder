// snapshot.js — Snapshot management: create, complete, and query scrape snapshots
// Phase 6: manages scrape snapshot lifecycle in SQLite via better-sqlite3.

const crypto = require('crypto');

/**
 * Format a Date as ISO8601 without milliseconds or Z suffix.
 * The Julia engine's snapshot_age_hours expects format "yyyy-mm-ddTHH:MM:SS".
 */
function formatTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

/**
 * Create a new scrape snapshot row.
 * @param {import('better-sqlite3').Database} db
 * @returns {string} snapshot_id
 */
function createSnapshot(db) {
  const snapshotId = crypto.randomUUID();
  const startedAt = formatTimestamp(new Date());
  db.prepare(
    `INSERT INTO scrape_snapshots (snapshot_id, started_at, completed_at, retailer_count, error_count, status)
     VALUES (?, ?, NULL, 0, 0, 'partial')`
  ).run(snapshotId, startedAt);
  return snapshotId;
}

/**
 * Mark a snapshot as complete.
 * @param {import('better-sqlite3').Database} db
 * @param {string} snapshotId
 * @param {number} retailerCount
 * @param {number} errorCount
 */
function completeSnapshot(db, snapshotId, retailerCount, errorCount) {
  const completedAt = formatTimestamp(new Date());
  db.prepare(
    `UPDATE scrape_snapshots SET status = 'complete', completed_at = ?, retailer_count = ?, error_count = ?
     WHERE snapshot_id = ?`
  ).run(completedAt, retailerCount, errorCount, snapshotId);
}

/**
 * Mark a snapshot as failed.
 * @param {import('better-sqlite3').Database} db
 * @param {string} snapshotId
 * @param {number} errorCount
 */
function failSnapshot(db, snapshotId, errorCount) {
  const completedAt = formatTimestamp(new Date());
  db.prepare(
    `UPDATE scrape_snapshots SET status = 'failed', completed_at = ?, error_count = ?
     WHERE snapshot_id = ?`
  ).run(completedAt, errorCount, snapshotId);
}

/**
 * Get the most recent complete snapshot or null.
 * @param {import('better-sqlite3').Database} db
 * @returns {object|null}
 */
function getLatestCompleteSnapshot(db) {
  return db.prepare(
    `SELECT snapshot_id, started_at, completed_at, retailer_count, error_count, status
     FROM scrape_snapshots WHERE status = 'complete'
     ORDER BY completed_at DESC LIMIT 1`
  ).get() || null;
}

/**
 * Check if a scrape has already been started today (UTC).
 * Returns true if a complete or partial snapshot was started today.
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
function hasScrapedToday(db) {
  const todayUTC = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM scrape_snapshots
     WHERE status IN ('complete', 'partial')
     AND started_at >= ? AND started_at < ?`
  ).get(todayUTC + 'T00:00:00', todayUTC + 'T99:99:99');
  return row.cnt > 0;
}

module.exports = {
  createSnapshot,
  completeSnapshot,
  failSnapshot,
  getLatestCompleteSnapshot,
  hasScrapedToday,
};
