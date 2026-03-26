# CLAUDE.md — MileagePlus Deal Finder

> **Read `/docs/v3-spec.md` (v1 math/engine) and `/docs/v2-spec.md` (v2 product/UI) before starting any phase.** v3-spec.md is the source of truth for the mathematical formulation, type hierarchy, database schema, and scoring engine. v2-spec.md is the source of truth for the search-first UI, on-demand scraping, and Phases 10–15. This file contains standing instructions and architectural constraints that apply across all phases.

## Project Overview

This is a personal tool that finds the best miles-per-dollar value when purchasing through the United MileagePlus Shopping portal. It treats retailer selection as a formal mathematical optimization problem.

The user has one MileagePlus account, uses United Chase credit cards, and accesses the tool from both desktop and phone. This started as a single-user local-network developer tool (v1, Phases 0–9). It is being transformed into a search engine accessible by family via Cloudflare Tunnel (v2, Phases 10–15).

## Architecture

### v1 Architecture (Phases 0–9, COMPLETE)

Four layers: **Capture → Store → Compute → Display**

| Layer   | Tech                              | Location              |
|---------|-----------------------------------|-----------------------|
| Capture | Playwright via Cowork             | `/scraper`            |
| Store   | SQLite                            | `/db`                 |
| Compute | Julia (HTTP.jl, JuMP, HiGHS)     | `/engine`             |
| Display | Node.js/Express + React           | `/bridge` and `/frontend` |

```
Browser → React (:3000) → Express (:4000) → Julia HTTP.jl (:5001) → SQLite
                                                                        ↑
                                                    Playwright scraper ─┘
```

### v2 Architecture (Phases 10–15, IN PROGRESS)

The Julia engine, SQLite schema, and Node bridge are unchanged. The frontend is replaced with a search-first UI. Scraping becomes on-demand (triggered by search, not manual). Claude API interprets search queries. Cloudflare Tunnel provides remote HTTPS access.

```
Phone/Browser (miles.yourdomain.com)
        |
  Cloudflare Tunnel (free)
        |
  Express Bridge (:4000) — serves React static build + API
        |--- POST /api/search → Claude API (query interpretation) → Julia /rank → results
        |--- GET /api/search/status/:id → progressive loading poll
        |--- Playwright scrapeOne() → on-demand per-retailer refresh
        |--- /api/purchases (unchanged from v1)
        |--- Julia Engine (:5001) — scoring, ranking (unchanged from v1)
                 |--- SQLite — all persistent data
```

In production mode, the Express bridge serves the React build (`frontend/dist/`) as static files and handles API routes — no separate Vite dev server needed.

## Critical Design Decisions — Do Not Deviate

### 1. Card miles are independent of portal eligibility
Card miles (`p_card × c_r(k)`) are ALWAYS earned on the posted transaction amount. They are NEVER multiplied by the portal eligibility score δ. Portal tracking failures do not affect Chase credit card mile earning. This was the most important correction from v2 spec to v3 spec.

```
# WRONG — v2 spec bug
M = δ × p × (b_r + c_r)

# CORRECT — v3 spec
portal_miles = δ × p_portal × b_r
card_miles   = p_card × c_r(k)        # no δ
M = portal_miles + card_miles + bonus_miles
```

### 2. Spend basis is a vector, not a scalar
Never use a single `p` for price. Always use the SpendVector:
- `p_list` — pre-tax item price (user input)
- `p_portal` — portal-eligible spend (net of tax/shipping)
- `p_card` — charged amount (includes tax)
- `p_cash` — out-of-pocket cash outflow
- `v_residual` — leftover gift card balance

Different miles calculations use different spend bases. Portal miles use `p_portal`. Card miles use `p_card`. Budget constraints use `p_cash`.

### 3. Three earning paths, not two
- **Direct:** Click through portal, buy with Chase card
- **MPX:** Buy eGift card via MileagePlus X app (25% Chase bonus)
- **Stacked:** Buy eGift card via MPX (Leg 1), then shop through portal paying with gift card (Leg 2)

