# CLAUDE.md — MileagePlus Deal Finder

Read `/docs/v3-spec.md` before starting any phase. That document is the source of truth for the mathematical formulation, type hierarchy, database schema, and build sequence. This file contains standing instructions and architectural constraints that apply across all phases.

## Project Overview

This is a personal tool that finds the best miles-per-dollar value when purchasing through the United MileagePlus Shopping portal. It treats retailer selection as a formal mathematical optimization problem.

The user has one MileagePlus account, uses United Chase credit cards, and accesses the tool from both desktop and phone over local WiFi. This is a single-user, local-network application — no auth, no multi-tenancy.

## Architecture

Four layers: **Capture → Store → Compute → Display**

| Layer   | Tech                              | Location              |
|---------|-----------------------------------|-----------------------|
| Capture | Playwright via Cowork             | `/scraper`            |
| Store   | SQLite                            | `/db`                 |
| Compute | Julia (HTTP.jl, JuMP, HiGHS)     | `/engine`             |
| Display | Node.js/Express + React           | `/bridge` and `/frontend` |

The Julia engine runs as a persistent HTTP server. The Node bridge talks to it over localhost. The React frontend talks to the Node bridge. The Playwright scraper runs separately via Cowork on the desktop and writes to SQLite.

```
Browser → React (localhost:3000) → Express (localhost:4000) → Julia HTTP.jl (localhost:5000) → SQLite
                                                                                                  ↑
                                                                          Playwright scraper (Cowork) ─┘
```

## Critical Design Decisions — Do Not Deviate

### 1. Card miles are independent of portal eligibility
Card miles (`p_card × c_r(k)`) are ALWAYS earned on the posted transaction amount. They are NEVER multiplied by the portal eligibility score δ. Portal tracking failures do not affect Chase credit card mile earning. This was the most important correction from v2 to v3.

```
# WRONG — v2 bug
M = δ × p × (b_r + c_r)

# CORRECT — v3
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

## Technology Constraints

### Julia
- Julia 1.10+ required
- Packages: HTTP.jl, JSON3.jl, SQLite.jl, JuMP.jl, HiGHS.jl
- Use concrete types everywhere — avoid `Vector{BonusOffer}` with heterogeneous elements in hot loops. Use the abstract type for dispatch, concrete types for storage.
- `Union{T, Nothing}` is fine for optional fields (Julia optimizes small unions), but prefer explicit sentinel values where they make the code clearer.
- HiGHS cannot compute duals for MIPs. `dual_status(model)` returns `NO_SOLUTION`. Do not claim duals are available. If implementing duals later, use fix-and-relax and label as "LP relaxation estimate."
- At ~400 retailers, prefer simple loops over matrix broadcasting. Profile before optimizing.

### Node.js / Express
- Express bridge to Julia engine over localhost
- Tiered timeouts: `/health` 1s, `/score` 2s, `/rank` 5s, `/basket` 30s (async)
- The `/basket` endpoint returns a greedy solution in <200ms, then continues MILP solving. Poll `/basket/status/{job_id}` for the exact solution.
- Sequential request queuing to Julia (one request at a time)
- On Julia health check failure: log, attempt restart, serve cached results or error

### React
- Accessible from phone and desktop over local WiFi
- Show risk class as a visible column on all recommendations
- Show "as of [date]" timestamps from snapshot IDs
- Show process constraint warnings per retailer
- For MILP: show greedy solution immediately, upgrade to exact when ready

### SQLite
- Schema is defined in `/db/schema.sql`
- All scraped data rows carry `snapshot_id` foreign key
- Append-only archive for raw T&C text (never delete/overwrite)
- Purchase log stores full SpendVector and `snapshot_id` used at decision time

### Playwright Scraper
- Runs via Cowork (desktop only), not from the web server
- Randomized delays between requests (2–10 seconds)
- Maximum one full scrape per day
- Fail closed: CAPTCHA, 429, or access-denied → abort and mark snapshot failed
- Never scrape in parallel
- Log all requests for audit

## File Structure

```
/engine/
  src/
    types.jl          — SpendVector, Retailer, CardTier, BonusOffer hierarchy
    scoring.jl        — score_direct, score_mpx, score_stacked
    ranking.jl        — rank_all
    bonus.jl          — compute_bonus dispatch for all types
    sensitivity.jl    — breakpoint sweep
    basket.jl         — JuMP MILP (Phase 8)
    server.jl         — HTTP.jl endpoints
    db.jl             — SQLite read functions
  test/
    test_scoring.jl
    test_ranking.jl
    test_bonus.jl
    test_basket.jl
  Project.toml
  Manifest.toml

