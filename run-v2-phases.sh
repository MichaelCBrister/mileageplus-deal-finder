#!/bin/bash
# run-v2-phases.sh — Automated v2 build orchestrator
# Runs each phase (10-15) as a separate Claude Code non-interactive session.
#
# PREREQUISITES:
#   1. Claude Code CLI installed: npm install -g @anthropic-ai/claude-code
#   2. Julia and Node installed and on PATH
#   3. v1 working locally (bash scripts/start-dev.sh succeeds)
#   4. docs/v2-spec.md committed to the repo
#   5. .env file in repo root with ANTHROPIC_API_KEY (see below)
#
# USAGE:
#   cd ~/mileageplus-deal-finder
#   bash run-v2-phases.sh
#
# The script reads ANTHROPIC_API_KEY from .env automatically.
# If a phase fails, fix the issue and re-run — completed phases are skipped.
#
# 2FA NOTE: The MileagePlus portal requires 2FA. The scraper uses MOCK DATA
# during automated builds. After all phases complete, run the manual portal
# login script to save browser cookies, then test live scraping separately.

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/logs/v2-build"
mkdir -p "$LOG_DIR"

# ─── Load .env ────────────────────────────────────────────────────────────────
if [ -f "$ROOT/.env" ]; then
  echo "Loading .env file..."
  set -a
  source "$ROOT/.env"
  set +a
else
  echo "WARNING: No .env file found at $ROOT/.env"
  echo "Create one with at minimum:"
  echo "  ANTHROPIC_API_KEY=sk-ant-your-key-here"
  echo ""
  echo "The build can proceed without it but API-dependent features won't work."
  echo ""
fi

# ─── Pre-flight checks ───────────────────────────────────────────────────────
echo "=== Pre-flight checks ==="
PREFLIGHT_OK=true

command -v claude >/dev/null 2>&1 || { echo "FAIL: claude CLI not installed. Run: npm install -g @anthropic-ai/claude-code"; PREFLIGHT_OK=false; }
command -v julia >/dev/null 2>&1 || { echo "FAIL: julia not on PATH"; PREFLIGHT_OK=false; }
command -v node >/dev/null 2>&1 || { echo "FAIL: node not on PATH"; PREFLIGHT_OK=false; }
command -v sqlite3 >/dev/null 2>&1 || { echo "FAIL: sqlite3 not installed"; PREFLIGHT_OK=false; }

[ -f "$ROOT/docs/v2-spec.md" ] || { echo "FAIL: docs/v2-spec.md not found. Commit the v2 spec first."; PREFLIGHT_OK=false; }
[ -f "$ROOT/CLAUDE.md" ] || { echo "FAIL: CLAUDE.md not found. Are you in the right repo?"; PREFLIGHT_OK=false; }
[ -f "$ROOT/docs/v3-spec.md" ] || { echo "FAIL: docs/v3-spec.md not found."; PREFLIGHT_OK=false; }
[ -f "$ROOT/db/schema.sql" ] || { echo "FAIL: db/schema.sql not found."; PREFLIGHT_OK=false; }

if [ "$PREFLIGHT_OK" = false ]; then
  echo ""
  echo "Pre-flight checks failed. Fix the issues above and re-run."
  exit 1
fi

echo "julia:   $(julia --version 2>&1)"
echo "node:    $(node --version 2>&1)"
echo "claude:  $(claude --version 2>&1 || echo 'version unknown')"
echo "API key: ${ANTHROPIC_API_KEY:+set (${#ANTHROPIC_API_KEY} chars)}${ANTHROPIC_API_KEY:-NOT SET}"
echo ""
echo "All pre-flight checks passed."
echo ""

# ─── Initialize database if needed ────────────────────────────────────────────
if [ ! -f "$ROOT/db/mileageplus.db" ]; then
  echo "Initializing database..."
  cd "$ROOT" && bash db/init.sh
  echo ""
fi

# ─── Verify v1 Julia tests pass before starting ──────────────────────────────
echo "=== Verifying v1 test baseline ==="
cd "$ROOT/engine"
if JULIA_PKG_SERVER="" julia --project test/runtests.jl 2>&1 | tail -5; then
  echo "Baseline tests pass."
