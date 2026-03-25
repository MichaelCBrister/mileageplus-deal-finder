#!/bin/bash
# start-dev.sh — Start all three dev processes: Julia engine, Node bridge, Vite frontend
# PIDs are written to logs/pids.txt for stop-dev.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

echo "Starting MileagePlus Deal Finder dev environment..."

# 0. Ensure npm dependencies are installed
for dir in bridge scraper; do
  if [ ! -d "$ROOT/$dir/node_modules" ]; then
    echo "Installing $dir dependencies..."
    cd "$ROOT/$dir" && npm install
  fi
done

# 1. Julia engine (port 5000)
echo "Starting Julia engine..."
cd "$ROOT/engine"
JULIA_PKG_SERVER="" /opt/miniconda3/bin/julia --project=. src/server.jl > "$LOGS/julia.log" 2>&1 &
JULIA_PID=$!
echo "  Julia PID: $JULIA_PID"

# Wait for Julia to be ready
sleep 3
echo "  Waiting for Julia health check..."
for i in 1 2 3 4 5; do
    if curl -s http://localhost:5000/health > /dev/null 2>&1; then
        echo "  Julia engine is healthy."
        break
    fi
    if [ "$i" -eq 5 ]; then
        echo "  WARNING: Julia engine did not respond to health check after 8s."
        echo "  Check $LOGS/julia.log for errors."
    fi
    sleep 1
done

# 2. Node bridge (port 4000)
echo "Starting Node bridge..."
cd "$ROOT/bridge"
node server.js > "$LOGS/bridge.log" 2>&1 &
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
echo "All processes started."
echo "  Julia engine: http://localhost:5000 (PID $JULIA_PID)"
echo "  Node bridge:  http://localhost:4000 (PID $BRIDGE_PID)"
echo "  React UI:     http://localhost:3000 (PID $FRONTEND_PID)"
echo ""
echo "PIDs saved to $LOGS/pids.txt"
echo "Logs in $LOGS/{julia,bridge,frontend}.log"
echo "Run scripts/stop-dev.sh to stop all processes."
