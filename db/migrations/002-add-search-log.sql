-- Migration 002: Add search_log table
-- Phase 11: records every /api/search call for analytics and debugging.
-- v2-spec.md Section 8.
--
-- Uses CREATE TABLE IF NOT EXISTS — idempotent.

CREATE TABLE IF NOT EXISTS search_log (
  search_id          TEXT PRIMARY KEY,
  query              TEXT NOT NULL,
  interpreted_category TEXT,
  estimated_price    REAL,
  likely_retailers   TEXT,
  card_tier          TEXT,
  result_count       INTEGER,
  top_retailer       TEXT,
  top_miles          INTEGER,
  searched_at        TEXT NOT NULL
);