else
  echo "FAIL: v1 tests do not pass. Fix the Julia engine before running v2 build."
  exit 1
fi
echo ""

# ─── Helper: kill stale processes ─────────────────────────────────────────────
kill_stale_processes() {
  pkill -f "julia.*server.jl" 2>/dev/null || true
  pkill -f "node.*server.js" 2>/dev/null || true
  pkill -f "vite" 2>/dev/null || true
  sleep 2
}

# ─── Helper: check if phase is already done ───────────────────────────────────
# Uses word-boundary matching so "Phase 1" doesn't match "Phase 10"
phase_done() {
  local PHASE_NUM=$1
  cd "$ROOT"
  git log --oneline 2>/dev/null | grep -qiE "^[a-f0-9]+ phase ${PHASE_NUM}:" && return 0
  return 1
}

# ─── Helper: run a single phase ───────────────────────────────────────────────
run_phase() {
  local PHASE_NUM=$1
  local PHASE_PROMPT=$2
  local LOG_FILE="$LOG_DIR/phase${PHASE_NUM}.log"
  local STARTED_AT=$(date)

  echo "=============================================="
  echo "  PHASE $PHASE_NUM — Starting"
  echo "  Log: $LOG_FILE"
  echo "  Time: $STARTED_AT"
  echo "=============================================="

  # Kill any stale processes from prior phase
  kill_stale_processes

  # Always run from repo root
  cd "$ROOT"

  # Run Claude Code non-interactively with permission skip
  # Timeout after 30 minutes per phase to prevent infinite hangs
  gtimeout 1800 claude --dangerously-skip-permissions -p "$PHASE_PROMPT" 2>&1 | tee "$LOG_FILE"

  local EXIT_CODE=${PIPESTATUS[0]}

  # timeout returns 124 on timeout
  if [ $EXIT_CODE -eq 124 ]; then
    echo ""
    echo "!!! PHASE $PHASE_NUM TIMED OUT (30 minutes) !!!"
    echo "The session may have gotten stuck. Review log: $LOG_FILE"
    echo "Fix any issues and re-run this script."
    kill_stale_processes
    exit 1
  fi

  if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    echo "!!! PHASE $PHASE_NUM FAILED (exit code $EXIT_CODE) !!!"
    echo "Review log: $LOG_FILE"
    echo "Fix the issue, then re-run this script — completed phases will be skipped."
    kill_stale_processes
    exit 1
  fi

  # Kill any processes the phase may have started for acceptance tests
  kill_stale_processes

  # Verify Julia tests still pass
  echo ""
  echo "--- Verifying Julia tests after Phase $PHASE_NUM ---"
  cd "$ROOT/engine"
  local TEST_OUTPUT
  TEST_OUTPUT=$(JULIA_PKG_SERVER="" julia --project test/runtests.jl 2>&1)
  local TEST_EXIT=$?
  echo "$TEST_OUTPUT" | tail -5
  echo "$TEST_OUTPUT" >> "$LOG_FILE"

  if [ $TEST_EXIT -ne 0 ]; then
    echo "!!! JULIA TESTS FAILED AFTER PHASE $PHASE_NUM !!!"
    echo "Review log: $LOG_FILE"
    kill_stale_processes
    exit 1
  fi
  echo "Julia tests passed."

  # Commit if there are uncommitted changes
  cd "$ROOT"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "--- Committing Phase $PHASE_NUM ---"
    git add -A
    git commit -m "Phase ${PHASE_NUM}: automated v2 build" || true
    git push origin HEAD 2>/dev/null || echo "  (Push failed — non-fatal, will push at end)"
  fi

  local ENDED_AT=$(date)
  echo ""
  echo "=== PHASE $PHASE_NUM COMPLETE ==="
  echo "  Started: $STARTED_AT"
  echo "  Ended:   $ENDED_AT"
  echo ""

  # Brief pause between phases to let system settle
  sleep 5
}

