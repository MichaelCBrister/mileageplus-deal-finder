import React, { useState, useEffect } from 'react';

const STATUS_COLORS = {
  posted: '#2e7d32',
  pending: '#f9a825',
  overdue: '#c62828',
};

export default function PurchasesPage({ onNavigate }) {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [markingId, setMarkingId] = useState(null);
  const [markMiles, setMarkMiles] = useState('');
  const [logForm, setLogForm] = useState({
    retailer: '',
    path_type: 'direct',
    p_list: '',
    miles_expected: '',
    risk_class: 'confirmed',
    snapshot_id: '',
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedFields, setAdvancedFields] = useState({
    p_portal: '',
    p_card: '',
    p_cash: '',
  });
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
    // Prefill snapshot_id from latest scraper snapshot
    fetch('/api/scraper/status')
      .then((r) => r.json())
      .then((d) => {
        if (d.snapshot_id) {
          setLogForm((f) => ({ ...f, snapshot_id: d.snapshot_id }));
        }
      })
      .catch(() => {});
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
      if (resp.ok) {
        setMarkingId(null);
        setMarkMiles('');
        fetchPurchases();
      }
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
    if (showAdvanced && advancedFields.p_portal)
      body.p_portal = parseFloat(advancedFields.p_portal);
    if (showAdvanced && advancedFields.p_card)
      body.p_card = parseFloat(advancedFields.p_card);
    if (showAdvanced && advancedFields.p_cash)
      body.p_cash = parseFloat(advancedFields.p_cash);
    try {
      const resp = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        setLogMsg('Purchase logged successfully.');
        setLogForm((f) => ({ ...f, retailer: '', p_list: '', miles_expected: '' }));
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

  const totalCount = purchases.length;
  const totalExpected = purchases.reduce((s, p) => s + (p.miles_expected || 0), 0);
  const totalPosted = purchases.reduce((s, p) => s + (p.miles_posted || 0), 0);
  const pendingMiles = purchases
    .filter((p) => p.posting_status === 'pending' || p.posting_status === 'overdue')
    .reduce((s, p) => s + (p.miles_expected || 0), 0);
  const postingRate =
    totalExpected > 0 ? ((totalPosted / totalExpected) * 100).toFixed(1) : null;

  return (
    <div className="page-wrapper">
      <header className="page-header">
        <button className="back-btn" onClick={() => onNavigate('/')} aria-label="Back to home">
          &#8592;
        </button>
        <h1 className="page-title">Purchases</h1>
        <div className="page-header-nav">
          <button
            className="nav-icon-btn active"
            aria-label="Purchases"
            aria-current="page"
            title="Purchases"
            disabled
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
      </header>

      <div className="page-content">
        {/* Summary bar */}
        <div className="summary-bar">
          <div className="summary-stat">
            <strong>{totalCount}</strong>
            <span>Purchases</span>
          </div>
          <div className="summary-stat">
            <strong>{totalExpected.toLocaleString()}</strong>
            <span>Expected Miles</span>
          </div>
          <div className="summary-stat">
            <strong>{totalPosted.toLocaleString()}</strong>
            <span>Posted Miles</span>
          </div>
          <div className="summary-stat">
            <strong>{pendingMiles.toLocaleString()}</strong>
            <span>Pending Miles</span>
          </div>
        </div>

        {postingRate !== null && (
          <p className="text-muted" style={{ marginBottom: 12 }}>
            {postingRate}% of expected miles have posted.
          </p>
        )}

        <button onClick={fetchPurchases} disabled={loading} className="refresh-btn">
          {loading ? 'Loading…' : 'Refresh'}
        </button>

        {error && (
          <div className="error-panel" role="alert">
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* Purchase history table */}
        <div className="purchases-table-wrapper">
          <table className="purchases-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Retailer</th>
                <th>Path</th>
                <th style={{ textAlign: 'right' }}>Expected</th>
                <th style={{ textAlign: 'right' }}>Posted</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.purchase_id}>
                  <td>{new Date(p.purchased_at).toLocaleDateString()}</td>
                  <td>{p.retailer_name}</td>
                  <td>{p.path_type}</td>
                  <td style={{ textAlign: 'right' }}>
                    {(p.miles_expected || 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {p.miles_posted != null ? p.miles_posted.toLocaleString() : '—'}
                  </td>
                  <td>
                    <span
                      className="status-badge"
                      style={{
                        backgroundColor: STATUS_COLORS[p.posting_status] || '#666',
                      }}
                    >
                      {p.posting_status}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {p.posting_status !== 'posted' &&
                      (markingId === p.purchase_id ? (
                        <span>
                          <input
                            type="number"
                            min="1"
                            value={markMiles}
                            onChange={(e) => setMarkMiles(e.target.value)}
                            style={{ width: 70, padding: 4, fontSize: 12, borderRadius: 4, border: '1px solid #ccc' }}
                            placeholder="miles"
                          />
                          <button
                            onClick={() => handleMarkPosted(p.purchase_id)}
                            className="action-btn"
                            style={{ marginLeft: 4 }}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => { setMarkingId(null); setMarkMiles(''); }}
                            className="action-btn"
                          >
                            ✕
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setMarkingId(p.purchase_id)}
                          className="action-btn"
                          style={{ marginRight: 4 }}
                        >
                          Mark Posted
                        </button>
                      ))}
                    <button
                      onClick={() => handleDelete(p.purchase_id)}
                      className="action-btn danger"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {purchases.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    style={{ padding: 20, textAlign: 'center', color: '#999' }}
                  >
                    No purchases logged yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Manual log form */}
        <div className="log-form-panel">
          <h3>Log a Purchase</h3>
          <form onSubmit={handleLogSubmit}>
            <div className="form-row">
              <div className="form-field">
                <label>Retailer</label>
                <input
                  type="text"
                  className="form-input"
                  value={logForm.retailer}
                  onChange={(e) => setLogForm({ ...logForm, retailer: e.target.value })}
                  required
                  placeholder="e.g. BestBuy"
                />
              </div>
              <div className="form-field">
                <label>Path</label>
                <select
                  className="form-select"
                  value={logForm.path_type}
                  onChange={(e) => setLogForm({ ...logForm, path_type: e.target.value })}
                >
                  <option value="direct">Direct</option>
                  <option value="mpx">MPX</option>
                  <option value="stacked">Stacked</option>
                </select>
              </div>
              <div className="form-field">
                <label>List Price ($)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="form-input"
                  value={logForm.p_list}
                  onChange={(e) => setLogForm({ ...logForm, p_list: e.target.value })}
                  required
                  style={{ width: 110 }}
                />
              </div>
              <div className="form-field">
                <label>Expected Miles</label>
                <input
                  type="number"
                  min="1"
                  className="form-input"
                  value={logForm.miles_expected}
                  onChange={(e) =>
                    setLogForm({ ...logForm, miles_expected: e.target.value })
                  }
                  required
                  style={{ width: 110 }}
                />
              </div>
              <div className="form-field">
                <label>Risk Class</label>
                <select
                  className="form-select"
                  value={logForm.risk_class}
                  onChange={(e) => setLogForm({ ...logForm, risk_class: e.target.value })}
                >
                  <option value="confirmed">confirmed</option>
                  <option value="uncertain">uncertain</option>
                  <option value="excluded">excluded</option>
                </select>
              </div>
              <div className="form-field">
                <label>Snapshot ID</label>
                <input
                  type="text"
                  className="form-input"
                  value={logForm.snapshot_id}
                  onChange={(e) =>
                    setLogForm({ ...logForm, snapshot_id: e.target.value })
                  }
                  required
                  style={{ width: 180, fontSize: 12 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#1565c0',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: 0,
                }}
              >
                {showAdvanced ? 'Hide' : 'Show'} Advanced (spend vector)
              </button>
              {showAdvanced && (
                <div className="form-row" style={{ marginTop: 8 }}>
                  <div className="form-field">
                    <label style={{ fontSize: 12 }}>p_portal</label>
                    <input
                      type="number"
                      step="0.01"
                      className="form-input"
                      value={advancedFields.p_portal}
                      onChange={(e) =>
                        setAdvancedFields({ ...advancedFields, p_portal: e.target.value })
                      }
                      style={{ width: 100 }}
                    />
                  </div>
                  <div className="form-field">
                    <label style={{ fontSize: 12 }}>p_card</label>
                    <input
                      type="number"
                      step="0.01"
                      className="form-input"
                      value={advancedFields.p_card}
                      onChange={(e) =>
                        setAdvancedFields({ ...advancedFields, p_card: e.target.value })
                      }
                      style={{ width: 100 }}
                    />
                  </div>
                  <div className="form-field">
                    <label style={{ fontSize: 12 }}>p_cash</label>
                    <input
                      type="number"
                      step="0.01"
                      className="form-input"
                      value={advancedFields.p_cash}
                      onChange={(e) =>
                        setAdvancedFields({ ...advancedFields, p_cash: e.target.value })
                      }
                      style={{ width: 100 }}
                    />
                  </div>
                </div>
              )}
            </div>

            <button type="submit" className="form-submit-btn">
              Log Purchase
            </button>
          </form>

          {logMsg && (
            <p
              style={{ marginTop: 10, fontSize: 13 }}
              className={logMsg.startsWith('Error') ? 'text-error' : 'text-success'}
            >
              {logMsg}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
