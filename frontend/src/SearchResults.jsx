import React, { useState, useEffect, useCallback, useRef } from 'react';

const CARD_TIERS = [
  { value: 'none', label: 'No Chase United card' },
  { value: 'one_x', label: 'United card 1x' },
  { value: 'one_five_x', label: 'United Club 1.5x' },
  { value: 'two_x', label: 'MileagePlus X 2x' },
];

const RISK_COLORS = {
  confirmed: '#2e7d32',
  uncertain: '#f9a825',
  excluded: '#c62828',
};

// Card tier persists for the browser session (sessionStorage).
// Falls back to user's saved default (localStorage), then 'none'.
function getInitialCardTier() {
  return (
    sessionStorage.getItem('cardTier') ||
    localStorage.getItem('defaultCardTier') ||
    'none'
  );
}

export default function SearchResults({ query: initialQuery, onNavigate }) {
  const [query, setQuery] = useState(initialQuery || '');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [cardTier, setCardTier] = useState(getInitialCardTier);
  const [excludeRetailers, setExcludeRetailers] = useState([]);
  const [priceOverride, setPriceOverride] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchData, setSearchData] = useState(null);
  const [loggedKeys, setLoggedKeys] = useState({});
  const pollIntervalRef = useRef(null);

  const runSearch = useCallback(async (q, tier, excludes, priceOvr) => {
    if (!q || !q.trim()) return;
    // Stop polling for any previous search before starting a new one.
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setLoading(true);
    setError(null);
    try {
      const body = {
        query: q.trim(),
        card_tier: tier,
        exclude_retailers: excludes,
        price_override: priceOvr ? parseFloat(priceOvr) : null,
      };
      const resp = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.message || data.error || `HTTP ${resp.status}`);
      } else {
        setSearchData(data);
        setShowAll(false);
      }
    } catch (err) {
      setError(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Run search once on mount with the initial query from the URL.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (initialQuery) {
      runSearch(initialQuery, getInitialCardTier(), [], '');
    }
  }, []);

  // Progressive loading: poll /api/search/status while refreshing is active (Phase 13).
  // Effect re-runs when search_id or refreshing changes; cleanup stops the interval.
  useEffect(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (!searchData?.refreshing || !searchData?.search_id) return;

    const searchId = searchData.search_id;

    const poll = async () => {
      try {
        const resp = await fetch(`/api/search/status/${searchId}`);
        if (!resp.ok) return;
        const data = await resp.json();
        setSearchData((prev) => {
          // Guard: only apply if this is still the same search.
          if (!prev || prev.search_id !== searchId) return prev;
          return {
            ...prev,
            results: data.results,
            stale_retailers: data.stale_retailers,
            refreshing: data.refreshing,
            result_count: data.result_count,
            top_pick_index: data.top_pick_index,
          };
        });
      } catch {
        // Ignore network errors during polling; retry on next tick.
      }
    };

    pollIntervalRef.current = setInterval(poll, 3000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchData?.refreshing, searchData?.search_id]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    window.location.hash = `/search?q=${encodeURIComponent(q)}`;
    runSearch(q, cardTier, excludeRetailers, priceOverride);
  };

  const handleCardTierChange = (e) => {
    const tier = e.target.value;
    setCardTier(tier);
    sessionStorage.setItem('cardTier', tier);
    runSearch(query, tier, excludeRetailers, priceOverride);
  };

  const handleExcludeToggle = (retailer) => {
    const newExcludes = excludeRetailers.includes(retailer)
      ? excludeRetailers.filter((r) => r !== retailer)
      : [...excludeRetailers, retailer];
    setExcludeRetailers(newExcludes);
    runSearch(query, cardTier, newExcludes, priceOverride);
  };

  const handlePriceBlur = () => {
    if (priceOverride) {
      runSearch(query, cardTier, excludeRetailers, priceOverride);
    }
  };

  const handleLogPurchase = async (result) => {
    const key = result.retailer + '|' + result.path;
    try {
      const body = {
        retailer: result.retailer,
        path_type: result.path,
        p_list: searchData?.interpreted?.estimated_price || 0,
        miles_expected: result.total_miles,
        risk_class: result.risk_class,
        snapshot_id: searchData?.snapshot_id || '',
      };
      const resp = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        setLoggedKeys((prev) => ({ ...prev, [key]: true }));
        setTimeout(() => {
          setLoggedKeys((prev) => {
            const n = { ...prev };
            delete n[key];
            return n;
          });
        }, 3000);
      }
    } catch {
      // Silent fail — log purchase is a secondary action
    }
  };

  const results = searchData?.results || [];
  const allRetailers = [...new Set(results.map((r) => r.retailer))];
  const visibleResults = showAll ? results : results.slice(0, 5);
  const hiddenCount = results.length - 5;

  return (
    <div className="results-page">
      {/* Sticky top nav */}
      <nav className="results-nav">
        <button className="nav-logo-btn" onClick={() => onNavigate('/')} aria-label="Home">
          <span className="nav-logo-text">MP Deal Finder</span>
        </button>
        <div className="nav-icons">
          <button
            className="nav-icon-btn"
            onClick={() => onNavigate('/purchases')}
            title="Purchases"
            aria-label="Purchases"
          >
            &#9776;
          </button>
          <button
            className="nav-icon-btn"
            onClick={() => onNavigate('/settings')}
            title="Settings"
            aria-label="Settings"
          >
            &#9881;
          </button>
        </div>
      </nav>

      {/* Search bar row */}
      <div className="results-search-bar">
        <form onSubmit={handleSearchSubmit} className="results-search-form">
          <input
            type="text"
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What are you looking to buy?"
            aria-label="Search query"
          />
          <button type="submit" className="search-btn" disabled={loading}>
            {loading ? '…' : 'Search'}
          </button>
        </form>
        <button
          className={`filters-toggle${filtersOpen ? ' open' : ''}`}
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
        >
          Filters {filtersOpen ? '▲' : '▼'}
        </button>
      </div>

      {/* Collapsible filters panel */}
      {filtersOpen && (
        <div className="filters-panel">
          <div className="filter-group">
            <span className="filter-label">Card tier</span>
            <select
              className="filter-select"
              value={cardTier}
              onChange={handleCardTierChange}
              aria-label="Card tier"
            >
              {CARD_TIERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {allRetailers.length > 0 && (
            <div className="filter-group">
              <span className="filter-label">Exclude stores</span>
              <div className="filter-checkboxes">
                {allRetailers.map((r) => (
                  <label key={r} className="filter-checkbox-label">
                    <input
                      type="checkbox"
                      checked={excludeRetailers.includes(r)}
                      onChange={() => handleExcludeToggle(r)}
                    />
                    {r}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="filter-group">
            <span className="filter-label">Price override ($)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              className="filter-input"
              value={priceOverride}
              onChange={(e) => setPriceOverride(e.target.value)}
              onBlur={handlePriceBlur}
              placeholder="Use AI estimate"
              aria-label="Price override"
            />
          </div>
        </div>
      )}

      {/* Status: refreshing stale retailers (Phase 13 progressive loading) */}
      {searchData?.refreshing && (
        <div className="refreshing-indicator">
          <span className="refreshing-spinner" aria-hidden="true" />
          Refreshing {searchData.stale_retailers?.length ?? 0} store
          {(searchData.stale_retailers?.length ?? 0) !== 1 ? 's' : ''}…
        </div>
      )}

      {/* Errors */}
      {error && (
        <div className="error-panel" role="alert">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Results */}
      {!error && (
        <div className="results-list">
          {loading && !searchData && (
            <p className="status-indicator">Searching…</p>
          )}

          {searchData && (
            <>
              {searchData.interpreted && (
                <p className="results-meta">
                  {results.length} result{results.length !== 1 ? 's' : ''} for &ldquo;
                  {searchData.interpreted.category}&rdquo;
                  {searchData.interpreted.estimated_price > 0 &&
                    ` · Est. $${searchData.interpreted.estimated_price.toLocaleString()}`}
                </p>
              )}

              {results.length === 0 && !loading && (
                <div className="no-results">
                  No results found. Try a different search or check that the engine is running.
                </div>
              )}

              {visibleResults.map((result) => (
                <ResultCard
                  key={`${result.retailer}|${result.path}`}
                  result={result}
                  logged={loggedKeys[result.retailer + '|' + result.path]}
                  onLogPurchase={handleLogPurchase}
                />
              ))}

              {hiddenCount > 0 && !showAll && (
                <button className="show-all-btn" onClick={() => setShowAll(true)}>
                  Show all {results.length} results
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ResultCard({ result, logged, onLogPurchase }) {
  const isTopPick = !!result.top_pick;

  const breakdownParts = [
    result.breakdown.portal > 0 ? `${result.breakdown.portal.toLocaleString()} portal` : null,
    result.breakdown.card > 0 ? `${result.breakdown.card.toLocaleString()} card` : null,
    result.breakdown.bonus > 0 ? `${result.breakdown.bonus.toLocaleString()} bonus` : null,
    result.breakdown.mpx > 0 ? `${result.breakdown.mpx.toLocaleString()} MPX` : null,
  ].filter(Boolean);

  return (
    <div className={`result-card${isTopPick ? ' top-pick' : ''}`}>
      {isTopPick && <div className="top-pick-badge">Top Pick</div>}

      <div className="card-header">
        <div className="card-retailer">{result.retailer}</div>
        <div className="card-miles">
          {result.total_miles.toLocaleString()}
          <span className="miles-label"> miles</span>
        </div>
      </div>

      <div className="card-path">{result.path_label}</div>

      {breakdownParts.length > 0 && (
        <div className="card-breakdown">{breakdownParts.join(' + ')}</div>
      )}

      <div className="card-footer">
        {result.risk_class !== 'excluded' && (
          <span
            className="risk-badge"
            style={{ backgroundColor: RISK_COLORS[result.risk_class] || '#666' }}
          >
            {result.risk_class.charAt(0).toUpperCase() + result.risk_class.slice(1)}
          </span>
        )}

        <div className="card-actions">
          {result.portal_url ? (
            <a
              href={result.portal_url}
              target="_blank"
              rel="noopener noreferrer"
              className="shop-btn"
            >
              Shop at {result.retailer}
            </a>
          ) : (
            <span className="shop-btn-disabled">No portal link yet</span>
          )}
          <button
            className={`log-btn${logged ? ' logged' : ''}`}
            onClick={() => onLogPurchase(result)}
            disabled={!!logged}
            aria-label={`Log purchase at ${result.retailer}`}
          >
            {logged ? 'Logged ✓' : 'Log purchase'}
          </button>
        </div>
      </div>
    </div>
  );
}