The stacked path has a gate: `γ_r ∈ {0, 1}` — whether the retailer allows portal miles when paying with a gift card. Default to `γ_r = 0` (conservative). The stacked path with `γ_r = 1` is the maximum-miles strategy.

### 4. Gift cards are NOT earned through the portal
The MileagePlus Shopping FAQ explicitly excludes gift card purchases. Never recommend buying gift cards through the portal. MPX is the dedicated gift card earning channel.

### 5. δ is a risk class, not a multiplier
`δ ∈ {confirmed, uncertain, excluded}` is displayed as a separate column in rankings, not multiplied into the mile count. For MILP, the user selects a risk tolerance and items below threshold get portal miles zeroed.

### 6. All scraped data uses snapshot IDs
Every rate, bonus, and T&C row has a `snapshot_id` foreign key tying it to a scrape run. The scoring engine only uses data from the most recent complete snapshot. The UI shows "rates as of [timestamp]". Never mix data from different snapshots in a single scoring pass.

### 7. Order-level MILP, not item-level
The basket optimizer uses order-level decision variables. Items are assigned to orders. Per-order bonuses attach to orders. This prevents double-counting flat bonuses when multiple items go to the same retailer.

### 8. Bonus semantics must be classified
Rate multiplier bonuses have a `semantics` field: `:total`, `:incremental`, `:up_to`, or `:flat_bonus`. "Earn 5x" (total) is different from "Earn +2x bonus" (incremental). The Claude API parser must output this classification. The scoring function dispatches on it.

### 9. v2: Search replaces tabs
The entire v1 tab interface (Score, Rank, Basket, Scraper) is replaced by a single search bar. Users type what they want to buy, the app returns ranked results with portal links. All v1 engine code remains — the search endpoint calls `rank_all` internally.

### 10. v2: On-demand scraping, not manual
Scraping happens automatically when a user searches and retailer data is stale (older than FRESHNESS_HOURS, default 24). The `scrapeOne()` function refreshes one retailer at a time. The MileagePlus portal requires 2FA, so automated builds use MOCK DATA. Live scraping requires a manual one-time browser login to save session cookies.

### 11. v2: Fuzzy retailer matching
When the Claude API returns retailer names from query interpretation, match to database rows by normalizing: lowercase + strip all non-alphanumeric characters. "Best Buy", "BestBuy", "best buy" must all match.

## Technology Constraints

### Julia
- Julia 1.10+ required (local Mac: 1.12.5 via Juliaup at `~/.juliaup/bin/julia`)
- Packages: HTTP.jl, JSON3.jl, SQLite.jl, JuMP.jl, HiGHS.jl
- Use concrete types everywhere — avoid `Vector{BonusOffer}` with heterogeneous elements in hot loops. Use the abstract type for dispatch, concrete types for storage.
- `Union{T, Nothing}` is fine for optional fields (Julia optimizes small unions), but prefer explicit sentinel values where they make the code clearer.
- HiGHS cannot compute duals for MIPs. `dual_status(model)` returns `NO_SOLUTION`. Do not claim duals are available. If implementing duals later, use fix-and-relax and label as "LP relaxation estimate."
- At ~400 retailers, prefer simple loops over matrix broadcasting. Profile before optimizing.
- In cloud sessions: Julia may be at `/usr/local/bin/julia` or installed via conda. Always use `JULIA_PKG_SERVER=""`.

### Node.js / Express
- Express bridge to Julia engine over localhost
- Tiered timeouts: `/health` 1s, `/score` 2s, `/rank` 5s, `/basket` 30s (async), `/search` 10s (includes Claude API call)
- The `/basket` endpoint returns a greedy solution in <200ms, then continues MILP solving. Poll `/basket/status/{job_id}` for the exact solution.
- Sequential request queuing to Julia (one request at a time)
- On Julia health check failure: log, attempt restart, serve cached results or error

