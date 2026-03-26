#!/bin/bash
# start-dev.sh — Start all three dev processes: Julia engine, Node bridge, Vite frontend
# PIDs are written to logs/pids.txt for stop-dev.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

echo "Starting MileagePlus Deal Finder dev environment..."

# Kill any stale processes from prior sessions before starting fresh
pkill -f "src/server.jl" 2>/dev/null || true
pkill -f "$ROOT/bridge/server.js" 2>/dev/null || true
# Also kill any bridge holding port 4000 that may have started from a different path
lsof -ti :4000 | xargs kill -9 2>/dev/null || true
sleep 1

# 0. Ensure npm dependencies are installed
for dir in bridge scraper; do
  if [ ! -d "$ROOT/$dir/node_modules" ]; then
    echo "Installing $dir dependencies..."
    cd "$ROOT/$dir" && npm install
  fi
done

# 1. Julia engine (port 5001 — port 5000 is reserved by macOS AirPlay Receiver)
JULIA_ENGINE_PORT="${JULIA_ENGINE_PORT:-5001}"
echo "Starting Julia engine on port $JULIA_ENGINE_PORT..."
cd "$ROOT/engine"
# Resolve Julia binary: prefer juliaup (~/.juliaup/bin/julia), then PATH, then legacy paths
if [ -f "$HOME/.juliaup/bin/julia" ]; then
  JULIA_BIN="$HOME/.juliaup/bin/julia"
elif command -v julia >/dev/null 2>&1; then
  JULIA_BIN="$(command -v julia)"
elif [ -f /usr/local/bin/julia ]; then
  JULIA_BIN="/usr/local/bin/julia"
else
  echo "ERROR: julia not found. Install via https://julialang.org/downloads/" >&2
  exit 1
fi
echo "  Using Julia: $JULIA_BIN"
JULIA_ENGINE_PORT="$JULIA_ENGINE_PORT" JULIA_PKG_SERVER="" "$JULIA_BIN" --project=. src/server.jl > "$LOGS/julia.log" 2>&1 &
JULIA_PID=$!
echo "  Julia PID: $JULIA_PID"

# Wait for Julia to be ready
sleep 5
echo "  Waiting for Julia health check (Julia JIT startup takes ~15s)..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$JULIA_ENGINE_PORT/health" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
        echo "  Julia engine is healthy."
        break
    fi
    if [ "$i" -eq 15 ]; then
        echo "  WARNING: Julia engine did not respond to health check after 20s."
        echo "  Check $LOGS/julia.log for errors."
    fi
    sleep 1
done

# 2. Node bridge (port 4000)
echo "Starting Node bridge..."
cd "$ROOT/bridge"
JULIA_ENGINE_URL="http://localhost:$JULIA_ENGINE_PORT" node server.js > "$LOGS/bridge.log" 2>&1 &
BRIDGE_PID=$!
echo "  Bridge PID: $BRIDGE_PID"
sleep 1

# 3. Vite frontend (port 3000)
echo "Starting Vite frontend..."
cd "$ROOT/frontend"
npx vite --host > "$LOGS/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "  Frontend PID: $FRONTEND_PID"

# Write PIDs for stop-dev.sh
echo "$JULIA_PID" > "$LOGS/pids.txt"
echo "$BRIDGE_PID" >> "$LOGS/pids.txt"
echo "$FRONTEND_PID" >> "$LOGS/pids.txt"

echo ""
echo "=============================================="
echo "  Dev stack running."
echo "  Julia:    http://localhost:$JULIA_ENGINE_PORT"
echo "  Bridge:   http://localhost:4000"
echo "  Frontend: http://localhost:3000"
echo ""
echo "  Note: seed snapshot is from 2026-03-24 and"
echo "  will show as stale. Run the scraper to refresh."
echo "=============================================="
echo ""
echo "PIDs saved to $LOGS/pids.txt"
echo "Logs in $LOGS/{julia,bridge,frontend}.log"
echo "Run scripts/stop-dev.sh to stop all processes."
