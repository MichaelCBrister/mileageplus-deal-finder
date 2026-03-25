import React, { useState, useRef, useCallback } from 'react';

const CARD_TIERS = [
  { value: 'none', label: 'No Chase United card' },
  { value: 'one_x', label: 'United card 1x' },
  { value: 'one_five_x', label: 'United Club 1.5x' },
  { value: 'two_x', label: 'MileagePlus X 2x' },
];

const RISK_OPTIONS = ['confirmed', 'uncertain', 'excluded'];

export default function BasketTab() {
  const [items, setItems] = useState([{ name: '', p_list: '' }]);
  const [taxRate, setTaxRate] = useState('0');
  const [cardTier, setCardTier] = useState('none');
  const [budget, setBudget] = useState('');
  const [riskFilter, setRiskFilter] = useState(['confirmed', 'uncertain']);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [greedy, setGreedy] = useState(null);
  const [milp, setMilp] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [milpStatus, setMilpStatus] = useState(null); // 'running', 'complete', 'failed'
  const [error, setError] = useState(null);
  const [logProgress, setLogProgress] = useState(null);
  const pollRef = useRef(null);

  const addItem = () => setItems([...items, { name: '', p_list: '' }]);
  const removeItem = (idx) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== idx));
  };
  const updateItem = (idx, field, value) => {
    const updated = [...items];
    updated[idx] = { ...updated[idx], [field]: value };
    setItems(updated);
  };

  const toggleRisk = (rc) => {
    setRiskFilter((prev) =>
      prev.includes(rc) ? prev.filter((r) => r !== rc) : [...prev, rc]
    );
  };

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPolling(false);
  }, []);

  const startPolling = useCallback((jid) => {
    const startTime = Date.now();
    pollRef.current = setInterval(async () => {
      // Safety stop after 35 seconds
      if (Date.now() - startTime > 35000) {
        stopPolling();
        setMilpStatus('timeout');
        return;
      }
      try {
        const resp = await fetch(`/api/basket/status/${jid}`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.status === 'complete') {
          setMilp(data.milp);
          setMilpStatus('complete');
          stopPolling();
        } else if (data.status === 'failed') {
          setMilpStatus('failed');
          stopPolling();
        }
      } catch {
        // retry on next interval
      }
    }, 2000);
    setPolling(true);
  }, [stopPolling]);

  const handleOptimize = async () => {
    setError(null);
    setGreedy(null);
    setMilp(null);
    setJobId(null);
    setMilpStatus(null);
    setLogProgress(null);
    stopPolling();

    const validItems = items.filter((it) => it.name && it.p_list);
    if (validItems.length === 0) {
      setError('Add at least one item with a name and price.');
      return;
    }
    if (!budget || parseFloat(budget) <= 0) {
      setError('Enter a positive budget.');
      return;
    }

    setLoading(true);
    try {
      const resp = await fetch('/api/basket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: validItems.map((it) => ({ name: it.name, p_list: parseFloat(it.p_list) })),
          category: 'Electronics',
          card_tier: cardTier,
          budget: parseFloat(budget),
          tax_rate: parseFloat(taxRate) || 0,
          risk_filter: riskFilter,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || data.message || 'Request failed');
        setLoading(false);
        return;
      }
      setGreedy(data.greedy);
      setJobId(data.job_id);
      setMilpStatus('running');
      startPolling(data.job_id);
    } catch (err) {
      setError(`Network error: ${err.message}`);
    }
    setLoading(false);
  };

  const handleLogAll = async () => {
    const result = milp || greedy;
    if (!result || !result.assignments) return;
    const total = result.assignments.length;
    setLogProgress({ done: 0, total });

    for (let i = 0; i < total; i++) {
      const a = result.assignments[i];
      try {
        await fetch('/api/purchases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            retailer: a.retailer_name,
            path_type: a.path,
            p_list: a.spend,
            p_portal: a.spend,
            p_card: a.spend,
            p_cash: a.spend,
            miles_expected: Math.round(a.miles),
            risk_class: 'confirmed',
            snapshot_id: 'basket-optimized',
          }),
        });
      } catch {
        // continue logging remaining
      }
      setLogProgress({ done: i + 1, total });
    }
  };

  const milpImproved = milp && greedy && milp.total_miles > greedy.total_miles;
  const milpSame = milp && greedy && milp.total_miles === greedy.total_miles;
  const displayResult = milpStatus === 'complete' && milp ? milp : greedy;
  const showMilpBanner = milpStatus === 'running' || polling;

  return (
    <div style={s.panel}>
      <h2 style={s.heading}>Basket Optimizer</h2>

      {/* Item entry */}
      <div style={s.section}>
        <label style={s.label}>Shopping List</label>
        {items.map((item, idx) => (
          <div key={idx} style={s.itemRow}>
            <input
              style={s.input}
              placeholder="Item name"
              value={item.name}
              onChange={(e) => updateItem(idx, 'name', e.target.value)}
            />
            <input
              style={{ ...s.input, width: 100 }}
              type="number"
              placeholder="Price ($)"
              value={item.p_list}
              onChange={(e) => updateItem(idx, 'p_list', e.target.value)}
            />
            {items.length > 1 && (
              <button style={s.removeBtn} onClick={() => removeItem(idx)}>
                Remove
              </button>
            )}
          </div>
        ))}
        <button style={s.addBtn} onClick={addItem}>+ Add item</button>
      </div>

      {/* Settings */}
      <div style={s.row}>
        <div style={s.field}>
          <label style={s.label}>Tax Rate (%)</label>
          <input style={s.input} type="number" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
        </div>
        <div style={s.field}>
          <label style={s.label}>Card Tier</label>
          <select style={s.select} value={cardTier} onChange={(e) => setCardTier(e.target.value)}>
            {CARD_TIERS.map((ct) => (
              <option key={ct.value} value={ct.value}>{ct.label}</option>
            ))}
          </select>
        </div>
        <div style={s.field}>
          <label style={s.label}>Total Budget ($)</label>
          <input style={s.input} type="number" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
      </div>

      {/* Risk filter */}
      <div style={s.section}>
        <label style={s.label}>Risk Filter</label>
        <div style={s.row}>
          {RISK_OPTIONS.map((rc) => (
            <label key={rc} style={s.checkLabel}>
              <input
                type="checkbox"
                checked={riskFilter.includes(rc)}
                onChange={() => toggleRisk(rc)}
              />
              {rc}
            </label>
          ))}
        </div>
      </div>

      <button style={s.optimizeBtn} onClick={handleOptimize} disabled={loading}>
        {loading ? 'Optimizing...' : 'Optimize Basket'}
      </button>

      {error && <div style={s.error}>{error}</div>}

      {/* Results */}
      {greedy && (
        <div style={s.results}>
          {showMilpBanner && (
            <div style={s.banner}>
              Greedy solution shown -- MILP optimization in progress...
            </div>
          )}

          {milpStatus === 'complete' && milpImproved && (
            <div style={s.improvement}>
              MILP found {milp.total_miles.toFixed(0)} miles vs greedy {greedy.total_miles.toFixed(0)} miles
              ({((milp.total_miles - greedy.total_miles) / greedy.total_miles * 100).toFixed(1)}% improvement)
            </div>
          )}
          {milpStatus === 'complete' && milpSame && (
            <div style={s.confirmed}>MILP confirmed greedy solution is optimal</div>
          )}
          {milpStatus === 'complete' && !milp && (
            <div style={s.warning}>MILP did not find an improvement -- greedy solution shown.</div>
          )}
          {milpStatus === 'failed' && (
            <div style={s.warning}>MILP solver failed -- greedy solution shown.</div>
          )}
          {milpStatus === 'timeout' && (
            <div style={s.warning}>MILP solver timed out -- greedy solution shown.</div>
          )}

          <h3 style={s.subheading}>
            {milpStatus === 'complete' && milp ? 'MILP-Optimized' : 'Greedy'} Assignments
          </h3>

          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Item</th>
                <th style={s.th}>Retailer</th>
                <th style={s.th}>Path</th>
                <th style={s.thRight}>Miles</th>
                <th style={s.thRight}>Spend</th>
              </tr>
            </thead>
            <tbody>
              {displayResult && displayResult.assignments.map((a, idx) => (
                <tr key={idx}>
                  <td style={s.td}>{a.item_name}</td>
                  <td style={s.td}>{a.retailer_name}</td>
                  <td style={s.td}>{a.path}</td>
                  <td style={s.tdRight}>{a.miles.toFixed(0)}</td>
                  <td style={s.tdRight}>${a.spend.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={s.totalRow}>
                <td style={s.td} colSpan={3}><strong>Total</strong></td>
                <td style={s.tdRight}><strong>{displayResult ? displayResult.total_miles.toFixed(0) : 0}</strong></td>
                <td style={s.tdRight}><strong>${displayResult ? displayResult.total_spend.toFixed(2) : '0.00'}</strong></td>
              </tr>
            </tfoot>
          </table>

          {!displayResult?.feasible && (
            <div style={s.warning}>Budget too tight -- not all items could be assigned.</div>
          )}

          {/* Log all button */}
          {(milpStatus === 'complete' || milpStatus === 'failed' || milpStatus === 'timeout') && displayResult && (
            <div style={s.section}>
              {logProgress ? (
                <div style={s.logStatus}>
                  {logProgress.done < logProgress.total
                    ? `Logging ${logProgress.done + 1} of ${logProgress.total} purchases...`
                    : `All ${logProgress.total} purchases logged!`}
                </div>
              ) : (
                <button style={s.logBtn} onClick={handleLogAll}>
                  Log all assignments
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const s = {
  panel: { padding: 16 },
  heading: { margin: '0 0 16px 0', fontSize: 20 },
  subheading: { margin: '12px 0 8px 0', fontSize: 16 },
  section: { marginBottom: 12 },
  label: { display: 'block', fontWeight: 600, marginBottom: 4, fontSize: 13 },
  itemRow: { display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' },
  input: { padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 14 },
  select: { padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 14 },
  addBtn: { background: 'none', border: '1px dashed #999', padding: '4px 12px', cursor: 'pointer', borderRadius: 4 },
  removeBtn: { background: '#f5f5f5', border: '1px solid #ccc', padding: '4px 8px', cursor: 'pointer', borderRadius: 4, fontSize: 12 },
  row: { display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 120 },
  checkLabel: { display: 'flex', gap: 4, alignItems: 'center', marginRight: 12, fontSize: 13 },
  optimizeBtn: {
    background: '#1565c0', color: '#fff', border: 'none', padding: '10px 24px',
    borderRadius: 4, cursor: 'pointer', fontSize: 15, fontWeight: 600, marginBottom: 12,
  },
  error: { color: '#c62828', background: '#fce4ec', padding: 8, borderRadius: 4, marginBottom: 8 },
  banner: { background: '#fff3e0', padding: 8, borderRadius: 4, marginBottom: 8, fontWeight: 500 },
  improvement: { background: '#e8f5e9', color: '#2e7d32', padding: 8, borderRadius: 4, marginBottom: 8, fontWeight: 600 },
  confirmed: { background: '#e8f5e9', color: '#2e7d32', padding: 8, borderRadius: 4, marginBottom: 8 },
  warning: { background: '#fff8e1', color: '#f57f17', padding: 8, borderRadius: 4, marginBottom: 8 },
  results: { marginTop: 12 },
  table: { width: '100%', borderCollapse: 'collapse', marginBottom: 8 },
  th: { textAlign: 'left', borderBottom: '2px solid #ddd', padding: '6px 8px', fontSize: 13 },
  thRight: { textAlign: 'right', borderBottom: '2px solid #ddd', padding: '6px 8px', fontSize: 13 },
  td: { padding: '6px 8px', borderBottom: '1px solid #eee', fontSize: 13 },
  tdRight: { textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #eee', fontSize: 13 },
  totalRow: { background: '#f5f5f5' },
  logBtn: {
    background: '#388e3c', color: '#fff', border: 'none', padding: '8px 16px',
    borderRadius: 4, cursor: 'pointer', fontSize: 14, marginTop: 8,
  },
  logStatus: { padding: 8, fontSize: 14 },
};
