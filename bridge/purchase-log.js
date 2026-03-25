// purchase-log.js — Database operations for purchase log (Phase 7)
// All purchase log operations live in the Node bridge, not in the Julia engine.

/**
 * Insert a purchase log entry.
 * @param {Database} db - better-sqlite3 database instance
 * @param {object} data - purchase data
 * @returns {object} inserted row with purchase_id
 */
function insertPurchase(db, data) {
  const retailer = db.prepare(
    "SELECT retailer_id FROM retailers WHERE LOWER(REPLACE(name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))"
  ).get(data.retailer);

  if (!retailer) {
    return { error: 'retailer_not_found', retailer: data.retailer };
  }

  const now = new Date();
  const purchasedAt = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}T${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}`;

  // Fill in spend vector defaults if only p_list provided
  const p_list = data.p_list;
  const p_portal = data.p_portal != null ? data.p_portal : p_list;
  const p_card = data.p_card != null ? data.p_card : p_list;
  const p_cash = data.p_cash != null ? data.p_cash : p_list;
  const v_residual = data.v_residual != null ? data.v_residual : 0;

  const stmt = db.prepare(
    `INSERT INTO purchase_log (retailer_id, path_type, p_list, p_portal, p_card, p_cash, v_residual,
       miles_expected, miles_posted, risk_class, snapshot_id, purchased_at, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`
  );

  const result = stmt.run(
    retailer.retailer_id,
    data.path_type,
    p_list,
    p_portal,
    p_card,
    p_cash,
    v_residual,
    data.miles_expected,
    data.risk_class,
    data.snapshot_id,
    purchasedAt
  );

  return {
    purchase_id: result.lastInsertRowid,
    retailer_name: data.retailer,
    path_type: data.path_type,
    p_list,
    p_portal,
    p_card,
    p_cash,
    v_residual,
    miles_expected: data.miles_expected,
    miles_posted: null,
    risk_class: data.risk_class,
    snapshot_id: data.snapshot_id,
    purchased_at: purchasedAt,
    posted_at: null,
  };
}

/**
 * List all purchases with retailer names and posting status.
 * @param {Database} db - better-sqlite3 database instance
 * @returns {object} { purchases: [...], count: N }
 */
function listPurchases(db) {
  const rows = db.prepare(
    `SELECT p.purchase_id, r.name AS retailer_name, p.path_type,
            p.p_list, p.p_portal, p.p_card, p.p_cash, p.v_residual,
            p.miles_expected, p.miles_posted, p.risk_class,
            p.snapshot_id, p.purchased_at, p.posted_at
     FROM purchase_log p
     JOIN retailers r ON p.retailer_id = r.retailer_id
     ORDER BY p.purchased_at DESC`
  ).all();

  const now = Date.now();
  // 90-day threshold for overdue status
  // NOTE: Some retailers may take up to 120 days to post, but 90 days is the standard threshold per v3-spec.md section 3.4
  const NINETY_DAYS_MS = 90 * 24 * 3600 * 1000;

  const purchases = rows.map((row) => {
    let posting_status;
    if (row.miles_posted != null) {
      posting_status = 'posted';
    } else {
      const purchasedTime = new Date(row.purchased_at).getTime();
      const elapsed = now - purchasedTime;
      posting_status = elapsed > NINETY_DAYS_MS ? 'overdue' : 'pending';
    }
    return { ...row, posting_status };
  });

  return { purchases, count: purchases.length };
}

/**
 * Mark a purchase as having miles posted.
 * @param {Database} db - better-sqlite3 database instance
 * @param {number} purchaseId
 * @param {number} milesPosted
 * @param {string|null} postedAt - ISO timestamp, defaults to current UTC
 * @returns {object|null} updated row or null if not found
 */
function markPosted(db, purchaseId, milesPosted, postedAt) {
  if (!postedAt) {
    const now = new Date();
    postedAt = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}T${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}`;
  }

  const result = db.prepare(
    `UPDATE purchase_log SET miles_posted = ?, posted_at = ? WHERE purchase_id = ?`
  ).run(milesPosted, postedAt, purchaseId);

  if (result.changes === 0) return null;

  const row = db.prepare(
    `SELECT p.purchase_id, r.name AS retailer_name, p.path_type,
            p.p_list, p.p_portal, p.p_card, p.p_cash, p.v_residual,
            p.miles_expected, p.miles_posted, p.risk_class,
            p.snapshot_id, p.purchased_at, p.posted_at
     FROM purchase_log p
     JOIN retailers r ON p.retailer_id = r.retailer_id
     WHERE p.purchase_id = ?`
  ).get(purchaseId);

  return { ...row, posting_status: 'posted' };
}

/**
 * Delete a purchase log entry.
 * @param {Database} db - better-sqlite3 database instance
 * @param {number} purchaseId
 * @returns {boolean} true if deleted, false if not found
 */
function deletePurchase(db, purchaseId) {
  const result = db.prepare(
    `DELETE FROM purchase_log WHERE purchase_id = ?`
  ).run(purchaseId);
  return result.changes > 0;
}

module.exports = { insertPurchase, listPurchases, markPosted, deletePurchase };
