import React, { useState, useEffect } from 'react';

const CARD_TIERS = [
  { value: 'none', label: 'No Chase United card' },
  { value: 'one_x', label: 'United card 1x' },
  { value: 'one_five_x', label: 'United Club 1.5x' },
  { value: 'two_x', label: 'MileagePlus X 2x' },
];

export default function SettingsPage({ onNavigate }) {
  const [defaultCardTier, setDefaultCardTier] = useState(
    () => localStorage.getItem('defaultCardTier') || 'none'
  );
  const [taxRate, setTaxRate] = useState(
    () => localStorage.getItem('taxRate') || '8'
  );
  const [freshnessHours, setFreshnessHours] = useState(
    () => localStorage.getItem('freshnessHours') || '24'
  );
  const [apiKeyStatus, setApiKeyStatus] = useState('loading');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => setApiKeyStatus(d.api_key_configured ? 'configured' : 'missing'))
      .catch(() => setApiKeyStatus('unknown'));
  }, []);

  const handleSave = () => {
    localStorage.setItem('defaultCardTier', defaultCardTier);
    localStorage.setItem('taxRate', taxRate);
    localStorage.setItem('freshnessHours', freshnessHours);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const apiDotColor =
    apiKeyStatus === 'configured'
      ? '#2e7d32'
      : apiKeyStatus === 'missing'
      ? '#c62828'
      : '#999';

  const apiLabel =
    apiKeyStatus === 'configured'
      ? 'Configured'
      : apiKeyStatus === 'missing'
      ? 'Not configured — set ANTHROPIC_API_KEY in bridge/.env'
      : 'Unknown';

  return (
    <div className="page-wrapper">
      <header className="page-header">
        <button className="back-btn" onClick={() => onNavigate('/')} aria-label="Back to home">
          &#8592;
        </button>
        <h1 className="page-title">Settings</h1>
        <div className="page-header-nav">
          <button
            className="nav-icon-btn"
            onClick={() => onNavigate('/purchases')}
            title="Purchases"
            aria-label="Purchases"
          >
            &#9776;
          </button>
          <button
            className="nav-icon-btn active"
            aria-label="Settings"
            aria-current="page"
            title="Settings"
            disabled
          >
            &#9881;
          </button>
        </div>
      </header>

      <div className="page-content">
        {/* Search defaults */}
        <div className="settings-section">
          <h3>Search Defaults</h3>

          <div className="settings-row">
            <label className="settings-label" htmlFor="defaultCardTier">
              Default card tier
            </label>
            <select
              id="defaultCardTier"
              className="settings-select"
              value={defaultCardTier}
              onChange={(e) => setDefaultCardTier(e.target.value)}
            >
              {CARD_TIERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="settings-hint">
              Used as the starting card tier for each new browser session. Can be
              overridden in the search filters without changing this default.
            </span>
          </div>

          <div className="settings-row">
            <label className="settings-label" htmlFor="taxRate">
              Local tax rate (%)
            </label>
            <input
              id="taxRate"
              type="number"
              step="0.1"
              min="0"
              max="20"
              className="settings-input"
              value={taxRate}
              onChange={(e) => setTaxRate(e.target.value)}
            />
            <span className="settings-hint">
              Used to compute p_card (charged amount) from the list price. Default is
              8% (approximate Georgia rate).
            </span>
          </div>
        </div>

        {/* Data freshness */}
        <div className="settings-section">
          <h3>Data Freshness</h3>

          <div className="settings-row">
            <label className="settings-label" htmlFor="freshnessHours">
              Freshness threshold (hours)
            </label>
            <input
              id="freshnessHours"
              type="number"
              step="1"
              min="1"
              max="168"
              className="settings-input"
              value={freshnessHours}
              onChange={(e) => setFreshnessHours(e.target.value)}
            />
            <span className="settings-hint">
              Retailers with data older than this are marked stale and will be
              refreshed in the background on the next search. Default: 24 hours.
            </span>
          </div>
        </div>

        {/* System status */}
        <div className="settings-section">
          <h3>System Status</h3>

          <div className="settings-row">
            <span className="settings-label">Anthropic API key</span>
            <div className="api-status">
              <span
                className="api-status-dot"
                style={{ backgroundColor: apiDotColor }}
                aria-hidden="true"
              />
              <span>{apiLabel}</span>
            </div>
            <span className="settings-hint">
              Required for query interpretation and T&amp;C parsing. Set
              ANTHROPIC_API_KEY in bridge/.env and restart the bridge.
            </span>
          </div>
        </div>

        {/* Save button */}
        <button
          className="form-submit-btn"
          onClick={handleSave}
          style={{ marginTop: 8 }}
        >
          {saved ? 'Saved ✓' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
