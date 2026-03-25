-- MileagePlus Deal Finder — Database Schema
-- Source: v3-spec.md Section 6
-- All tables use CREATE TABLE IF NOT EXISTS for idempotent initialization.

CREATE TABLE IF NOT EXISTS scrape_snapshots (
  snapshot_id    TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  retailer_count INTEGER,
  error_count    INTEGER DEFAULT 0,
  status         TEXT CHECK(status IN ('complete','partial','failed'))
);

CREATE TABLE IF NOT EXISTS retailers (
  retailer_id    INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  portal_url     TEXT,
  tax_included   BOOLEAN DEFAULT 0,
  shipping_included BOOLEAN DEFAULT 0,
  gc_portal_eligible BOOLEAN DEFAULT 0,
  gc_portal_source   TEXT
);

CREATE TABLE IF NOT EXISTS retailer_rates (
  rate_id        INTEGER PRIMARY KEY,
  retailer_id    INTEGER REFERENCES retailers,
  snapshot_id    TEXT REFERENCES scrape_snapshots,
  base_rate      REAL NOT NULL,
  rate_type      TEXT,
  category_rates TEXT,
  scraped_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mpx_rates (
  mpx_rate_id    INTEGER PRIMARY KEY,
  retailer_id    INTEGER REFERENCES retailers,
  snapshot_id    TEXT REFERENCES scrape_snapshots,
  mpx_rate       REAL NOT NULL,
  chase_bonus    REAL DEFAULT 0.25,
  scraped_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bonus_offers (
  bonus_id       INTEGER PRIMARY KEY,
  retailer_id    INTEGER REFERENCES retailers,
  snapshot_id    TEXT REFERENCES scrape_snapshots,
  bonus_type     TEXT CHECK(bonus_type IN ('flat_tiered','rate_multiplier','per_order_flat')),
  config_json    TEXT NOT NULL,
  active_from    TEXT,
  active_until   TEXT,
  raw_text       TEXT,
  parsed_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tc_rules (
  rule_id        INTEGER PRIMARY KEY,
  retailer_id    INTEGER REFERENCES retailers,
  snapshot_id    TEXT REFERENCES scrape_snapshots,
  inclusions     TEXT,
  exclusions     TEXT,
  raw_text       TEXT NOT NULL,
  confidence     REAL,
  parsed_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS process_constraints (
  constraint_id  INTEGER PRIMARY KEY,
  retailer_id    INTEGER REFERENCES retailers,
  constraint_type TEXT CHECK(constraint_type IN (
    'cookie_required','last_click','coupon_restriction',
    'single_session','posting_delay','other')),
  description    TEXT,
  severity       TEXT CHECK(severity IN ('info','warning','critical')),
  source         TEXT
);

CREATE TABLE IF NOT EXISTS purchase_log (
  purchase_id    INTEGER PRIMARY KEY,
  retailer_id    INTEGER REFERENCES retailers,
  path_type      TEXT CHECK(path_type IN ('direct','mpx','stacked')),
  p_list         REAL,
  p_portal       REAL,
  p_card         REAL,
  p_cash         REAL,
  v_residual     REAL DEFAULT 0,
  miles_expected INTEGER,
  miles_posted   INTEGER,
  risk_class     TEXT CHECK(risk_class IN ('confirmed','uncertain','excluded')),
  snapshot_id    TEXT REFERENCES scrape_snapshots,
  purchased_at   TEXT NOT NULL,
  posted_at      TEXT
);