### React
- Accessible from phone and desktop
- v2: Search bar home screen, result cards with portal links, hash-based routing
- Show risk class as a visible badge on all recommendations
- Show "as of [date]" timestamps from snapshot IDs
- Mobile-first: single-column cards at 375px, 44px minimum tap targets
- Card tier stored in sessionStorage (resets on site close), default in localStorage

### SQLite
- Schema is defined in `/db/schema.sql`
- v2 additions: `search_log` table, `last_scraped` column on `retailers`
- All scraped data rows carry `snapshot_id` foreign key
- Append-only archive for raw T&C text (never delete/overwrite)
- Purchase log stores full SpendVector and `snapshot_id` used at decision time

### Playwright Scraper
- v1: batch scrape via Cowork (desktop only)
- v2: on-demand `scrapeOne(retailerName)` called from the bridge during search
- Randomized delays between requests (2–10 seconds)
- Maximum one scrape per retailer per 24 hours
- Fail closed: CAPTCHA, 429, or access-denied → abort and mark snapshot failed
- Never scrape in parallel
- Log all requests for audit
- **2FA: automated builds use MOCK DATA. Live portal requires manual login to save browser cookies.**

## File Structure

```
/engine/
  src/
    MileagePlusDealFinder.jl — module definition and exports
    types.jl          — SpendVector, Retailer, CardTier, BonusOffer hierarchy, ScoreResult
    scoring.jl        — score_direct, score_mpx, score_stacked, classify_category_from_tc
    ranking.jl        — rank_all
    bonus.jl          — compute_bonus dispatch for all bonus types
    sensitivity.jl    — breakpoint sweep
    basket.jl         — JuMP MILP, greedy_basket, milp_basket, breakpoint_sweep, SweepSegment
    server.jl         — HTTP.jl endpoints: /health, /score, /rank, /sweep, /basket, /basket/status
    database.jl       — SQLite read functions, RetailerData, SnapshotInfo, ProcessConstraint
    db.jl             — (legacy, may be superseded by database.jl)
  test/
    runtests.jl
    test_bonus.jl, test_scoring.jl, test_ranking.jl — Phases 1-3
    test_phase4.jl    — MPX, Stacked, rank_all
    test_phase8.jl    — MILP basket
    test_phase9.jl    — breakpoint sweep
    test_basket.jl
  Project.toml

/bridge/
  server.js           — Express proxy: /api/score, /api/rank, /api/sweep, /api/basket, /api/purchases, /api/search (v2)
  tc-parser.js        — Claude API T&C and bonus parser
  purchase-log.js     — Purchase log database operations
  search-interpreter.js — (v2 Phase 11) Claude API query interpretation
  package.json

/frontend/
  src/
    App.jsx           — v1: tabs; v2: hash router with SearchBar/SearchResults/Purchases/Settings
    SearchBar.jsx     — (v2 Phase 12) search home screen
    SearchResults.jsx — (v2 Phase 12) result cards with portal links
    PurchasesPage.jsx — (v2 Phase 12) purchase history (moved from App.jsx)
    SettingsPage.jsx  — (v2 Phase 12) settings page
    BasketTab.jsx     — (v1, kept but not rendered in v2)
    SweepPanel.jsx    — (v1, kept but not rendered in v2)
    main.jsx
  index.html
  vite.config.js
  package.json

/scraper/
  src/
    scraper.js        — Playwright scraper (batch + scrapeOne for v2)
    snapshot.js        — Snapshot lifecycle management
    portal-mock.js    — Mock portal data for testing
    request-log.js    — Audit log writer
  package.json

/db/
  schema.sql          — Full DDL (includes v2 additions after Phase 10)
  seed.sql            — Seed data (3 retailers, bonuses, T&C rules)
  seeds/              — Alternate seed files
  init.sh             — Database initialization script
  migrations/         — (v2) incremental schema changes

/docs/
  v3-spec.md          — Source of truth: math, engine, scoring
  v2-spec.md          — Source of truth: search UI, on-demand scraping, Phases 10-15
  phase1-session-summary.txt through phase9-session-summary.txt
  CHANGELOG.md

/scripts/
  start-dev.sh        — Start Julia + Bridge + Vite dev server
  stop-dev.sh         — Kill dev processes
  start-prod.sh       — (v2 Phase 15) production mode startup
  stop-prod.sh        — (v2 Phase 15) production shutdown
  install.sh          — (v2 Phase 15) full installation script
  run-scraper.sh      — Manual batch scraper trigger
  portal-login.sh     — (v2 Phase 10) placeholder for manual 2FA login

/test/
  integration/        — End-to-end tests (Node → Julia → SQLite)
```