###############################################################################
# PHASE 10: Single-retailer on-demand scraper + freshness middleware
###############################################################################
if ! phase_done 10; then
PHASE_10_PROMPT='Read CLAUDE.md, docs/v3-spec.md, and docs/v2-spec.md before writing any code. Read docs/phase6-session-summary.txt to understand the existing scraper.

Implement Phase 10: Single-retailer on-demand scraper + freshness middleware.

IMPORTANT CONTEXT — 2FA AND MOCK MODE:
The MileagePlus Shopping portal requires two-factor authentication. The scraper CANNOT auto-login with just username and password. For this phase, all scraping uses MOCK DATA via scraper/src/portal-mock.js. The mock is already implemented from Phase 6. Do NOT attempt to implement auto-login or test against the live portal. Live portal scraping with a pre-authenticated browser session will be set up manually after the automated build.

What to build:

1. Add a scrapeOne(retailerName) function to scraper/src/scraper.js (or a new file scraper/src/scrape-one.js). It takes a retailer name, calls the mock portal data for that retailer, parses T&C and bonus text with the Claude API if ANTHROPIC_API_KEY is set, and updates the database. If ANTHROPIC_API_KEY is not set, it still writes raw text to the database with confidence=0.0. The function must be callable from Node.js code (exported), not just CLI.

2. Add a last_scraped column to the retailers table. Create a migration file db/migrations/001-add-last-scraped.sql. Apply it in db/init.sh. Update last_scraped whenever a retailer is scraped.

3. Add freshness-checking middleware to bridge/server.js. Create a function checkFreshness(retailerName) that queries the retailers table for last_scraped. If null or older than 24 hours, return stale=true. The threshold should be configurable via environment variable FRESHNESS_HOURS (default 24).

4. Wire the freshness check into the existing /api/score and /api/rank endpoints. Before forwarding to Julia, check if the requested retailer(s) data is stale. If stale AND scrapeOne is available, call scrapeOne first, then proceed with scoring. The response format does not change — callers see the same JSON, just with fresher data.

5. Keep all existing endpoints working. The freshness middleware is transparent.

6. Create scripts/portal-login.sh — a placeholder script that prints instructions for manual portal login. It should say: "To enable live portal scraping, run this script which will open a browser window. Log in to MileagePlus Shopping, complete 2FA, then close the browser. Your session cookies will be saved for the scraper to reuse. This is not yet implemented — for now, the scraper uses mock data."

Acceptance tests (run these and verify they pass):
- Initialize fresh DB: rm -f db/mileageplus.db && bash db/init.sh
- Apply migration: sqlite3 db/mileageplus.db < db/migrations/001-add-last-scraped.sql (if not auto-applied by init.sh)
- Start Julia engine and bridge
- Score BestBuy Electronics $200 — should return 900 total miles (same as v1)
- Check that last_scraped was updated for BestBuy: sqlite3 db/mileageplus.db "SELECT name, last_scraped FROM retailers WHERE name='"'"'BestBuy'"'"';"
- Score BestBuy again immediately — should NOT re-scrape (last_scraped is fresh)
- All 204 Julia tests must still pass

Do not modify any Julia engine source files (types.jl, scoring.jl, bonus.jl, database.jl, basket.jl). Only server.jl may change if the schema migration requires it. Commit as "Phase 10: Single-retailer on-demand scraper + freshness middleware" and push.'
run_phase 10 "$PHASE_10_PROMPT"
else
  echo "Phase 10 already complete, skipping."
fi

###############################################################################
# PHASE 11: /api/search endpoint with Claude API query interpretation
###############################################################################
if ! phase_done 11; then
PHASE_11_PROMPT='Read CLAUDE.md, docs/v3-spec.md, and docs/v2-spec.md before writing any code. Pay close attention to v2-spec.md sections 4 and 7.

Implement Phase 11: /api/search endpoint with Claude API query interpretation.

What to build:

