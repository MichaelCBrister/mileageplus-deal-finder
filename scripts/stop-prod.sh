#!/bin/bash
# stop-prod.sh — Stop all production processes started by start-prod.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/logs/pids-prod.txt"

if [ ! -f "$PIDFILE" ]; then
  echo "No PID file found at $PIDFILE"
  echo "Attempting to kill processes by port..."
  for port in 5001 4000; do
    pid=$(lsof -ti:$port 2>/dev/null)
    if [ -n "$pid" ]; then
      echo "  Killing PID $pid on port $port"
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Also kill cloudflared if running
  pkill -f "cloudflared tunnel run" 2>/dev/null && echo "  Stopped cloudflared" || true
  exit 0
fi

echo "Stopping production processes..."
while IFS= read -r pid; do
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "  Killing PID $pid"
    kill "$pid" 2>/dev/null || true
  else
    echo "  PID $pid already stopped"
  fi
done < "$PIDFILE"

rm -f "$PIDFILE"
echo "All processes stopped."
