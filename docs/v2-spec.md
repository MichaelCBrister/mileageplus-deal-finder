# MileagePlus Deal Finder — v2 Product Specification

**Date:** March 25, 2026
**Status:** Draft. Builds on v1.0.0 (all 9 phases complete, 204 tests passing).
**Goal:** Transform the local developer tool into a search engine for MileagePlus Shopping that anyone can use from any device.

---

## 1. The Product in One Sentence

You type what you want to buy, the app tells you which MileagePlus Shopping retailer earns the most miles, and links you straight to it.

---

## 2. What v2 Is

**A search engine.** The entire home screen is a search bar. No tabs, no dropdowns, no forms. Type "AirPods" or "running shoes" or "Best Buy" and hit search. Results appear ranked by miles earned, with direct links to the MileagePlus Shopping portal page for each retailer.

**Invisible infrastructure.** The scraper, parser, scoring engine, and ranking engine all work behind the scenes. The user never sees them. When data is stale, the app refreshes it silently during the search. When T&C text needs parsing, the Claude API handles it automatically.

**Accessible from anywhere.** Family members get a URL they can open on their phone from anywhere. A Cloudflare Tunnel connects the app (running on your always-on PC) to the internet with a real HTTPS domain.

### What v1 Was (and why it changes)

v1 was a developer tool with five tabs (Score, Rank, Basket, Purchases, Scraper) that required you to know retailer names, portal categories, and spend vectors. v2 kills four of those tabs and replaces them with a search bar. The Julia scoring engine, three earning paths, MILP optimizer, and database layer all remain unchanged underneath.

---

## 3. User Interface

### 3.1 Home Screen

The entire screen is:
- App title / logo at the top
- A search bar in the center: "What are you looking to buy?"
- Nothing else

No tabs visible on the home screen. Navigation to Purchases and Settings is a small icon or hamburger menu in the corner.

### 3.2 Search Results

After searching, the results page shows:

**Search bar** at the top (pre-filled with the query, editable for refinement).

**Filters toggle** — a small "Filters" button that expands a collapsible panel:
- **Card tier:** Dropdown defaulting to "No Chase United card." Changing it re-runs the search with the new tier. The selection persists for the browser session (sessionStorage) but resets to "No Chase card" when the user closes the site and comes back.
- **Exclude stores:** Checkboxes to hide specific retailers from results. Useful if you know you won't shop at certain stores.
- **Price override:** Optional field to override the AI-estimated price if the user knows the exact price. Empty by default (uses the AI estimate).

**Results list** — ranked by total miles, highest first. Each result is a card showing:
- **Retailer name** (e.g., "Best Buy")
- **Earning path** shown as a simple label: "Shop directly" (direct), "Buy gift card first" (MPX), or "Gift card + portal" (stacked)
- **Total miles earned** — the big number
- **Miles breakdown** — smaller text: "400 portal + 216 card + 500 bonus"
- **Risk badge** — green "Confirmed" or yellow "Uncertain" (red "Excluded" results are hidden by default since they earn 0 portal miles)
- **Link button** — "Shop at Best Buy" that opens the retailer's MileagePlus Shopping portal page in a new tab
- **Log button** — small "Log purchase" link that records the purchase to the Purchases page

The **#1 result** is visually distinguished (larger card, highlighted border, "Top Pick" badge).

Below the top result, 3-5 alternatives are shown in smaller cards. If more results exist, a "Show all N results" expander reveals the full list.

### 3.3 Mobile Layout

Results are single-column cards that stack vertically. The search bar is full-width. The filters panel slides down from the search bar. Links and buttons are large enough to tap. This is the primary use case — family members on their phones.

### 3.4 Purchases Page

Accessed via a small icon in the navigation (not a tab). Keeps the existing v1 functionality:
- Purchase history table with status badges (posted/pending/overdue)
- Summary stats (total purchases, expected vs posted miles, posting rate)
- Mark-posted and delete actions
- Manual log form for purchases made outside the app

### 3.5 Settings Page

Accessed via a gear icon. Contains:
- **Default card tier** — sets the default for new sessions (but session override still resets on close)
- **Local tax rate** — used for spend vector calculation, hidden from the search UI
- **Freshness threshold** — how old retailer data can be before auto-refresh (default 24 hours)
- **MileagePlus credentials** — username/password for the scraper (stored locally, never transmitted)
- **API key status** — shows whether ANTHROPIC_API_KEY is configured

---

## 4. Search Flow (What Happens When You Hit Search)

### Step 1: Query Interpretation (Bridge → Claude API)

The bridge sends the search query to the Claude API with a system prompt that returns:
- **interpreted_category:** The MileagePlus Shopping category (e.g., "Electronics")
- **estimated_price:** Estimated retail price for the product
- **likely_retailers:** Array of retailer names likely to carry this product
- **query_type:** One of "product" (AirPods), "category" (headphones), or "retailer" (Best Buy)

If query_type is "retailer," the app searches for that specific retailer. If "product" or "category," it searches across all retailers that match the category.