1. Create bridge/search-interpreter.js that exports an async function interpretQuery(query). It calls the Claude API (model claude-sonnet-4-20250514, max_tokens 512) with a system prompt that instructs the model to return JSON only with: interpreted_category (string), estimated_price (float), likely_retailers (array of strings), query_type (one of "product", "category", "retailer"). Use ANTHROPIC_API_KEY from process.env. Include retry logic: if JSON parsing fails, retry once with a clarifying instruction. If the key is missing or both attempts fail, return a fallback: {interpreted_category: "General", estimated_price: 100.0, likely_retailers: [], query_type: "product"}.

2. Add POST /api/search endpoint to bridge/server.js per v2-spec.md section 7. It accepts {query, card_tier, exclude_retailers, price_override}. card_tier defaults to "none" if not provided.

3. The search flow: call interpretQuery to get category + price + likely retailers. If price_override is set, use that instead of estimated_price. Convert card_tier aliases (same mapping as /api/score). Forward to Julia /rank with the interpreted category, price, and card_tier. Assemble results with portal_url from the retailers table, human-readable path labels ("Shop directly" for direct, "Buy gift card first" for mpx, "Gift card + portal" for stacked), and sort by total_miles descending.

4. Fuzzy retailer matching: when the Claude API returns retailer names in likely_retailers, match them to database rows using case-insensitive comparison with spaces and punctuation stripped. "Best Buy", "BestBuy", "best buy", "BESTBUY" must all match. Implementation: normalize both strings by lowercasing and removing all non-alphanumeric characters, then compare. If no match, try SQL: SELECT * FROM retailers WHERE LOWER(REPLACE(name, " ", "")) LIKE LOWER(REPLACE(?, " ", "")).

5. Add the search_log table from v2-spec.md section 8. Create db/migrations/002-add-search-log.sql. Log every search.

6. Include stale_retailers in the response — list any retailer whose last_scraped is null or older than the freshness threshold. Set refreshing=true if any stale retailers exist. Actual progressive loading comes in Phase 13 — for now just flag them.

7. Each result must include: retailer (name), path (direct/mpx/stacked), path_label (human readable), total_miles, breakdown {portal, card, bonus, mpx}, risk_class, portal_url, data_age_hours, stale (boolean). Mark the top result with top_pick=true.

Acceptance tests:
- Start Julia engine and bridge with ANTHROPIC_API_KEY set
- POST /api/search with {"query":"AirPods"} — should return JSON with interpreted category, estimated price, results array with total_miles and portal URLs
- POST /api/search with {"query":"best buy"} (lowercase, space) — should match BestBuy in database
- POST /api/search with {"query":"Nike shoes"} — should return results including Nike with path labels
- POST /api/search without ANTHROPIC_API_KEY — should use fallback interpretation and still return results
- sqlite3 db/mileageplus.db "SELECT COUNT(*) FROM search_log;" — should show logged searches
- All 204 Julia tests must still pass

Commit as "Phase 11: Search endpoint with Claude API query interpretation" and push.'
run_phase 11 "$PHASE_11_PROMPT"
else
  echo "Phase 11 already complete, skipping."
fi

###############################################################################
# PHASE 12: Frontend redesign — search bar, result cards, portal links
###############################################################################
if ! phase_done 12; then
PHASE_12_PROMPT='Read CLAUDE.md, docs/v3-spec.md, and docs/v2-spec.md before writing any code. Pay close attention to v2-spec.md section 3.

Implement Phase 12: Frontend redesign with search-first UI.

CRITICAL: Do NOT attempt to rewrite App.jsx in a single pass. The file is over 1000 lines. Create new component files first, then update App.jsx with small targeted edits to import and use them.

What to build:

1. Create frontend/src/SearchBar.jsx — the home screen component. Just the app title "MileagePlus Deal Finder" and a centered search input with a search button. Nothing else. Clean, minimal, like a search engine landing page.

