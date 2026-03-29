#!/usr/bin/env node
// portal-login.js — Manual 2FA login to MileagePlus Shopping portal
// Launches a visible Chromium browser with persistent context so the user can
// log in manually. The session (cookies + storage) is saved to disk and reused
// by the live scraper.

const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const AUTH_DIR = path.join(__dirname, '..', 'auth', 'browser-context');
const PORTAL_URL = 'https://shopping.mileageplus.com';

async function main() {
  console.log('=== MileagePlus Shopping Portal — Manual Login ===\n');
  console.log(`Session will be saved to: ${AUTH_DIR}\n`);

  // Launch persistent browser context (auto-saves cookies/storage to AUTH_DIR)
  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = context.pages()[0] || (await context.newPage());

  console.log('Navigating to MileagePlus Shopping portal...\n');
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('==========================================================');
  console.log(' Log in with your MileagePlus credentials and complete 2FA.');
  console.log(' When you see the shopping portal home page, press Enter');
  console.log(' in this terminal to save your session.');
  console.log('==========================================================\n');

  // Wait for user to press Enter
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question('Press Enter when logged in...', resolve));
  rl.close();

  // Verify authenticated state
  const currentUrl = page.url();
  const pageContent = await page.content();

  // Look for common authenticated indicators
  const loggedInIndicators = [
    'Hi,',
    'My account',
    'Sign out',
    'Sign Out',
    'Log out',
    'Log Out',
    'account-menu',
    'user-greeting',
    'logged-in',
    'my-account',
  ];

  const isAuthenticated = loggedInIndicators.some(
    (indicator) => pageContent.includes(indicator)
  );

  if (isAuthenticated) {
    console.log('\nAuthentication verified! Saving session...');
  } else if (currentUrl.includes('shopping.mileageplus.com')) {
    console.log('\nCould not verify login state, but you are on the portal.');
    console.log('Saving session anyway — the scraper will detect if it expires.');
  } else {
    console.log('\nWARNING: You may not be logged in. Current URL:', currentUrl);
    console.log('Saving session anyway — run portal-login again if scraping fails.');
  }

  // Close browser — persistent context auto-saves to disk
  await context.close();

  console.log('\nSession saved. The scraper can now reuse your authenticated session.');
  console.log('Run: npm run test-scrape  — to verify the session works.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
