import React, { useState, useEffect } from 'react';

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
          style={tab === 'purchases' ? styles.tabActive : styles.tab}
          onClick={() => setTab('purchases')}
        >
          Purchases
        </button>
        <button
          style={tab === 'scraper' ? styles.tabActive : styles.tab}
          onClick={() => setTab('scraper')}
        >
          Scraper
        </button>
      </div>
      {tab === 'score' ? <ScorePanel /> : tab === 'rank' ? <RankPanel /> : tab === 'purchases' ? <PurchasesPanel /> : <ScraperPanel />}
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
  const [logMsg, setLogMsg] = useState(null);

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

          {result.log_template && (
            <div style={{ marginTop: 16 }}>
              <button
                style={{ ...styles.button, backgroundColor: '#2e7d32', fontSize: 14 }}
                onClick={async () => {
                  setLogMsg(null);
                  try {
                    const resp = await fetch('/api/purchases', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(result.log_template),
                    });
                    if (resp.ok) {
                      setLogMsg('Purchase logged. Track it in the Purchases tab.');
                    } else {
                      const d = await resp.json();
                      setLogMsg(`Error: ${d.error || d.message}`);
                    }
                  } catch (err) {
                    setLogMsg(`Network error: ${err.message}`);
                  }
                }}
              >
                Log this purchase
              </button>
              {logMsg && <p style={{ fontSize: 13, marginTop: 6, color: logMsg.startsWith('Error') ? '#c62828' : '#2e7d32' }}>{logMsg}</p>}
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
  const [loggedRows, setLoggedRows] = useState({});

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
                  <th style={styles.th}>Log</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((r, i) => (
                  <tr key={i} style={{ backgroundColor: loggedRows[i] ? '#e8f5e9' : (i % 2 === 0 ? 'transparent' : '#fafafa'), transition: 'background-color 0.5s' }}>
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
                    <td style={styles.tdLabel}>
                      {r.log_template && (
                        <button
                          style={{ fontSize: 11, cursor: 'pointer', color: '#1565c0' }}
                          onClick={async () => {
                            try {
                              const resp = await fetch('/api/purchases', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(r.log_template),
                              });
                              if (resp.ok) {
                                setLoggedRows(prev => ({ ...prev, [i]: true }));
                                setTimeout(() => setLoggedRows(prev => { const n = { ...prev }; delete n[i]; return n; }), 2000);
                              }
                            } catch {}
                          }}
                        >Log</button>
                      )}
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
// Purchases Panel (Phase 7 — purchase log with posting tracker)
// ---------------------------------------------------------------------------

const STATUS_COLORS = { posted: '#2e7d32', pending: '#f9a825', overdue: '#c62828' };

function PurchasesPanel() {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [markingId, setMarkingId] = useState(null);
  const [markMiles, setMarkMiles] = useState('');
  const [logForm, setLogForm] = useState({
    retailer: '', path_type: 'direct', p_list: '', miles_expected: '',
    risk_class: 'confirmed', snapshot_id: '',
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedFields, setAdvancedFields] = useState({ p_portal: '', p_card: '', p_cash: '' });
  const [logMsg, setLogMsg] = useState(null);

  const fetchPurchases = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/purchases');
      const data = await resp.json();
      setPurchases(data.purchases || []);
    } catch (err) {
      setError(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPurchases();
    // Prefill snapshot_id from latest snapshot
    fetch('/api/scraper/status').then(r => r.json()).then(d => {
      if (d.snapshot_id) setLogForm(f => ({ ...f, snapshot_id: d.snapshot_id }));
    }).catch(() => {});
  }, []);

  const handleMarkPosted = async (id) => {
    const miles = parseInt(markMiles, 10);
    if (!miles || miles < 1) return;
    try {
      const resp = await fetch(`/api/purchases/${id}/posted`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ miles_posted: miles }),
      });
      if (resp.ok) { setMarkingId(null); setMarkMiles(''); fetchPurchases(); }
    } catch {}
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this purchase log entry?')) return;
    try {
      await fetch(`/api/purchases/${id}`, { method: 'DELETE' });
      fetchPurchases();
    } catch {}
  };

  const handleLogSubmit = async (e) => {
    e.preventDefault();
    setLogMsg(null);
    const body = {
      retailer: logForm.retailer,
      path_type: logForm.path_type,
      p_list: parseFloat(logForm.p_list),
      miles_expected: parseInt(logForm.miles_expected, 10),
      risk_class: logForm.risk_class,
      snapshot_id: logForm.snapshot_id,
    };
    if (showAdvanced && advancedFields.p_portal) body.p_portal = parseFloat(advancedFields.p_portal);
    if (showAdvanced && advancedFields.p_card) body.p_card = parseFloat(advancedFields.p_card);
    if (showAdvanced && advancedFields.p_cash) body.p_cash = parseFloat(advancedFields.p_cash);
    try {
      const resp = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        setLogMsg('Purchase logged successfully.');
        setLogForm(f => ({ ...f, retailer: '', p_list: '', miles_expected: '' }));
        setAdvancedFields({ p_portal: '', p_card: '', p_cash: '' });
        fetchPurchases();
      } else {
        const d = await resp.json();
        setLogMsg(`Error: ${d.error || d.message}`);
      }
    } catch (err) {
      setLogMsg(`Network error: ${err.message}`);
    }
  };

  // Summary stats
  const totalCount = purchases.length;
  const totalExpected = purchases.reduce((s, p) => s + (p.miles_expected || 0), 0);
  const totalPosted = purchases.reduce((s, p) => s + (p.miles_posted || 0), 0);
  const pendingMiles = purchases
    .filter(p => p.posting_status === 'pending' || p.posting_status === 'overdue')
    .reduce((s, p) => s + (p.miles_expected || 0), 0);
  const postingRate = totalExpected > 0 ? ((totalPosted / totalExpected) * 100).toFixed(1) : null;

  return (
    <div>
      <p style={styles.subtitle}>Purchase Log & Posting Tracker</p>

      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16, padding: '12px 16px', backgroundColor: '#e3f2fd', borderRadius: 4 }}>
        <div><strong>{totalCount}</strong> <span style={{ fontSize: 13, color: '#555' }}>Purchases</span></div>
        <div><strong>{totalExpected.toLocaleString()}</strong> <span style={{ fontSize: 13, color: '#555' }}>Expected Miles</span></div>
        <div><strong>{totalPosted.toLocaleString()}</strong> <span style={{ fontSize: 13, color: '#555' }}>Posted Miles</span></div>
        <div><strong>{pendingMiles.toLocaleString()}</strong> <span style={{ fontSize: 13, color: '#555' }}>Pending Miles</span></div>
      </div>
      {postingRate !== null && (
        <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
          {postingRate}% of expected miles have posted.
        </p>
      )}

      <button onClick={fetchPurchases} disabled={loading} style={{ ...styles.button, marginBottom: 16 }}>
        {loading ? 'Loading...' : 'Refresh'}
      </button>

      {error && <div style={styles.errorPanel}><strong>Error:</strong> {error}</div>}

      {/* Purchase history table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ ...styles.table, fontSize: 13 }}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Retailer</th>
              <th style={styles.th}>Path</th>
              <th style={styles.thRight}>Expected Miles</th>
              <th style={styles.thRight}>Posted Miles</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.purchase_id}>
                <td style={styles.tdLabel}>{new Date(p.purchased_at).toLocaleDateString()}</td>
                <td style={styles.tdLabel}>{p.retailer_name}</td>
                <td style={styles.tdLabel}>{p.path_type}</td>
                <td style={styles.tdValue}>{(p.miles_expected || 0).toLocaleString()}</td>
                <td style={styles.tdValue}>{p.miles_posted != null ? p.miles_posted.toLocaleString() : '-'}</td>
                <td style={{ ...styles.tdLabel, textAlign: 'center' }}>
                  <span style={{ ...styles.badge, backgroundColor: STATUS_COLORS[p.posting_status] || '#666', fontSize: 11, padding: '1px 8px' }}>
                    {p.posting_status}
                  </span>
                </td>
                <td style={{ ...styles.tdLabel, whiteSpace: 'nowrap' }}>
                  {p.posting_status !== 'posted' && (
                    markingId === p.purchase_id ? (
                      <span>
                        <input type="number" min="1" value={markMiles} onChange={e => setMarkMiles(e.target.value)}
                          style={{ width: 70, padding: 2, fontSize: 12 }} placeholder="miles" />
                        <button onClick={() => handleMarkPosted(p.purchase_id)}
                          style={{ fontSize: 11, marginLeft: 4, cursor: 'pointer' }}>Save</button>
                        <button onClick={() => { setMarkingId(null); setMarkMiles(''); }}
                          style={{ fontSize: 11, marginLeft: 2, cursor: 'pointer' }}>X</button>
                      </span>
                    ) : (
                      <button onClick={() => setMarkingId(p.purchase_id)}
                        style={{ fontSize: 11, cursor: 'pointer', marginRight: 4 }}>Mark Posted</button>
                    )
                  )}
                  <button onClick={() => handleDelete(p.purchase_id)}
                    style={{ fontSize: 11, cursor: 'pointer', color: '#c62828' }}>Delete</button>
                </td>
              </tr>
            ))}
            {purchases.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 12, textAlign: 'center', color: '#999' }}>No purchases logged yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Manual log form */}
      <div style={{ ...styles.resultPanel, marginTop: 24 }}>
        <h3 style={{ marginTop: 0 }}>Log a Purchase</h3>
        <form onSubmit={handleLogSubmit} style={styles.form}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={styles.field}>
              <label>Retailer</label>
              <input type="text" value={logForm.retailer} onChange={e => setLogForm({ ...logForm, retailer: e.target.value })}
                required placeholder="e.g. BestBuy" style={styles.input} />
            </div>
            <div style={styles.field}>
              <label>Path</label>
              <select value={logForm.path_type} onChange={e => setLogForm({ ...logForm, path_type: e.target.value })} style={styles.input}>
                <option value="direct">Direct</option>
                <option value="mpx">MPX</option>
                <option value="stacked">Stacked</option>
              </select>
            </div>
            <div style={styles.field}>
              <label>List Price ($)</label>
              <input type="number" step="0.01" min="0" value={logForm.p_list}
                onChange={e => setLogForm({ ...logForm, p_list: e.target.value })} required style={styles.input} />
            </div>
            <div style={styles.field}>
              <label>Expected Miles</label>
              <input type="number" min="1" value={logForm.miles_expected}
                onChange={e => setLogForm({ ...logForm, miles_expected: e.target.value })} required style={styles.input} />
            </div>
            <div style={styles.field}>
              <label>Risk Class</label>
              <select value={logForm.risk_class} onChange={e => setLogForm({ ...logForm, risk_class: e.target.value })} style={styles.input}>
                <option value="confirmed">confirmed</option>
                <option value="uncertain">uncertain</option>
                <option value="excluded">excluded</option>
              </select>
            </div>
            <div style={styles.field}>
              <label>Snapshot ID</label>
              <input type="text" value={logForm.snapshot_id} onChange={e => setLogForm({ ...logForm, snapshot_id: e.target.value })}
                required style={{ ...styles.input, fontSize: 11, width: 200 }} />
            </div>
          </div>
          <div>
            <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}
              style={{ background: 'none', border: 'none', color: '#1565c0', cursor: 'pointer', fontSize: 12, padding: 0 }}>
              {showAdvanced ? 'Hide' : 'Show'} Advanced (spend vector)
            </button>
            {showAdvanced && (
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <div style={styles.field}>
                  <label style={{ fontSize: 12 }}>p_portal</label>
                  <input type="number" step="0.01" value={advancedFields.p_portal}
                    onChange={e => setAdvancedFields({ ...advancedFields, p_portal: e.target.value })} style={styles.input} />
                </div>
                <div style={styles.field}>
                  <label style={{ fontSize: 12 }}>p_card</label>
                  <input type="number" step="0.01" value={advancedFields.p_card}
                    onChange={e => setAdvancedFields({ ...advancedFields, p_card: e.target.value })} style={styles.input} />
                </div>
                <div style={styles.field}>
                  <label style={{ fontSize: 12 }}>p_cash</label>
                  <input type="number" step="0.01" value={advancedFields.p_cash}
                    onChange={e => setAdvancedFields({ ...advancedFields, p_cash: e.target.value })} style={styles.input} />
                </div>
              </div>
            )}
          </div>
          <button type="submit" style={styles.button}>Log Purchase</button>
        </form>
        {logMsg && <p style={{ marginTop: 8, fontSize: 13, color: logMsg.startsWith('Error') ? '#c62828' : '#2e7d32' }}>{logMsg}</p>}
      </div>
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