## Build Phases

### v1 Phases (ALL COMPLETE)

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Repo scaffolding | ✅ COMPLETE |
| 1 | Julia engine skeleton + SpendVector + score_direct + HTTP server | ✅ COMPLETE |
| 2 | Node bridge + React UI for single-item scoring | ✅ COMPLETE |
| 3 | SQLite schema + snapshot model + seed data + Julia reads from DB | ✅ COMPLETE |
| 4 | MPX + Stacked paths + rank_all + multi-path UI | ✅ COMPLETE |
| 5 | Claude API T&C parser + risk class + bonus classification | ✅ COMPLETE |
| 6 | Playwright scraper with snapshot grouping | ✅ COMPLETE |
| 7 | Purchase log with spend vector + posting tracker | ✅ COMPLETE |
| 8 | Order-level MILP with two-phase response | ✅ COMPLETE |
| 9 | Breakpoint sweep sensitivity + polish | ✅ COMPLETE |

### v2 Phases (IN PROGRESS)

| Phase | Scope | Acceptance Test |
|-------|-------|-----------------|
| 10 | Single-retailer on-demand scraper + freshness middleware | Search for stale retailer auto-refreshes before scoring |
| 11 | /api/search with Claude API query interpretation | POST /api/search with "AirPods" returns ranked results with category and price |
| 12 | Frontend redesign: search bar home, result cards, filters, portal links | User can search, see results, tap to open portal page |
| 13 | Progressive loading: instant fresh results + live updates for stale retailers | Stale retailers show spinner, results update as scrapes complete |
| 14 | Purchases page + settings page + mobile polish | Purchases history works, card tier persists in session, mobile layout clean |
| 15 | Cloudflare Tunnel + production build + startup scripts | App accessible at miles.yourdomain.com |

Phase dependencies: 10 → 11 → 12 → 13 (critical path). 14 can run after 12. 15 runs after 12.

**At the start of each phase:**
1. Read this file, `/docs/v3-spec.md`, and `/docs/v2-spec.md`
2. Review existing code from prior phases
3. Confirm you understand the acceptance test before writing code
4. Run existing tests to make sure nothing is broken

**At the end of each phase:**
1. All prior tests still pass (204 Julia tests minimum)
2. New tests cover the phase deliverable
3. Commit with message: `Phase N: [description]`
4. Push to main

## Testing Expectations

- **Julia:** Use `Test` stdlib. Every scoring function has unit tests with known inputs and expected outputs. **204 tests as of v1 completion.** All must pass at the start and end of every v2 phase.
- **Node:** Use Jest or Vitest. Test bridge timeout behavior, error handling, and route responses.
- **Integration:** Test the full path from HTTP request to Julia to SQLite and back.
- **Key test cases to always include:**
  - Card miles are independent of δ (score with δ=0 still returns card miles)
  - SpendVector correctly separates `p_portal` from `p_card`
  - Stacked path with `γ_r=0` equals MPX path (Leg 2 contributes nothing)
  - Stacked path with `γ_r=1` > both Direct and MPX individually
  - Bonus type B with `semantics=:total` vs `:incremental` produces different results
  - Snapshot isolation: scoring uses only data from one snapshot

## Common Pitfalls — Avoid These

