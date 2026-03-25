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

function App() {
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
    <div style={styles.container}>
      <h1 style={styles.title}>MileagePlus Deal Finder</h1>
      <p style={styles.subtitle}>Phase 2 — Single-Item Scoring (Direct Path)</p>

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
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 600,
    margin: '0 auto',
    padding: 20,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  title: { marginBottom: 4 },
  subtitle: { color: '#666', marginTop: 0 },
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
