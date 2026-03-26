#!/bin/bash
# start-prod.sh — Start Julia engine + Node bridge in production mode.
# The bridge serves frontend/dist/ as static files (no Vite dev server needed).
# Usage: bash scripts/start-prod.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

# Source .env if present — exports each variable into the environment.
if [ -f "$ROOT/.env" ]; then
  echo "Loading environment from .env..."
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

echo "Starting MileagePlus Deal Finder (production)..."

# Kill any stale processes from prior sessions
pkill -f "src/server.jl" 2>/dev/null || true
lsof -ti :4000 | xargs kill -9 2>/dev/null || true
sleep 1

# Build frontend
echo "Building frontend..."
cd "$ROOT/frontend"
npm run build
echo "Frontend build complete."

# Resolve Julia binary: prefer juliaup, then PATH, then legacy path
if [ -f "$HOME/.juliaup/bin/julia" ]; then
  JULIA_BIN="$HOME/.juliaup/bin/julia"
elif command -v julia >/dev/null 2>&1; then
  JULIA_BIN="$(command -v julia)"
elif [ -f /usr/local/bin/julia ]; then
  JULIA_BIN="/usr/local/bin/julia"
else
  echo "ERROR: julia not found. Install via https://github.com/JuliaLang/juliaup" >&2
  exit 1
fi
echo "Using Julia: $JULIA_BIN"

# Start Julia engine
JULIA_ENGINE_PORT="${JULIA_ENGINE_PORT:-5001}"
echo "Starting Julia engine on port $JULIA_ENGINE_PORT..."
cd "$ROOT/engine"
JULIA_ENGINE_PORT="$JULIA_ENGINE_PORT" JULIA_PKG_SERVER="" "$JULIA_BIN" --project=. src/server.jl \
  > "$LOGS/julia-prod.log" 2>&1 &
JULIA_PID=$!
echo "  Julia PID: $JULIA_PID"

# Wait for Julia to pass health check (JIT startup can take ~20s)
echo "  Waiting for Julia engine (JIT startup takes ~20s)..."
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$JULIA_ENGINE_PORT/health" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "  Julia engine is healthy."
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "  WARNING: Julia engine did not respond after 40s. Check $LOGS/julia-prod.log"
  fi
  sleep 2
done

# Start Node bridge in production mode (serves frontend/dist/ + API)
echo "Starting Node bridge (production, port 4000)..."
cd "$ROOT/bridge"
NODE_ENV=production JULIA_ENGINE_URL="http://localhost:$JULIA_ENGINE_PORT" \
  node server.js > "$LOGS/bridge-prod.log" 2>&1 &
BRIDGE_PID=$!
echo "  Bridge PID: $BRIDGE_PID"
sleep 1

# Optionally start cloudflared if installed and configured
CLOUDFLARED_PID=""
if command -v cloudflared >/dev/null 2>&1 && [ -f "$HOME/.cloudflared/config.yml" ]; then
  echo "Starting cloudflared tunnel..."
  cloudflared tunnel run > "$LOGS/cloudflared.log" 2>&1 &
  CLOUDFLARED_PID=$!
  echo "  cloudflared PID: $CLOUDFLARED_PID"
fi

# Write PIDs for stop-prod.sh
{
  echo "$JULIA_PID"
  echo "$BRIDGE_PID"
  [ -n "$CLOUDFLARED_PID" ] && echo "$CLOUDFLARED_PID"
} > "$LOGS/pids-prod.txt"

echo ""
echo "=============================================="
echo "  Production server running."
echo "  http://localhost:4000"
echo ""
echo "  Logs in $LOGS/{julia,bridge}-prod.log"
echo "  PIDs saved to $LOGS/pids-prod.txt"
echo "  Run scripts/stop-prod.sh to stop."
echo "=============================================="