Cost: ~$0.002 per search (500 tokens at Sonnet pricing).

### Step 2: Freshness Check (Bridge → SQLite)

For each relevant retailer, check the last scrape timestamp. If older than the freshness threshold (default 24 hours), mark as stale.

### Step 3: Scoring (Bridge → Julia Engine)

For fresh retailers: call Julia `/rank` with the interpreted category, estimated price, and card tier from the session. Results come back immediately.

For stale retailers: return fresh results immediately and show "Refreshing N stores..." indicator. Kick off background scraping for stale retailers (see Section 5).

### Step 4: Results Assembly (Bridge)

Combine all scored results, sort by total miles descending, attach portal URLs, and return to the frontend.

### Step 5: Progressive Update (Frontend)

If any retailers were stale, the frontend polls for updates. As each stale retailer finishes scraping and scoring, its results are inserted into the list in the correct sort position. The "Refreshing..." indicator updates and eventually disappears.

---

## 5. On-Demand Scraping

### Single-Retailer Scraper

v1's scraper (`scraper/src/scraper.js`) scrapes all retailers in one batch. v2 adds a `scrapeOne(retailerName)` function that:
1. Opens the Playwright browser (persistent session, reuses cookies)
2. Navigates to the retailer's MileagePlus Shopping portal page
3. Extracts: base rate, bonus offer text, T&C text, portal URL
4. Calls Claude API to parse T&C and bonus text
5. Updates database rows for that retailer
6. Returns in 5-10 seconds

### Authentication

Playwright uses a persistent browser context saved to disk. Credentials (MILEAGEPLUS_USERNAME, MILEAGEPLUS_PASSWORD) are used to log in when the session expires. The browser context persists across scrapes, so most scrapes don't need to re-authenticate.

### When Scraping Happens

- **On search:** If any relevant retailer is stale, scrape it in the background while returning fresh results immediately
- **Never on a schedule:** No cron jobs. Scraping only happens when a user searches
- **Rate limiting:** Maximum one scrape per retailer per 24 hours. Randomized 2-10 second delays between portal page loads

### Portal URL Extraction

When scraping a retailer, the scraper captures the retailer's MileagePlus Shopping portal URL (e.g., `https://shopping.mileageplus.com/b?XID=...&retailer=bestbuy`). This URL is stored in the `retailers.portal_url` column and used as the "Shop at [Retailer]" link in search results. The link takes the user directly to the portal click-through page, which starts the tracking cookie for mile earning.

---

## 6. Architecture

```
Phone/Browser (miles.yourdomain.com)
         |
  Cloudflare Tunnel (free)
         |
  Your PC (always on)
         |
  React Frontend (port 3000) — search bar + results
         |
  Express Bridge (port 4000)
         |--- POST /api/search — query interpretation + scoring + results
         |--- GET /api/search/status/:id — progressive loading poll
         |--- GET /api/purchases — purchase history
         |--- POST /api/purchases — log a purchase
         |--- PATCH /api/purchases/:id/posted — mark posted
         |--- DELETE /api/purchases/:id — delete purchase
         |--- Claude API — query interpretation + T&C parsing
         |--- Playwright — on-demand single-retailer scraping
         |--- Julia Engine (port 5001) — scoring, ranking
                  |--- SQLite — all persistent data
```

### What's Removed from v1 Bridge

- `/api/score` — replaced by `/api/search`
- `/api/rank` — replaced by `/api/search`
- `/api/basket` and `/api/basket/status` — removed (Basket tab killed)
- `/api/sweep` — removed (sweep tab killed)
- `/api/scraper/status` and `/api/scraper/run-check` — removed (scraper is invisible)
- `/api/parse-tc` and `/api/parse-bonus` — still exist but are called internally by the scraper, not exposed to the frontend

### What's Kept from v1

- Julia engine: all scoring functions, all paths, all bonus types — unchanged
- SQLite schema — unchanged (one new table, one new column added)
- Purchase log endpoints — unchanged
- All 204 Julia tests — unchanged

---

## 7. The /api/search Endpoint

### Request

```json
{
  "query": "AirPods Pro",
  "card_tier": "none",
  "exclude_retailers": [],
  "price_override": null
}
```

### Response (immediate)

```json
{
  "search_id": "uuid",
  "query": "AirPods Pro",
  "interpreted": {
    "category": "Electronics",
    "estimated_price": 249.99,
    "likely_retailers": ["BestBuy", "Walmart", "Target"],
    "query_type": "product"
  },
  "results": [
    {
      "retailer": "BestBuy",
      "path": "direct",
      "path_label": "Shop directly",
      "total_miles": 1116,
      "breakdown": {
        "portal": 500,
        "card": 216,
        "bonus": 500
      },
      "risk_class": "confirmed",
      "portal_url": "https://shopping.mileageplus.com/b?XID=...&retailer=bestbuy",
      "data_age_hours": 2.3,
      "stale": false
    }
  ],
  "stale_retailers": ["Target"],
  "refreshing": true,
  "result_count": 9,
  "top_pick_index": 0
}
```

