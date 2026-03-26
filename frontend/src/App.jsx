// Phase 12: Search-first frontend redesign.
// Tab-based navigation removed. Hash routing replaces it:
//   #/             → SearchBar (home)
//   #/search?q=... → SearchResults
//   #/purchases    → PurchasesPage
//   #/settings     → SettingsPage
//
// BasketTab.jsx and SweepPanel.jsx remain in the repo but are not imported here.

import React, { useState, useEffect } from 'react';
import SearchBar from './SearchBar';
import SearchResults from './SearchResults';
import PurchasesPage from './PurchasesPage';
import SettingsPage from './SettingsPage';

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const params = new URLSearchParams(queryPart || '');
  return {
    path: pathPart || '/',
    query: decodeURIComponent(params.get('q') || ''),
  };
}

export default function App() {
  const [page, setPage] = useState(parseHash);

  useEffect(() => {
    const handler = () => setPage(parseHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const navigate = (path) => {
    window.location.hash = path;
  };

  if (page.path === '/search') {
    return <SearchResults query={page.query} onNavigate={navigate} />;
  }
  if (page.path === '/purchases') {
    return <PurchasesPage onNavigate={navigate} />;
  }
  if (page.path === '/settings') {
    return <SettingsPage onNavigate={navigate} />;
  }
  return <SearchBar onNavigate={navigate} />;
}
