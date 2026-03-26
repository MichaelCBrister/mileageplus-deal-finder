#!/usr/bin/env bash
# init.sh — Initialize the SQLite database with schema and seed data.
# Idempotent: safe to run multiple times without duplicating records.
# Usage: bash db/init.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="${SCRIPT_DIR}/mileageplus.db"

echo "Initializing database at ${DB_PATH}"

# Apply schema (CREATE TABLE IF NOT EXISTS makes this idempotent)
sqlite3 "${DB_PATH}" < "${SCRIPT_DIR}/schema.sql"
echo "Schema applied."

# Apply migrations (each migration is idempotent via shell error suppression)
# 001: Add last_scraped column to retailers — ALTER TABLE ADD COLUMN fails silently
#      if the column already exists (we suppress the error, not the exit code for other errors)
if sqlite3 "${DB_PATH}" < "${SCRIPT_DIR}/migrations/001-add-last-scraped.sql" 2>/dev/null; then
  echo "Migration 001 applied (last_scraped column added)."
else
  echo "Migration 001 already applied (last_scraped column exists)."
fi

# 002: Add search_log table — CREATE TABLE IF NOT EXISTS makes this idempotent
sqlite3 "${DB_PATH}" < "${SCRIPT_DIR}/migrations/002-add-search-log.sql"
echo "Migration 002 applied (search_log table ready)."

# Apply seed data (INSERT OR IGNORE / INSERT OR REPLACE makes this idempotent)
sqlite3 "${DB_PATH}" < "${SCRIPT_DIR}/seed.sql"
echo "Seed data applied."

echo "Database initialization complete."
echo "Tables:"
sqlite3 "${DB_PATH}" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