2. Create frontend/src/SearchResults.jsx — the results page. Shows:
   - Search bar at top (pre-filled with query, editable)
   - Collapsible "Filters" panel with: card tier dropdown (default "No Chase United card", stored in sessionStorage, resets on site close), exclude stores checkboxes, optional price override field
   - Result cards ranked by total miles. Each card: retailer name, path label ("Shop directly" / "Buy gift card first" / "Gift card + portal"), total miles as big number, breakdown text, risk badge (green confirmed / yellow uncertain / hide excluded), "Shop at [Retailer]" button opening portal_url in new tab, small "Log purchase" link
   - Top result gets "Top Pick" badge and larger card
   - 3-5 alternatives in smaller cards, "Show all N results" expander if more exist
   - "Refreshing N stores..." indicator if any stale retailers (non-functional in this phase, just display)

3. Create frontend/src/PurchasesPage.jsx — move the existing purchases functionality from App.jsx into its own component. Same features: history table, summary stats, mark-posted, delete, manual log form.

4. Create frontend/src/SettingsPage.jsx — settings page with: default card tier (saved to localStorage), local tax rate (saved to localStorage), freshness threshold display.

5. Update frontend/src/App.jsx — SMALL TARGETED EDITS ONLY:
   - Remove all tab logic, Score panel, Rank panel, Basket tab import, Scraper tab
   - Import SearchBar, SearchResults, PurchasesPage, SettingsPage
   - Add simple client-side routing: home (search bar), /search (results), /purchases, /settings
   - Use URL hash routing (no react-router needed): #/ = home, #/search?q=... = results, #/purchases, #/settings
   - Navigation: small icons top-right for Purchases (list icon) and Settings (gear icon), visible on all pages

6. Mobile-first CSS: single-column cards at 375px, full-width search bar, 44px minimum tap targets, filters slide down from search bar.

Acceptance tests:
- Open localhost:3000 — see ONLY a search bar centered on page, no tabs
- Type "Electronics" and search — see result cards with Top Pick badge and portal links
- Click "Shop at BestBuy" — opens portal URL in new tab
- Open Filters — card tier dropdown works, changing it re-runs search
- Navigate to Purchases via icon — purchases page loads with all v1 functionality
- Navigate to Settings via gear icon — settings page loads
- Test at 375px viewport width — everything readable and tappable
- All 204 Julia tests must still pass (no Julia changes in this phase)

Keep BasketTab.jsx and SweepPanel.jsx files in the repo but do not import or render them.

Commit as "Phase 12: Search-first frontend redesign" and push.'
run_phase 12 "$PHASE_12_PROMPT"
else
  echo "Phase 12 already complete, skipping."
fi

###############################################################################
# PHASE 13: Progressive loading for stale retailers
###############################################################################
if ! phase_done 13; then
PHASE_13_PROMPT='Read CLAUDE.md, docs/v3-spec.md, and docs/v2-spec.md before writing any code. Pay close attention to v2-spec.md sections 4.5 and 7.

Implement Phase 13: Progressive loading for stale retailers.

What to build:

1. Add GET /api/search/status/:search_id endpoint to bridge/server.js. It returns the current state of a search including any newly scraped retailer results added since the initial response.

2. Modify POST /api/search: when stale retailers are identified, return immediate results for fresh retailers with refreshing=true and a search_id. In a background process (use setImmediate or setTimeout(fn, 0) — NOT a separate thread), iterate through stale retailers one at a time: call scrapeOne() for each (with randomized 2-10s delay between retailers per v3-spec section 2.4), score the retailer via Julia /rank, and add the result to an in-memory Map keyed by search_id. Update the stale count after each retailer completes.

3. Update frontend/src/SearchResults.jsx: when the search response has refreshing=true, start polling GET /api/search/status/:search_id every 3 seconds. On each poll, re-render the results list with any new retailers inserted in the correct sort position. Show "Refreshing N stores..." indicator that counts down. When refreshing becomes false, stop polling and remove the indicator.

4. Search state cleanup: store search state in a Map with a 5-minute TTL. Use setInterval to clean up expired entries every minute. No database persistence needed for search state.

5. Handle edge cases: if the user starts a new search while a previous one is still refreshing, the old search state is abandoned (it stays in the map until TTL cleanup but the frontend stops polling it). If scrapeOne fails for a retailer, skip it and continue with the next one — do not fail the entire search.

