#!/bin/bash
# stop-dev.sh — Stop all dev processes started by start-dev.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/logs/pids.txt"

if [ ! -f "$PIDFILE" ]; then
    echo "No PID file found at $PIDFILE"
    echo "Attempting to kill processes by port..."
    for port in 5000 4000 3000; do
        pid=$(lsof -ti:$port 2>/dev/null)
        if [ -n "$pid" ]; then
            echo "  Killing PID $pid on port $port"
            kill $pid 2>/dev/null
        fi
    done
    exit 0
fi

echo "Stopping MileagePlus Deal Finder dev processes..."
while IFS= read -r pid; do
    if kill -0 "$pid" 2>/dev/null; then
        echo "  Killing PID $pid"
        kill "$pid" 2>/dev/null
    else
        echo "  PID $pid already stopped"
    fi
done < "$PIDFILE"

rm -f "$PIDFILE"
echo "All processes stopped."
