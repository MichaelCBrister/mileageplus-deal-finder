import React, { useState } from 'react';

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

const RISK_OPTIONS = ['confirmed', 'uncertain', 'excluded'];

function App() {
  const [tab, setTab] = useState('score');

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>MileagePlus Deal Finder</h1>
      <div style={styles.tabBar}>
        <button
          style={tab === 'score' ? styles.tabActive : styles.tab}
          onClick={() => setTab('score')}
        >
          Score
        </button>
        <button
          style={tab === 'rank' ? styles.tabActive : styles.tab}
          onClick={() => setTab('rank')}
        >
          Rank
        </button>
        <button
          style={tab === 'scraper' ? styles.tabActive : styles.tab}
          onClick={() => setTab('scraper')}
        >
          Scraper
        </button>
      </div>
      {tab === 'score' ? <ScorePanel /> : tab === 'rank' ? <RankPanel /> : <ScraperPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score Panel (Phase 2/3 — unchanged behavior)
// ---------------------------------------------------------------------------

function ScorePanel() {
  const [form, setForm] = useState({
    p_list: '',
    tax_rate: '0',
    category: '',
    card_tier: 'none',
    retailer: '',
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    const body = {
      retailer: form.retailer,
      p_list: parseFloat(form.p_list),
      tax_rate: parseFloat(form.tax_rate) || 0,
      category: form.category,
      card_tier: form.card_tier,
      path: 'direct',
    };

    try {
      const resp = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || data.message || `HTTP ${resp.status}`);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <p style={styles.subtitle}>Single-Item Scoring (Direct Path)</p>

      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.field}>
          <label htmlFor="retailer">Retailer name</label>
          <input
            id="retailer"
            name="retailer"
            type="text"
            value={form.retailer}
            onChange={handleChange}
            required
            placeholder="e.g. BestBuy"
            style={styles.input}
          />
        </div>

        <div style={styles.field}>
          <label htmlFor="p_list">List price ($)</label>
          <input
            id="p_list"
            name="p_list"
            type="number"
            step="0.01"
            min="0"
            value={form.p_list}
            onChange={handleChange}
            required
            placeholder="200.00"
            style={styles.input}
          />
        </div>

        <div style={styles.field}>
          <label htmlFor="tax_rate">Local tax rate (%)</label>
          <input
            id="tax_rate"
            name="tax_rate"
            type="number"
            step="0.01"
            min="0"
            max="100"
            value={form.tax_rate}
            onChange={handleChange}
            placeholder="0"
            style={styles.input}
          />
        </div>

        <div style={styles.field}>
          <label htmlFor="category">Product category</label>
          <input
            id="category"
            name="category"
            type="text"
            value={form.category}
            onChange={handleChange}
            required
            placeholder="e.g. Electronics"
            style={styles.input}
          />
        </div>

        <div style={styles.field}>
          <label htmlFor="card_tier">Chase United card tier</label>
          <select
            id="card_tier"
            name="card_tier"
            value={form.card_tier}
            onChange={handleChange}
            style={styles.input}
          >
            {CARD_TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" disabled={loading} style={styles.button}>
          {loading ? 'Scoring...' : 'Score'}
        </button>
      </form>

      {error && (
        <div style={styles.errorPanel}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div style={styles.resultPanel}>
          <h2 style={styles.resultTitle}>Score Result</h2>

          {result.snapshot_completed_at && (() => {
            const snapshotDate = new Date(result.snapshot_completed_at);
            const hoursAgo = (Date.now() - snapshotDate.getTime()) / (1000 * 3600);
            const isStale = hoursAgo > 24;
            const label = isStale ? 'Warning: rates may be stale' : 'Rates as of';
            return (
              <p style={{ color: isStale ? '#c62828' : '#666', fontSize: 13, margin: '0 0 12px' }}>
                {label}: {snapshotDate.toLocaleString()}
              </p>
            );
          })()}

          <table style={styles.table}>
            <tbody>
              <tr>
                <td style={styles.tdLabel}>Total miles</td>
                <td style={styles.tdValue}>{result.total_miles.toLocaleString()}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>Portal miles</td>
                <td style={styles.tdValue}>{result.portal_miles.toLocaleString()}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>Card miles</td>
                <td style={styles.tdValue}>{result.card_miles.toLocaleString()}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>Bonus miles</td>
                <td style={styles.tdValue}>{result.bonus_miles.toLocaleString()}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>Risk class</td>
                <td style={styles.tdValue}>
                  <span
                    style={{
                      ...styles.badge,
                      backgroundColor: RISK_COLORS[result.risk_class] || '#666',
                    }}
                  >
                    {result.risk_class}
                  </span>
                </td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>Path</td>
                <td style={styles.tdValue}>{result.path}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>MPD (miles/$)</td>
                <td style={styles.tdValue}>{result.mpd.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>

          <h3 style={styles.spendTitle}>Spend Vector</h3>
          <table style={styles.table}>
            <tbody>
              <tr>
                <td style={styles.tdLabel}>p_list</td>
                <td style={styles.tdValue}>${result.spend.p_list.toFixed(2)}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>p_portal</td>
                <td style={styles.tdValue}>${result.spend.p_portal.toFixed(2)}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>p_card</td>
                <td style={styles.tdValue}>${result.spend.p_card.toFixed(2)}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>p_cash</td>
                <td style={styles.tdValue}>${result.spend.p_cash.toFixed(2)}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>v_residual</td>
                <td style={styles.tdValue}>${result.spend.v_residual.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>

          {result.process_constraints && result.process_constraints.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ marginTop: 0, marginBottom: 8 }}>Retailer Warnings</h3>
              {result.process_constraints.map((c, i) => {
                const severityColor = c.severity === 'critical' ? '#c62828'
                  : c.severity === 'warning' ? '#f57f17'
                  : '#757575';
                return (
                  <div key={i} style={{
                    padding: '8px 12px',
                    marginBottom: 6,
                    borderLeft: `4px solid ${severityColor}`,
                    backgroundColor: '#fafafa',
                    fontSize: 13,
                  }}>
                    <span style={{ fontWeight: 'bold', color: severityColor, textTransform: 'uppercase', fontSize: 11 }}>
                      {c.severity}
                    </span>
                    {' '}{c.description}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rank Panel (Phase 4 — multi-path ranking table)
// ---------------------------------------------------------------------------

function RankPanel() {
  const [form, setForm] = useState({
    p_list: '',
    tax_rate: '0',
    category: '',
    card_tier: 'none',
  });
  const [riskFilter, setRiskFilter] = useState({
    confirmed: true,
    uncertain: true,
    excluded: true,
  });
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleRiskToggle = (risk) => {
    setRiskFilter({ ...riskFilter, [risk]: !riskFilter[risk] });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setData(null);

    const selectedRisks = RISK_OPTIONS.filter((r) => riskFilter[r]);

    const body = {
      p_list: parseFloat(form.p_list),
      tax_rate: parseFloat(form.tax_rate) || 0,
      category: form.category,
      card_tier: form.card_tier,
    };
    if (selectedRisks.length < 3) {
      body.risk_filter = selectedRisks;
    }

    try {
      const resp = await fetch('/api/rank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) {
        setError(result.error || result.message || `HTTP ${resp.status}`);
      } else {
        setData(result);
      }
    } catch (err) {
      setError(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const noteForRow = (r) => {
    if (r.path === 'stacked' && r.gc_source && r.destination) {
      return `${r.gc_source} gift card \u2192 ${r.destination} portal`;
    }
    return '';
  };

  return (
    <div>
      <p style={styles.subtitle}>Multi-Path Ranking (All Retailers)</p>

      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.field}>
          <label htmlFor="rank_p_list">List price ($)</label>
          <input
            id="rank_p_list"
            name="p_list"
            type="number"
            step="0.01"
            min="0"
            value={form.p_list}
            onChange={handleChange}
            required
            placeholder="100.00"
            style={styles.input}
          />
        </div>

        <div style={styles.field}>
          <label htmlFor="rank_tax_rate">Local tax rate (%)</label>
          <input
            id="rank_tax_rate"
            name="tax_rate"
            type="number"
            step="0.01"
            min="0"
            max="100"
            value={form.tax_rate}
            onChange={handleChange}
            placeholder="0"
            style={styles.input}
          />
        </div>

        <div style={styles.field}>
          <label htmlFor="rank_category">Product category</label>
          <input
            id="rank_category"
            name="category"
            type="text"
            value={form.category}
            onChange={handleChange}
            required
            placeholder="e.g. Electronics"
            style={styles.input}
          />
        </div>

        <div style={styles.field}>
          <label htmlFor="rank_card_tier">Chase United card tier</label>
          <select
            id="rank_card_tier"
            name="card_tier"
            value={form.card_tier}
            onChange={handleChange}
            style={styles.input}
          >
            {CARD_TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div style={styles.field}>
          <label>Risk filter</label>
          <div style={{ display: 'flex', gap: 12 }}>
            {RISK_OPTIONS.map((r) => (
              <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={riskFilter[r]}
                  onChange={() => handleRiskToggle(r)}
                />
                <span style={{
                  ...styles.badge,
                  backgroundColor: RISK_COLORS[r],
                  fontSize: 11,
                  padding: '1px 8px',
                }}>
                  {r}
                </span>
              </label>
            ))}
          </div>
        </div>

        <button type="submit" disabled={loading} style={styles.button}>
          {loading ? 'Ranking...' : 'Rank All Paths'}
        </button>
      </form>

      {error && (
        <div style={styles.errorPanel}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {data && (
        <div style={styles.resultPanel}>
          <h2 style={styles.resultTitle}>Ranking Results</h2>

          {data.snapshot_completed_at && (() => {
            const snapshotDate = new Date(data.snapshot_completed_at);
            const hoursAgo = (Date.now() - snapshotDate.getTime()) / (1000 * 3600);
            const isStale = hoursAgo > 24;
            const label = isStale ? 'Warning: rates may be stale' : 'Rates as of';
            return (
              <p style={{ color: isStale ? '#c62828' : '#666', fontSize: 13, margin: '0 0 8px' }}>
                {label}: {snapshotDate.toLocaleString()}
              </p>
            );
          })()}

          <p style={{ fontSize: 13, color: '#666', margin: '0 0 12px' }}>
            {data.result_count} results from {data.retailer_count} retailers
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ ...styles.table, fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={styles.th}>Retailer</th>
                  <th style={styles.th}>Path</th>
                  <th style={styles.thRight}>Total Miles</th>
                  <th style={styles.thRight}>Portal</th>
                  <th style={styles.thRight}>Card</th>
                  <th style={styles.thRight}>Bonus</th>
                  <th style={styles.thRight}>MPX</th>
                  <th style={styles.th}>Risk Class</th>
                  <th style={styles.th}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((r, i) => (
                  <tr key={i} style={i % 2 === 0 ? {} : { backgroundColor: '#fafafa' }}>
                    <td style={styles.tdLabel}>{r.retailer_name}</td>
                    <td style={styles.tdLabel}>{r.path}</td>
                    <td style={styles.tdValue}>{r.total_miles.toLocaleString()}</td>
                    <td style={styles.tdValue}>{r.portal_miles.toLocaleString()}</td>
                    <td style={styles.tdValue}>{r.card_miles.toLocaleString()}</td>
                    <td style={styles.tdValue}>{r.bonus_miles.toLocaleString()}</td>
                    <td style={styles.tdValue}>{r.mpx_miles.toLocaleString()}</td>
                    <td style={{ ...styles.tdLabel, textAlign: 'center' }}>
                      <span style={{
                        ...styles.badge,
                        backgroundColor: RISK_COLORS[r.risk_class] || '#666',
                        fontSize: 11,
                        padding: '1px 8px',
                      }}>
                        {r.risk_class}
                      </span>
                    </td>
                    <td style={{ ...styles.tdLabel, fontSize: 12, color: '#666' }}>
                      {noteForRow(r)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scraper Panel (Phase 6 — scrape status and launcher guide)
// ---------------------------------------------------------------------------

function ScraperPanel() {
  const [snapshot, setSnapshot] = useState(null);
  const [canScrape, setCanScrape] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusResp, checkResp] = await Promise.all([
        fetch('/api/scraper/status'),
        fetch('/api/scraper/run-check'),
      ]);
      const statusData = await statusResp.json();
      const checkData = await checkResp.json();
      setSnapshot(statusData.snapshot || statusData);
      setCanScrape(checkData);
    } catch (err) {
      setError(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const statusColor = (s) => {
    if (s === 'complete') return '#2e7d32';
    if (s === 'partial') return '#f9a825';
    if (s === 'failed') return '#c62828';
    return '#666';
  };

  return (
    <div>
      <p style={styles.subtitle}>Scraper Status & Launcher</p>

      <button onClick={fetchStatus} disabled={loading} style={styles.button}>
        {loading ? 'Checking...' : 'Check scrape status'}
      </button>

      {error && (
        <div style={styles.errorPanel}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {snapshot && snapshot.snapshot_id && (
        <div style={{ ...styles.resultPanel, marginTop: 16 }}>
          <h2 style={styles.resultTitle}>Latest Snapshot</h2>
          <table style={styles.table}>
            <tbody>
              <tr>
                <td style={styles.tdLabel}>Snapshot ID</td>
                <td style={styles.tdValue}>{snapshot.snapshot_id.slice(0, 8)}...</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>Status</td>
                <td style={styles.tdValue}>
                  <span style={{
                    ...styles.badge,
                    backgroundColor: statusColor(snapshot.status),
                  }}>
                    {snapshot.status}
                  </span>
                </td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>Completed</td>
                <td style={styles.tdValue}>
                  {snapshot.completed_at ? new Date(snapshot.completed_at).toLocaleString() : 'In progress'}
                </td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>Retailers</td>
                <td style={styles.tdValue}>{snapshot.retailer_count}</td>
              </tr>
              <tr>
                <td style={styles.tdLabel}>Errors</td>
                <td style={styles.tdValue}>{snapshot.error_count}</td>
              </tr>
              {snapshot.age_hours != null && (
                <tr>
                  <td style={styles.tdLabel}>Age</td>
                  <td style={{ ...styles.tdValue, color: snapshot.age_hours > 24 ? '#c62828' : 'inherit' }}>
                    {snapshot.age_hours.toFixed(1)} hours
                    {snapshot.age_hours > 24 && ' (stale — consider re-scraping)'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {snapshot && !snapshot.snapshot_id && (
        <div style={{ ...styles.resultPanel, marginTop: 16 }}>
          <p>No snapshots found. Run the scraper to create one.</p>
        </div>
      )}

      <div style={{ ...styles.resultPanel, marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Run Scraper</h3>
        {canScrape && !canScrape.can_scrape ? (
          <p style={{ color: '#f57f17' }}>
            Cannot scrape: {canScrape.reason === 'already_scraped_today'
              ? 'Already scraped today. Wait until tomorrow or delete today\'s snapshot.'
              : canScrape.reason}
          </p>
        ) : (
          <div>
            <p>To run the scraper, open a terminal in the project root and run:</p>
            <pre style={{
              backgroundColor: '#263238',
              color: '#e0e0e0',
              padding: 12,
              borderRadius: 4,
              fontSize: 13,
              overflowX: 'auto',
            }}>
{`cd scraper && \\
MILEAGEPLUS_USERNAME=<your_username> \\
MILEAGEPLUS_PASSWORD=<your_password> \\
npm run scrape`}
            </pre>
            <p style={{ fontSize: 13, color: '#666' }}>
              Or without credentials (mock mode): <code>cd scraper && npm run scrape</code>
            </p>
          </div>
        )}
        <p style={{ fontSize: 13, color: '#666', marginTop: 12 }}>
          After running the scraper, click Refresh on the Score or Rank tab to see updated rates.
        </p>
      </div>
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 900,
    margin: '0 auto',
    padding: 20,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  title: { marginBottom: 4 },
  subtitle: { color: '#666', marginTop: 0 },
  tabBar: {
    display: 'flex',
    gap: 0,
    marginBottom: 20,
    borderBottom: '2px solid #ddd',
  },
  tab: {
    padding: '8px 20px',
    fontSize: 14,
    fontWeight: 'bold',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: '#666',
    borderBottom: '2px solid transparent',
    marginBottom: -2,
  },
  tabActive: {
    padding: '8px 20px',
    fontSize: 14,
    fontWeight: 'bold',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: '#1565c0',
    borderBottom: '2px solid #1565c0',
    marginBottom: -2,
  },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  input: { padding: 8, fontSize: 14, border: '1px solid #ccc', borderRadius: 4 },
  button: {
    padding: '10px 20px',
    fontSize: 16,
    backgroundColor: '#1565c0',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    marginTop: 8,
  },
  errorPanel: {
    marginTop: 20,
    padding: 16,
    backgroundColor: '#ffebee',
    border: '1px solid #c62828',
    borderRadius: 4,
    color: '#c62828',
  },
  resultPanel: {
    marginTop: 20,
    padding: 16,
    backgroundColor: '#f5f5f5',
    border: '1px solid #ddd',
    borderRadius: 4,
  },
  resultTitle: { marginTop: 0 },
  spendTitle: { marginTop: 16 },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { padding: '6px 8px', fontWeight: 'bold', borderBottom: '2px solid #bbb', textAlign: 'left', whiteSpace: 'nowrap' },
  thRight: { padding: '6px 8px', fontWeight: 'bold', borderBottom: '2px solid #bbb', textAlign: 'right', whiteSpace: 'nowrap' },
  tdLabel: { padding: '6px 8px', fontWeight: 'bold', borderBottom: '1px solid #ddd' },
  tdValue: { padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #ddd' },
  badge: {
    display: 'inline-block',
    padding: '2px 10px',
    borderRadius: 12,
    color: '#fff',
    fontSize: 13,
    fontWeight: 'bold',
  },
};

export default App;