/bridge/
  src/
    index.js          — Express server
    julia-bridge.js   — HTTP client to Julia with timeouts/retry
    routes/
      score.js
      rank.js
      basket.js
  package.json

/frontend/
  src/
    App.jsx
    components/
    hooks/
  package.json

/scraper/
  src/
    scrape.js         — Playwright scraper entry point
    parsers/          — Per-retailer or per-section parsers
    snapshot.js       — Snapshot management
  package.json

/db/
  schema.sql
  seeds/
    fixture_retailers.sql
    fixture_rates.sql

/docs/
  v3-spec.md          — Source of truth specification
  CHANGELOG.md

/test/
  integration/        — End-to-end tests (Node → Julia → SQLite)
```

## Build Phases

Work proceeds in numbered phases. Each phase has a clear deliverable and acceptance test. Do not skip phases or combine them unless explicitly told to.

| Phase | Scope | Acceptance Test |
|-------|-------|-----------------|
| 1 | Julia engine skeleton + SpendVector + score_direct + HTTP server | `curl /score` returns correct miles for fixture retailer |
| 2 | Node bridge + React UI for single-item scoring | Browser shows miles breakdown for typed query |
| 3 | SQLite schema + snapshot model + seed data + Julia reads from DB | `/score` matches seed data; "as of" timestamp visible |
| 4 | MPX + Stacked paths + rank_all + multi-path UI | Ranking shows 3 paths; stacked > direct when γ_r = 1 |
| 5 | Claude API T&C parser + risk class + bonus classification | Parse 5 real T&C texts; verify against manual review |
| 6 | Playwright scraper with snapshot grouping | Full scrape → complete snapshot; spot-check rates |
| 7 | Purchase log with spend vector + posting tracker | Log purchase; verify pending status; manually mark posted |
| 8 | Order-level MILP with two-phase response | 5-item basket: greedy in <200ms; MILP improves on it |
| 9 | Breakpoint sweep sensitivity + polish | Spend slider shows piecewise-optimal retailer switches |

At the start of each phase:
1. Read this file and `/docs/v3-spec.md`
2. Review existing code from prior phases
3. Confirm you understand the acceptance test before writing code
4. Run existing tests to make sure nothing is broken

At the end of each phase:
1. All prior tests still pass
2. New tests cover the phase deliverable
3. Commit with message: `Phase N: [description]`
4. Push to main

## Testing Expectations

- **Julia:** Use `Test` stdlib. Every scoring function has unit tests with known inputs and expected outputs.
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

## Git Conventions

- Branch per phase: `phase-N-description`
- PR into main when acceptance test passes
- Commit messages: `Phase N: brief description`
- Keep commits atomic — one logical change per commit
- Tag releases: `v0.N.0` corresponding to phase completion

## Environment Setup

First-time setup for a new Claude Code session:

```bash
# Clone repo
gh repo clone [username]/mileageplus-deal-finder
cd mileageplus-deal-finder

# Julia
cd engine
julia --project=. -e 'using Pkg; Pkg.instantiate()'
cd ..

# Node
cd bridge && npm install && cd ..
cd frontend && npm install && cd ..

# Database
sqlite3 db/mileageplus.db < db/schema.sql
# If seed data exists:
sqlite3 db/mileageplus.db < db/seeds/fixture_retailers.sql
sqlite3 db/mileageplus.db < db/seeds/fixture_rates.sql
```

## Questions or Ambiguity

If the spec is ambiguous on a point, choose the conservative option and document the decision in a code comment with `# DECISION: [rationale]`. Prefer correctness over performance. Prefer explicit over clever. Ask the user if genuinely uncertain rather than guessing.