### Progressive Loading

If `refreshing` is true, the frontend polls `GET /api/search/status/:search_id` every 2 seconds. Each poll returns the updated results array with newly scraped retailers added. When `refreshing` becomes false, polling stops.

---

## 8. Database Changes

### New Table

```sql
CREATE TABLE search_log (
  search_id          TEXT PRIMARY KEY,
  query              TEXT NOT NULL,
  interpreted_category TEXT,
  estimated_price    REAL,
  likely_retailers   TEXT,  -- JSON array
  card_tier          TEXT,
  result_count       INTEGER,
  top_retailer       TEXT,
  top_miles          INTEGER,
  searched_at        TEXT NOT NULL
);
```

### New Column

```sql
ALTER TABLE retailers ADD COLUMN last_scraped TEXT;
```

This denormalizes the freshness check — instead of joining through snapshots, the bridge can check `retailers.last_scraped` directly.

---

## 9. Remote Access: Cloudflare Tunnel

### Setup

1. Register a domain (or use an existing one). Point nameservers to Cloudflare (free plan).
2. Install cloudflared on your Mac: `brew install cloudflare/cloudflare/cloudflared`
3. Authenticate: `cloudflared tunnel login`
4. Create tunnel: `cloudflared tunnel create mileageplus`
5. Configure:

```yaml
# ~/.cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: miles.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

6. Add DNS: `cloudflared tunnel route dns mileageplus miles.yourdomain.com`
7. Run: `cloudflared tunnel run mileageplus`
8. Optional: `brew services start cloudflare/cloudflare/cloudflared` to run on boot

### Access Control (Optional)

Cloudflare Access (free for up to 50 users) adds email-based authentication:
- Family members enter their email, get a one-time code
- Sessions last 30 days
- No passwords to manage

---

## 10. API Key and Costs

| Item | Cost |
|------|------|
| Anthropic API key (query interpretation + T&C parsing) | ~$3-5/month |
| Domain name | ~$10/year |
| Cloudflare Tunnel + Access | Free |
| Your PC electricity (always on) | Existing cost |

Total: roughly $5/month.

---

## 11. Build Phases

| Phase | Scope | Acceptance Test |
|-------|-------|-----------------|
| 10 | Single-retailer on-demand scraper + freshness middleware | Search for a stale retailer auto-refreshes before scoring |
| 11 | /api/search endpoint with Claude API query interpretation | POST /api/search with "AirPods" returns ranked results with category and price |
| 12 | Frontend redesign: search bar home, result cards, filters, portal links | User can search, see results, tap to open portal page |
| 13 | Progressive loading: instant fresh results + live updates for stale retailers | Stale retailers show spinner, results update as scrapes complete |
| 14 | Purchases page + settings page + mobile polish | Purchases history works, card tier persists in session, mobile layout clean |
| 15 | Cloudflare Tunnel + Access setup + production build + startup scripts | App accessible at miles.yourdomain.com with email auth |

### Phase Dependencies

10 → 11 → 12 → 13 (critical path: scraper → search → UI → progressive loading)
14 can run in parallel with 13 (purchases + settings are independent)
15 runs after 12 (needs the new frontend to be built)

---

## 12. What Gets Removed from v1

### Frontend
- Score tab — gone (replaced by search)
- Rank tab — gone (replaced by search)
- Basket tab — gone entirely
- Scraper tab — gone (scraping is invisible)
- SweepPanel — gone (sensitivity analysis not user-facing)
- All tab navigation — replaced by search bar + icon nav

### Bridge Endpoints (no longer exposed to frontend)
- POST /api/score — still callable internally but not from the UI
- POST /api/rank — still callable internally but not from the UI
- POST /api/basket — removed
- GET /api/basket/status — removed
- POST /api/sweep — removed
- GET /api/scraper/status — removed
- GET /api/scraper/run-check — removed

### Julia Engine
- Nothing removed. All scoring, ranking, basket, and sweep code stays. The search endpoint calls rank_all internally.

### Tests
- All 204 Julia tests remain and must continue to pass.

---

## 13. Security

- **Cloudflare Access** handles authentication (email-based, free)
- **Credentials** (.env file on your PC: MILEAGEPLUS_USERNAME, MILEAGEPLUS_PASSWORD, ANTHROPIC_API_KEY) — never committed to git, never transmitted to frontend
- **Portal data** (retailer rates, bonuses) is visible to anyone with access — low sensitivity
- **Purchase log** (your purchase history) is more sensitive — Cloudflare Access recommended

---

## 14. Deferred Items

- **Price comparison across retailers** — would need product-level pricing data, not just portal rates
- **Multi-account support** — multiple MileagePlus accounts for different family members
- **Push notifications** — "Your purchase posted!"
- **Basket optimizer in search** — "I want to buy these 5 things, optimize across retailers"
- **Browser extension** — "I'm on amazon.com, should I buy through the portal instead?"

---

*Commit this file to docs/v2-spec.md in the repository.*
