-- Migration 001: Add last_scraped column to retailers table
-- Phase 10: tracks when each retailer was last individually scraped,
-- enabling per-retailer freshness checks independent of snapshot timestamps.
--
-- This is idempotent: SQLite silently succeeds if the column already exists
-- in newer versions, but older SQLite versions raise "duplicate column name".
-- init.sh wraps this in a try-catch using the shell.

ALTER TABLE retailers ADD COLUMN last_scraped TEXT;
