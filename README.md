# MileagePlus Deal Finder

A personal tool that finds the best miles-per-dollar value when purchasing through the United MileagePlus Shopping portal. It treats retailer selection as a formal mathematical optimization problem, comparing three distinct earning paths across all available retailers and solving an order-level MILP for multi-item baskets.

## Architecture

Four layers: **Capture -> Store -> Compute -> Display**

| Layer   | Tech                          | Location              |
|---------|-------------------------------|-----------------------|
| Capture | Playwright via Cowork         | `/scraper`            |
| Store   | SQLite                        | `/db`                 |
| Compute | Julia (HTTP.jl, JuMP, HiGHS) | `/engine`             |
| Display | Node.js/Express + React       | `/bridge` + `/frontend` |

```
Browser -> React (:3000) -> Express (:4000) -> Julia HTTP.jl (:5000) -> SQLite
                                                                           ^
                                                     Playwright scraper ---+
```

## Three Earning Paths

- **Direct:** Click through the MileagePlus Shopping portal, pay with Chase United card. Earns portal miles + card miles + bonus miles.
- **MPX:** Buy an eGift card through the MileagePlus X app, then shop at the retailer. Earns MPX miles + card miles + 25% Chase bonus.
- **Stacked:** Buy gift card via MPX (Leg 1), then shop through portal paying with the gift card (Leg 2). When the retailer allows portal miles on gift card payment, this dominates both Direct and MPX.

## Build Phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | Complete | Julia engine skeleton + SpendVector + score_direct |
| 2 | Complete | Node bridge + React UI for single-item scoring |
| 3 | Complete | SQLite schema + snapshot model + seed data |
| 4 | Complete | MPX + Stacked paths + rank_all + multi-path UI |
| 5 | Complete | Claude API T&C parser + bonus classification |
| 6 | Complete | Playwright scraper with snapshot grouping |
| 7 | Complete | Purchase log with spend vector + posting tracker |
| 8 | Complete | Order-level MILP basket optimizer |
| 9 | Complete | Breakpoint sweep sensitivity + v1 polish |

## Setup

### Prerequisites

- Julia 1.10+ (via juliaup or conda: `conda install -c conda-forge julia`)
- Node.js 18+
- Playwright Chromium (for live scraping only)

### Installation

```bash
git clone <repo-url>
cd mileageplus-deal-finder

# Initialize database with seed data
bash db/init.sh

# Install Node dependencies
cd bridge && npm install && cd ..
cd frontend && npm install && cd ..
cd scraper && npm install && cd ..

# Install Julia packages
cd engine && JULIA_PKG_SERVER="" julia --project=. -e 'using Pkg; Pkg.instantiate()' && cd ..
```

### Running

```bash
bash scripts/start-dev.sh
```

This starts all three processes:
- Julia engine on http://localhost:5000
- Node bridge on http://localhost:4000
- React frontend on http://localhost:3000

Stop with `bash scripts/stop-dev.sh`.

## Known Gaps

- **Live portal scraping** requires Cowork with real MileagePlus credentials on a desktop machine. The scraper includes mock mode for testing.
- **ANTHROPIC_API_KEY** is required for Claude API T&C parsing endpoints. Without it, the scraper writes raw text with confidence=0.0 and the engine treats those retailers as uncertain risk.
- **Dual variables** for the MILP are not available (HiGHS limitation for MIPs). Option 2 (no duals) was chosen per v3-spec.
