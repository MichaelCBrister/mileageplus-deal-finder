#!/bin/bash
# install.sh — First-time setup: install all dependencies, initialize the database,
#              and build the frontend.
# Usage: bash scripts/install.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "MileagePlus Deal Finder — Installation"
echo "======================================="

# 1. Node dependencies
for dir in bridge frontend scraper; do
  if [ -d "$ROOT/$dir" ]; then
    echo "Installing $dir npm dependencies..."
    cd "$ROOT/$dir" && npm install
  fi
done

# 2. Julia packages
echo "Installing Julia packages..."
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
echo "  Using Julia: $JULIA_BIN"
cd "$ROOT/engine"
JULIA_PKG_SERVER="" "$JULIA_BIN" --project=. -e 'using Pkg; Pkg.instantiate()'
echo "Julia packages installed."

# 3. Database
echo "Initializing database..."
bash "$ROOT/db/init.sh"

# 4. Frontend production build
echo "Building frontend..."
cd "$ROOT/frontend"
npm run build
echo "Frontend build complete."

echo ""
echo "======================================="
echo "  Installation complete."
echo ""
echo "  Next steps:"
echo "  1. Create your .env file:"
echo "       cp .env.example .env"
echo "     Then edit .env and set ANTHROPIC_API_KEY."
echo ""
echo "  2. Start the production server:"
echo "       bash scripts/start-prod.sh"
echo ""
echo "  3. Open http://localhost:4000 in your browser."
echo ""
echo "  For Cloudflare Tunnel setup, see README.md."
echo "======================================="
