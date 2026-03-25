# MileagePlus Deal Finder — v3 Specification

> Source of truth for mathematical formulation, type hierarchy, database schema, and build sequence.

## 1. Problem Statement

Given a set of retailers on the United MileagePlus Shopping portal, each with time-varying earn rates, promotional bonuses, and terms & conditions, determine the purchasing strategy that maximizes miles earned per dollar spent for a single MileagePlus member.

The user holds United Chase credit cards and can earn miles through three distinct paths. The tool scrapes current rates, scores each retailer across all paths, ranks them, and (for multi-item baskets) solves an order-level MILP to allocate items optimally.

## 2. Mathematical Formulation

### 2.1 Spend Vector

Every purchase is described by a **SpendVector**, not a single scalar price:

| Field        | Symbol       | Definition                                      |
|--------------|--------------|--------------------------------------------------|
| List price   | `p_list`     | Pre-tax item price (user input)                  |
| Portal spend | `p_portal`   | Portal-eligible spend = `p_list` (net of tax/shipping) |
| Card spend   | `p_card`     | Charged amount = `p_list × (1 + τ)` where τ is tax rate |
| Cash outflow | `p_cash`     | Out-of-pocket cash                               |
| Residual     | `v_residual` | Leftover gift card balance (stacked path)        |

**Invariant:** Different mile calculations use different spend bases. Never use a single `p`.

Default tax rate: `τ = 0.08` (configurable).

### 2.2 Earning Paths

#### Path 1: Direct

Click through portal, buy with Chase card.

```
portal_miles = δ × p_portal × b_r
card_miles   = p_card × c_r(k)
M_direct     = portal_miles + card_miles + bonus_miles
```

#### Path 2: MPX (MileagePlus X)

Buy eGift card through the MPX app, then shop at retailer.

```
mpx_miles    = p_card × m_r
card_miles   = p_card × c_r(k) × 1.25    # 25% Chase bonus for MPX
M_mpx        = mpx_miles + card_miles
```

No portal miles. No portal bonuses. Gift card purchases through the portal are explicitly excluded by FAQ.

#### Path 3: Stacked

Two-leg strategy: buy gift card via MPX (Leg 1), then shop through portal paying with gift card (Leg 2).

```
# Leg 1: MPX gift card purchase
mpx_miles    = p_card × m_r
card_miles   = p_card × c_r(k) × 1.25

# Leg 2: Portal shopping with gift card
portal_miles = γ_r × δ × p_portal × b_r
bonus_miles  = γ_r × bonus(r, p_portal)

M_stacked    = mpx_miles + card_miles + portal_miles + bonus_miles
```

**Gate variable:** `γ_r ∈ {0, 1}` — whether retailer `r` awards portal miles when paying with a gift card. Default: `γ_r = 0` (conservative).

When `γ_r = 0`: stacked path reduces to MPX path (Leg 2 contributes nothing).
When `γ_r = 1`: stacked path dominates both Direct and MPX.

### 2.3 Key Variables

| Symbol    | Definition                                     |
|-----------|-------------------------------------------------|
| `b_r`     | Portal base rate for retailer `r` (miles/$)     |
| `m_r`     | MPX earn rate for retailer `r` (miles/$)         |
| `c_r(k)`  | Chase card rate for category `k` (miles/$)       |
| `δ`       | Portal tracking risk class (see §2.4)            |
| `γ_r`     | Gift card portal eligibility gate                |
| `τ`       | Tax rate (default 0.08)                          |

### 2.4 Risk Classification (δ)

`δ` is NOT a multiplier. It is a **risk class** with three levels:

| Class       | Meaning                                        | Scoring behavior              |
|-------------|------------------------------------------------|-------------------------------|
| `confirmed` | Portal tracking verified for this retailer     | Portal miles included          |
| `uncertain` | No data or mixed reports                       | Portal miles included with warning |
| `excluded`  | Known tracking failures or exclusion terms     | Portal miles zeroed            |

**Critical invariant:** Card miles (`p_card × c_r(k)`) are ALWAYS earned regardless of δ. Portal tracking failures do not affect Chase credit card mile earning.

### 2.5 Bonus Types

Bonuses attach to retailers and have a `semantics` field:

| Semantics     | Formula                                     | Example                    |
|---------------|---------------------------------------------|----------------------------|
| `:total`      | `effective_rate = bonus_rate`               | "Earn 5x" → rate becomes 5 |
| `:incremental`| `effective_rate = base_rate + bonus_rate`    | "Earn +2x bonus" → base + 2|
| `:up_to`      | `effective_rate = min(bonus_rate, cap)`      | "Up to 8x"                 |
| `:flat_bonus` | `bonus_miles = flat_amount` (if threshold met)| "500 bonus miles on $50+"  |

Bonus types in the database:
- `flat_tiered` — flat mile bonuses with spend thresholds
- `rate_multiplier` — modified earn rate (must specify semantics)
- `per_order_flat` — flat bonus per order (requires order-level modeling)

### 2.6 Miles-per-Dollar Metric

```
MPD(r, path) = M(r, path) / p_cash
```

Primary ranking metric. Higher is better.

## 3. Type Hierarchy

### 3.1 Core Types (Julia)