1. **Do not multiply card miles by δ.** This is the #1 most important invariant in the codebase.
2. **Do not use a single `p` variable anywhere.** Always use the SpendVector fields. If you find yourself writing `p * something`, stop and ask which spend basis applies.
3. **Do not model gift card purchases through the portal.** The FAQ explicitly excludes them. Use MPX path instead.
4. **Do not claim MILP duals are available from HiGHS.** They aren't for MIPs.
5. **Do not assume bonuses are additive across items.** Per-order bonuses require order-level modeling.
6. **Do not mix snapshot data.** If a `base_rate` has `snapshot_id` A, the bonus used in the same score must also have `snapshot_id` A.
7. **Do not hardcode tax rates.** Make them configurable. Default to 0.08 (approximate Georgia rate) but allow override.
8. **Do not scrape aggressively.** The portal terms forbid automation. Randomize delays, limit frequency, fail closed on any resistance.
9. **Do not attempt live portal login in automated builds.** 2FA requires manual browser login. Use mock data.
10. **Do not modify Julia engine source files in v2 phases** unless a bug is discovered that blocks a v2 acceptance test. The engine is frozen at v1. Document any exceptions in the session summary.

## Git Conventions

- Branch per phase: `phase-N-description`
- PR into main when acceptance test passes
- Commit messages: `Phase N: brief description`
- Keep commits atomic — one logical change per commit
- Tag releases: `v0.N.0` for v1 phases, `v2.0.0` after Phase 15

## Environment Setup

### Local Mac (primary development environment)

```bash
# Julia
~/.juliaup/bin/julia --version  # Julia 1.12.5

# Clone and install
gh repo clone MichaelCBrister/mileageplus-deal-finder
cd mileageplus-deal-finder

# Julia packages
cd engine && ~/.juliaup/bin/julia --project=. -e 'using Pkg; Pkg.instantiate()' && cd ..

# Node packages
cd bridge && npm install && cd ..
cd frontend && npm install && cd ..
cd scraper && npm install && cd ..

# Database
rm -f db/mileageplus.db && bash db/init.sh

# Environment
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY

# Start dev stack
bash scripts/start-dev.sh
```

**Mac-specific notes:**
- Julia engine runs on port **5001** (macOS AirPlay uses 5000)
- Julia binary at `~/.juliaup/bin/julia` (via Juliaup, not system path)
- Node 24, SQLite 3.51

### Cloud Claude Code sessions

```bash
# Julia may need installation — let Claude Code handle it via conda
# Always use JULIA_PKG_SERVER=""
cd engine && JULIA_PKG_SERVER="" julia --project=. -e 'using Pkg; Pkg.instantiate()' && cd ..

# If HTTP.jl fails with mbedtls error:
conda install -c conda-forge "mbedtls=2.*"
```

## v1 Completion Summary

### Test Count
204 total tests across all phases:
- Phase 1-3 (test_bonus.jl, test_scoring.jl): 76
- Phase 4 (test_phase4.jl): 64
- Phase 8 (test_phase8.jl): 26
- Phase 9 (test_phase9.jl): 38

### Known Gaps (v1, carried forward)
1. **Live portal scraper untested** — DOM selectors are best-effort. Requires manual login with real portal credentials. Mock mode works for pipeline testing.
2. **ANTHROPIC_API_KEY not tested in cloud** — Parse endpoints return 400 api_key_missing without it. Functional and ready for use with key.
3. **Dual variables deferred** — HiGHS cannot compute duals for MIPs. Fix-and-relax LP duals are post-v1.
4. **Three-axis Pareto frontier deferred** — v3-spec section 10.
5. **Calibrated probabilistic delta deferred** — Three-level risk class sufficient.
6. **Embedding layer for T&C deferred** — Claude API parser handles hard cases.

### v2 Additions to Track
- `search_log` table (Phase 11)
- `retailers.last_scraped` column (Phase 10)
- `scrapeOne()` function (Phase 10)
- `search-interpreter.js` (Phase 11)
- Search-first frontend components (Phase 12)
- Progressive loading (Phase 13)
- Production build + Cloudflare Tunnel prep (Phase 15)

## Questions or Ambiguity

If the spec is ambiguous on a point, **choose the conservative option** and document the decision in a code comment with `# DECISION: [rationale]`. Prefer correctness over performance. Prefer explicit over clever. Ask the user if genuinely uncertain rather than guessing.
