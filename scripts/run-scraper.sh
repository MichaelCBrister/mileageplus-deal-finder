#!/usr/bin/env bash
# run-scraper.sh — Thin wrapper to run the MileagePlus Shopping portal scraper.
# Usage: bash scripts/run-scraper.sh
# Set MILEAGEPLUS_USERNAME and MILEAGEPLUS_PASSWORD in environment for live mode.
# Without credentials, runs in mock mode with seed-matching data.
# Set SCRAPER_DEBUG=1 for non-headless browser (live mode only).

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/scraper" && JULIA_PKG_SERVER="" npm run scrape
