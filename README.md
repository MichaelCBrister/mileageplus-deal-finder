# MileagePlus Deal Finder

Search for what you want to buy and find which MileagePlus Shopping retailer earns the most miles. Type "AirPods" or "running shoes" and get back a ranked list of retailers with earning paths, mile breakdowns, and direct portal links. Designed to run on an always-on PC and be accessed from any phone or device via a Cloudflare Tunnel.

## How It Works

The app compares three earning paths across all retailers in the MileagePlus Shopping portal:

- **Shop directly** — click through the portal, pay with your Chase United card
- **Buy gift card first** — buy an eGift card via the MileagePlus X app, earn MPX miles + 25% Chase bonus
- **Gift card + portal** — buy gift card via MPX, then shop through the portal (stacked path — earns the most when the retailer allows it)

The search bar interprets your query using the Claude API, estimates a price, scores every matching retailer across all three paths, and returns results ranked by total miles. Stale retailer data refreshes automatically in the background.

## Quick Start

### Prerequisites

- [Julia 1.10+](https://github.com/JuliaLang/juliaup) — install via juliaup
- Node.js 18+
- SQLite3

### Install

```bash
git clone <repo-url>
cd mileageplus-deal-finder
bash scripts/install.sh
```

`install.sh` installs all npm dependencies, Julia packages, initializes the database with seed data, and builds the React frontend.

### Configure

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

The API key is required for search query interpretation. Without it, search falls back to keyword matching.

### Run

```bash
bash scripts/start-prod.sh
```

Open **http://localhost:4000** in your browser. The bridge serves both the API and the static React app on one port.

Stop with:

```bash
bash scripts/stop-prod.sh
```

## Development Mode

```bash
bash scripts/start-dev.sh
```

Starts three processes with hot reload:

- Julia engine on port 5001
- Node bridge on port 4000
- Vite dev server on port 3000 (proxies `/api` to bridge)

Stop with `bash scripts/stop-dev.sh`.

## Cloudflare Tunnel (Remote Access)

A free Cloudflare Tunnel exposes the app to the internet with a real HTTPS domain. Family members can open `https://miles.yourdomain.com` from any phone.

### Step 1: Set up a domain

Register a domain and point its nameservers to Cloudflare (free plan at cloudflare.com).

### Step 2: Install cloudflared

```bash
brew install cloudflare/cloudflare/cloudflared
```

### Step 3: Authenticate

```bash
cloudflared tunnel login
```

A browser window opens. Select your domain.

### Step 4: Create a tunnel

```bash
cloudflared tunnel create mileageplus
```

Note the tunnel ID printed to the terminal.

### Step 5: Configure the tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/<your-username>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: miles.yourdomain.com
    service: http://localhost:4000
  - service: http_status:404
```

Replace `<tunnel-id>` with the ID from step 4, and `miles.yourdomain.com` with your chosen hostname.

### Step 6: Add DNS record

```bash
cloudflared tunnel route dns mileageplus miles.yourdomain.com
```

### Step 7: Run the tunnel

```bash
cloudflared tunnel run mileageplus
```

Or start automatically on boot:

```bash
brew services start cloudflare/cloudflare/cloudflared
```

The app is now accessible at `https://miles.yourdomain.com` from any device.

### Optional: Cloudflare Access (email-based authentication)

Cloudflare Access is free for up to 50 users. It adds email-based login with 30-day sessions — useful if you want to restrict access to family members only.

Set it up at `dash.cloudflare.com` → Zero Trust → Access → Applications → Add an application → Self-hosted. Set the hostname to `miles.yourdomain.com` and configure an email policy listing the email addresses you want to allow.

`start-prod.sh` automatically starts `cloudflared tunnel run` if cloudflared is installed and `~/.cloudflared/config.yml` exists.

## Troubleshooting

**Port conflict on 5001**

macOS AirPlay Receiver uses port 5000. The app defaults to Julia on port 5001. If 5001 is also taken, set `JULIA_ENGINE_PORT=5002` in `.env`.

**Julia not found**

Install via juliaup:

```bash
curl -fsSL https://install.julialang.org | sh
```

Then reopen your terminal and re-run `bash scripts/install.sh`.

**API key missing — search returns no results**

Set `ANTHROPIC_API_KEY` in `.env`. Without it, query interpretation is disabled and the app falls back to matching all retailers by category.

**Frontend not loading (404 on /)**

Rebuild the frontend:

```bash
cd frontend && npm run build
```

The bridge serves `frontend/dist/` in production mode. If the directory doesn't exist, all routes return 404.

**Julia engine takes ~20 seconds to start**

Normal. Julia's JIT compiler runs on first launch. All subsequent requests are fast. `start-prod.sh` waits for the health check before starting the bridge.

**Cloudflare Tunnel not connecting**

Check `logs/cloudflared.log`. Verify the tunnel ID in `~/.cloudflared/config.yml` matches the output of `cloudflared tunnel list`. Ensure DNS propagation has completed (can take a few minutes after step 6).

## Architecture

```
Browser (http://localhost:4000 or https://miles.yourdomain.com)
  |
  | (prod: Cloudflare Tunnel → cloudflared on your PC)
  ↓
Express bridge (port 4000)
  ├── Serves frontend/dist/ as static files (production)
  ├── POST /api/search → Claude API + Julia engine
  ├── GET  /api/search/status/:id → progressive loading
  └── /api/purchases, /api/config, /api/parse-tc, ...
         ↓
      Julia engine (port 5001) → SQLite
         ↑
      Playwright scraper (runs via Cowork on desktop, writes to SQLite)
```

In development, a Vite dev server on port 3000 proxies `/api` requests to the bridge. In production, the bridge serves both the API and the built frontend on port 4000.

## Environment Variables

See `.env.example` for all options. Key variables:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for search query interpretation |
| `MILEAGEPLUS_USERNAME` | — | Portal credentials for live scraping |
| `MILEAGEPLUS_PASSWORD` | — | Portal credentials for live scraping |
| `JULIA_ENGINE_PORT` | `5001` | Port for Julia HTTP server |
| `NODE_ENV` | `production` | Set to `development` for Vite dev server mode |
| `FRESHNESS_HOURS` | `24` | How old retailer data can be before auto-refresh |

## Build Phases

| Phase | Status | Description |
|---|---|---|
| 1–9 | Complete | Julia engine, scoring, ranking, MILP basket, v1 UI |
| 10 | Complete | Single-retailer on-demand scraper + freshness middleware |
| 11 | Complete | `/api/search` with Claude API query interpretation |
| 12 | Complete | Frontend redesign: search bar, result cards, portal links |
| 13 | Complete | Progressive loading for stale retailers |
| 14 | Complete | Purchases page + settings page + mobile polish |
| 15 | Complete | Production build + startup scripts + Cloudflare Tunnel prep |

## Costs

- Anthropic API: ~$3–5/month (search query interpretation at ~$0.002/search)
- Cloudflare Tunnel + Access: free
- Domain: ~$10/year