```julia
struct SpendVector
    p_list::Float64
    p_portal::Float64
    p_card::Float64
    p_cash::Float64
    v_residual::Float64
end

@enum RiskClass confirmed uncertain excluded

@enum PathType direct mpx stacked

@enum BonusSemantic total incremental up_to flat_bonus

struct CardTier
    name::String
    base_rate::Float64           # miles per dollar (general spend)
    category_rates::Dict{String,Float64}  # category → miles per dollar
end

struct Retailer
    id::Int
    name::String
    base_rate::Float64           # portal base rate (b_r)
    mpx_rate::Union{Float64,Nothing}  # MPX rate (m_r), nothing if no MPX card
    gc_portal_eligible::Bool     # γ_r
    risk_class::RiskClass        # δ
    category::String
end

abstract type BonusOffer end

struct FlatTieredBonus <: BonusOffer
    retailer_id::Int
    thresholds::Vector{Tuple{Float64,Float64}}  # (min_spend, bonus_miles)
end

struct RateMultiplierBonus <: BonusOffer
    retailer_id::Int
    rate::Float64
    semantics::BonusSemantic
end

struct PerOrderFlatBonus <: BonusOffer
    retailer_id::Int
    bonus_miles::Float64
    min_spend::Float64
end

struct ScoreResult
    path::PathType
    portal_miles::Float64
    card_miles::Float64
    bonus_miles::Float64
    total_miles::Float64
    mpd::Float64
    risk_class::RiskClass
    spend::SpendVector
end
```

### 3.2 Scoring Functions

```julia
score_direct(retailer, spend, card, bonuses) → ScoreResult
score_mpx(retailer, spend, card) → ScoreResult
score_stacked(retailer, spend, card, bonuses) → ScoreResult
rank_all(retailers, spend, card, bonuses) → Vector{ScoreResult}  # sorted by MPD
```

## 4. API Endpoints

### 4.1 Julia Engine (port 5000)

| Method | Path              | Description                    | Timeout |
|--------|-------------------|--------------------------------|---------|
| GET    | `/health`         | Health check                   | 1s      |
| POST   | `/score`          | Score single retailer          | 2s      |
| POST   | `/rank`           | Rank all retailers             | 5s      |
| POST   | `/basket`         | Basket optimization (async)    | 30s     |
| GET    | `/basket/status/:id` | Poll MILP solution status   | 1s      |

### 4.2 Node Bridge (port 4000)

Proxies to Julia with timeouts, sequential queuing, and error handling. Same route structure as Julia engine. Serves as the backend for the React frontend.

### 4.3 React Frontend (port 3000)

Single-page app. Key views:
- **Score view:** Enter item, see miles breakdown across 3 paths
- **Rank view:** Table of all retailers sorted by MPD
- **Basket view:** Multi-item optimizer with greedy → MILP upgrade

All views show risk class column and "as of [timestamp]" from snapshot.

## 5. Basket Optimization (MILP)

### 5.1 Decision Variables

Order-level, not item-level:
- `x[i,r]` ∈ {0,1} — item `i` assigned to retailer `r`
- `y[r]` ∈ {0,1} — order placed at retailer `r`
- `z[r,path]` ∈ {0,1} — path chosen for retailer `r`

### 5.2 Objective

Maximize total miles across all items and orders.

### 5.3 Constraints

- Each item assigned to exactly one retailer (if retailer carries it)
- `y[r] ≥ x[i,r]` for all i,r (order exists if any item assigned)
- One path per retailer
- Budget constraint on `p_cash`
- Per-order bonuses attach to `y[r]`, not `x[i,r]`

### 5.4 Two-Phase Response

1. **Greedy solution** returned in <200ms (heuristic: assign each item to highest-MPD eligible retailer)
2. **MILP exact solution** computed asynchronously, polled via `/basket/status/:id`

Note: HiGHS cannot compute duals for MIPs. Do not expose dual values.

## 6. Database Schema

See `/db/schema.sql` for the complete DDL. Key tables:

- `scrape_snapshots` — scrape run metadata
- `retailers` — retailer master data
- `retailer_rates` — portal base rates (snapshot-scoped)
- `mpx_rates` — MPX earn rates (snapshot-scoped)
- `bonus_offers` — promotional bonuses with type and config (snapshot-scoped)
- `tc_rules` — parsed terms & conditions (snapshot-scoped, raw text archived)
- `process_constraints` — per-retailer process warnings
- `purchase_log` — purchase history with full SpendVector

**Invariant:** All scraped data rows carry `snapshot_id` FK. Scoring engine uses only the most recent complete snapshot. Never mix snapshot data in a single scoring pass.

## 7. Scraper Design

- **Runtime:** Playwright via Cowork (desktop only)
- **Frequency:** Maximum one full scrape per day
- **Delays:** Randomized 2–10 seconds between requests
- **Failure mode:** Fail closed — CAPTCHA, 429, or access-denied → abort, mark snapshot failed
- **Parallelism:** None. Sequential only.
- **Audit:** Log all requests

## 8. Build Phases

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

## 9. Chase Card Configuration

Default card tiers:

| Card                       | Base Rate | Dining | Travel | Gas  |
|----------------------------|-----------|--------|--------|------|
| United Explorer            | 1.0       | 2.0    | 2.0    | 1.0  |
| United Quest               | 1.0       | 3.0    | 2.0    | 1.0  |
| United Club Infinite       | 1.0       | 2.0    | 2.0    | 1.0  |

MPX purchases receive a 25% Chase bonus (1.25× card rate).

## 10. Design Decisions Log

1. **Card miles independent of δ** — Portal tracking failures do not affect Chase credit card mile earning. Card miles always use `p_card × c_r(k)` without any δ factor.
2. **δ as risk class, not multiplier** — Displayed as a column, not multiplied into scores. User selects risk tolerance for MILP filtering.
3. **Gift cards excluded from portal** — Per MileagePlus Shopping FAQ. MPX is the dedicated gift card channel.
4. **Conservative γ_r default** — Default `γ_r = 0`. Only set to 1 with manual verification.
5. **Snapshot isolation** — All scoring uses a single complete snapshot. No cross-snapshot data mixing.
6. **Order-level MILP** — Prevents double-counting per-order flat bonuses across items.