Acceptance tests:
- Manually mark a retailer as stale: sqlite3 db/mileageplus.db "UPDATE retailers SET last_scraped='"'"'2026-03-20T00:00:00'"'"' WHERE name='"'"'Nike'"'"';"
- POST /api/search with {"query":"shoes"} — initial response should have refreshing=true and Nike in stale_retailers
- Poll GET /api/search/status/:search_id — within 15 seconds, Nike should appear in results with fresh data
- refreshing should become false after all stale retailers are processed
- A second search for the same thing should return all results immediately (no stale retailers, Nike was just refreshed)
- All 204 Julia tests must still pass

Commit as "Phase 13: Progressive loading for stale retailers" and push.'
run_phase 13 "$PHASE_13_PROMPT"
else
  echo "Phase 13 already complete, skipping."
fi

###############################################################################
# PHASE 14: Purchases page + settings page + mobile polish
###############################################################################
if ! phase_done 14; then
PHASE_14_PROMPT='Read CLAUDE.md, docs/v3-spec.md, and docs/v2-spec.md before writing any code.

Implement Phase 14: Purchases page, settings page, and mobile polish.

What to build:

1. Review frontend/src/PurchasesPage.jsx — if it was created in Phase 12, verify it has all v1 purchase log features: history table with status badges (posted=green, pending=yellow, overdue=red), summary stats bar (total purchases, expected vs posted miles, posting rate percentage), mark-posted button, delete button, manual log form with retailer/path/price/miles fields. Fix any missing features. The component uses /api/purchases endpoints which are unchanged from v1.

2. Review frontend/src/SettingsPage.jsx — if created in Phase 12, verify it has: default card tier dropdown (saved to localStorage, read as fallback when sessionStorage has no override), local tax rate input (saved to localStorage), freshness threshold display. Add any missing features.

3. Card tier session logic: when the user opens the site, check sessionStorage for card_tier. If not found, check localStorage for a saved default. If neither exists, use "none". When the user changes card tier in the Filters panel, save to sessionStorage (persists for the browser session, resets on close). When the user changes default card tier in Settings, save to localStorage (persists across sessions). The search endpoint always receives the current effective card tier.

4. Mobile polish — review ALL components at 375px viewport width and fix:
   - Search bar: full width with comfortable padding
   - Result cards: single column, no horizontal overflow
   - Filters panel: slides down smoothly, controls stack vertically
   - Portal link buttons: at least 44px height, full width on mobile
   - Purchases table: horizontally scrollable if too wide, or card layout on mobile
   - Settings form: full width inputs, clear labels
   - Navigation icons: at least 44px tap targets, visible on all pages

5. Navigation refinement: Purchases icon and Settings icon in top-right on ALL pages. Active page visually indicated (highlighted icon or underline). Tapping the app title from any page returns to the search home screen.

Acceptance tests:
- Open at 375px width (use browser dev tools device toolbar)
- Search works, results are readable cards, no horizontal scroll
- Filters expand cleanly, card tier dropdown is tappable
- "Shop at [Retailer]" buttons are large and tappable
- Navigate to Purchases — all features work (log, mark posted, delete)
- Navigate to Settings — save card tier default, close tab, reopen — default is remembered
- Change card tier in Filters during a session — it persists across searches but resets when you close the tab and reopen
- All 204 Julia tests must still pass

Commit as "Phase 14: Purchases + settings + mobile polish" and push.'
run_phase 14 "$PHASE_14_PROMPT"
else
  echo "Phase 14 already complete, skipping."
fi

###############################################################################
# PHASE 15: Production build + startup scripts + Cloudflare Tunnel prep
###############################################################################
if ! phase_done 15; then
PHASE_15_PROMPT='Read CLAUDE.md, docs/v3-spec.md, and docs/v2-spec.md before writing any code. Pay close attention to v2-spec.md section 9.

Implement Phase 15: Production build, startup scripts, and Cloudflare Tunnel preparation.

What to build:

