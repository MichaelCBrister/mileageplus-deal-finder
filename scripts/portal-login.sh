#!/usr/bin/env bash
# portal-login.sh — Manual portal login for live scraping
#
# To enable live portal scraping, run this script which will open a browser
# window. Log in to MileagePlus Shopping, complete 2FA, then close the
# browser. Your session cookies will be saved for the scraper to reuse.
#
# This is not yet implemented — for now, the scraper uses mock data.
#
# When implemented, this script will:
#   1. Launch a Playwright Chromium browser with a persistent context
#      saved to scraper/.browser-session/
#   2. Open https://shopping.mileageplus.com
#   3. Wait for you to complete login and 2FA manually
#   4. Save the authenticated session to disk
#   5. The scraper will reuse this session for all subsequent scrapes
#      until the session expires (typically 30 days)
#
# Prerequisites (when implemented):
#   - MILEAGEPLUS_USERNAME and MILEAGEPLUS_PASSWORD in .env
#   - cd scraper && npm install && npx playwright install chromium

echo ""
echo "=== MileagePlus Shopping Portal Login ==="
echo ""
echo "Live portal scraping is not yet implemented."
echo "The scraper currently uses mock data for all operations."
echo ""
echo "To set up live scraping in the future:"
echo "  1. Ensure MILEAGEPLUS_USERNAME and MILEAGEPLUS_PASSWORD are in .env"
echo "  2. cd scraper && npx playwright install chromium"
echo "  3. Re-run this script (when implemented) to authenticate"
echo "  4. The browser session will be saved for the scraper to reuse"
echo ""
echo "For now, mock data provides 3 retailers: BestBuy, Nike, Walmart."
echo ""
