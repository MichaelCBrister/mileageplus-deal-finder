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

# Apply seed data (INSERT OR IGNORE / INSERT OR REPLACE makes this idempotent)
sqlite3 "${DB_PATH}" < "${SCRIPT_DIR}/seed.sql"
echo "Seed data applied."

echo "Database initialization complete."
echo "Tables:"
sqlite3 "${DB_PATH}" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