1. Add a production build step to the frontend. Update frontend/vite.config.js to build to frontend/dist/. Add "build": "vite build" to frontend/package.json scripts. Test with: cd frontend && npm run build — should produce frontend/dist/index.html and assets.

2. Update bridge/server.js to serve frontend/dist/ as static files when NODE_ENV=production. Add: if NODE_ENV is "production", serve express.static(path.join(__dirname, "..", "frontend", "dist")) at the root route, with a catch-all that serves index.html for client-side routing. In development mode, the Vite dev server handles the frontend as before.

3. Create scripts/start-prod.sh:
   - Source .env from repo root
   - Build frontend: cd frontend && npm run build
   - Start Julia engine on port from JULIA_ENGINE_PORT (default 5001)
   - Start bridge with NODE_ENV=production on port 4000 (serves frontend + API)
   - Optionally start cloudflared if installed and config exists
   - Write PIDs to logs/pids-prod.txt
   - Print: "Production server running at http://localhost:4000"

4. Create scripts/stop-prod.sh:
   - Read PIDs from logs/pids-prod.txt and kill them
   - Fallback: kill by port if PID file missing

5. Create scripts/install.sh:
   - Install npm deps for bridge, frontend, scraper
   - Instantiate Julia packages
   - Initialize database (bash db/init.sh)
   - Build frontend (cd frontend && npm run build)
   - Print setup instructions: create .env file, set up Cloudflare Tunnel (reference README)

6. Create .env.example in repo root:
   ANTHROPIC_API_KEY=sk-ant-your-key-here
   MILEAGEPLUS_USERNAME=your-mileageplus-username
   MILEAGEPLUS_PASSWORD=your-mileageplus-password
   JULIA_ENGINE_PORT=5001
   NODE_ENV=production
   FRESHNESS_HOURS=24

7. Update README.md with:
   - What the app does (one paragraph)
   - Quick start: clone, bash scripts/install.sh, create .env, bash scripts/start-prod.sh
   - Cloudflare Tunnel setup: step-by-step from v2-spec.md section 9
   - Optional: Cloudflare Access for email-based family auth
   - Troubleshooting: common issues (port conflict, Julia not found, API key missing)

8. Add frontend/dist/ to .gitignore (built artifact, not committed).

Do NOT actually set up Cloudflare Tunnel — that requires interactive browser authentication. Just prepare the scripts and documentation.

Acceptance tests:
- Run scripts/install.sh from repo root — all deps install, DB initializes, frontend builds
- Run scripts/start-prod.sh — Julia + bridge start, no Vite needed
- Open http://localhost:4000 — search UI loads from static files
- Search works through localhost:4000 (bridge serves both frontend and API)
- scripts/stop-prod.sh cleanly kills all processes
- .env.example exists with all required variables
- README has clear setup and tunnel instructions
- All 204 Julia tests must still pass

Commit as "Phase 15: Production build + startup scripts + tunnel prep" and push.'
run_phase 15 "$PHASE_15_PROMPT"
else
  echo "Phase 15 already complete, skipping."
fi

###############################################################################
# FINAL: Push everything and report
###############################################################################
echo ""
echo "=== Final push ==="
cd "$ROOT"
git push origin HEAD 2>/dev/null || echo "Push may require manual merge — check GitHub."

echo ""
echo "=============================================="
echo "  V2 BUILD COMPLETE"
echo "=============================================="
echo ""
echo "  Phases completed: 10-15"
echo "  Logs: $LOG_DIR/"
echo ""
echo "  Next steps:"
echo "  1. Review the code: git log --oneline | head -20"
echo "  2. Create .env from .env.example with real credentials"
echo "  3. Run: bash scripts/install.sh"
echo "  4. Run: bash scripts/start-prod.sh"
echo "  5. Open http://localhost:4000 and test"
echo "  6. Set up Cloudflare Tunnel per README.md"
echo "  7. Share the URL with family"
echo ""
echo "  For live portal scraping (after 2FA manual login):"
echo "  8. Run: bash scripts/portal-login.sh"
echo "  9. Test a search — stale retailers should auto-refresh"
echo "=============================================="
