import React, { useState } from 'react';

const RISK_COLORS = {
  confirmed: '#2e7d32',
  uncertain: '#f9a825',
  excluded: '#c62828',
};

/**
 * SweepPanel — Spend Sensitivity Analysis (Phase 9)
 *
 * Collapsible panel shown below Rank results. Runs a breakpoint sweep
 * across a spend range and shows which retailer/path is optimal at each
 * spend level. The slider is client-side only after the initial API call.
 *
 * Props: category, card_tier, tax_rate (from RankPanel form state)
 */
export default function SweepPanel({ category, card_tier, tax_rate }) {
  const [expanded, setExpanded] = useState(false);
  const [pMin, setPMin] = useState('0');
  const [pMax, setPMax] = useState('500');
  const [segments, setSegments] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sliderVal, setSliderVal] = useState(0);

  const runSweep = async () => {
    setLoading(true);
    setError(null);
    setSegments(null);
    try {
      const resp = await fetch('/api/sweep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: category || '',
          card_tier: card_tier || 'none',
          p_min: parseFloat(pMin) || 0,
          p_max: parseFloat(pMax) || 500,
          tax_rate: parseFloat(tax_rate) || 0,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || data.message || `HTTP ${resp.status}`);
      } else if (data.segments && data.segments.length > 0) {
        setSegments(data.segments);
        setSliderVal(Math.round(data.segments[0].spend_from));
      } else {
        setError('No segments returned from sweep.');
      }
    } catch (err) {
      setError(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Find the segment containing the current slider value
  const activeSegment = segments
    ? segments.find(
        (s, i) =>
          sliderVal >= s.spend_from &&
          (i === segments.length - 1
            ? sliderVal <= s.spend_to
            : sliderVal < s.spend_to)
      ) || segments[segments.length - 1]
    : null;

  const minVal = parseFloat(pMin) || 0;
  const maxVal = parseFloat(pMax) || 500;

  return (
    <div style={{ marginTop: 16 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none',
          border: '1px solid #1565c0',
          color: '#1565c0',
          padding: '6px 16px',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 14,
          fontWeight: 'bold',
        }}
      >
        {expanded ? 'Hide' : 'Show'} Spend Sensitivity
      </button>

      {expanded && (
        <div
          style={{
            marginTop: 12,
            padding: 16,
            backgroundColor: '#f5f5f5',
            border: '1px solid #ddd',
            borderRadius: 4,
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: 12 }}>
            Spend Sensitivity Analysis
          </h3>
          <p style={{ fontSize: 13, color: '#666', marginTop: 0 }}>
            As you spend more, at what amounts does the optimal earning path
            change?
          </p>

          {/* Sweep controls */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 13 }}>Min spend ($)</label>
              <input
                type="number"
                min="0"
                step="1"
                value={pMin}
                onChange={(e) => setPMin(e.target.value)}
                style={{ padding: 6, fontSize: 14, border: '1px solid #ccc', borderRadius: 4, width: 80 }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 13 }}>Max spend ($)</label>
              <input
                type="number"
                min="0"
                step="1"
                value={pMax}
                onChange={(e) => setPMax(e.target.value)}
                style={{ padding: 6, fontSize: 14, border: '1px solid #ccc', borderRadius: 4, width: 80 }}
              />
            </div>
            <button
              onClick={runSweep}
              disabled={loading}
              style={{
                padding: '8px 16px',
                fontSize: 14,
                backgroundColor: '#1565c0',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: loading ? 'wait' : 'pointer',
              }}
            >
              {loading ? 'Sweeping...' : 'Run Sweep'}
            </button>
          </div>

          {error && (
            <div
              style={{
                padding: 12,
                backgroundColor: '#ffebee',
                border: '1px solid #c62828',
                borderRadius: 4,
                color: '#c62828',
                marginBottom: 12,
              }}
            >
              <strong>Error:</strong> {error}
            </div>
          )}

          {segments && (
            <>
              {/* Slider */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 13, fontWeight: 'bold' }}>
                  Spend amount: ${sliderVal}
                </label>
                <input
                  type="range"
                  min={minVal}
                  max={maxVal}
                  step={1}
                  value={sliderVal}
                  onChange={(e) => setSliderVal(parseInt(e.target.value, 10))}
                  style={{ width: '100%', marginTop: 4 }}
                />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    color: '#999',
                  }}
                >
                  <span>${minVal}</span>
                  <span>${maxVal}</span>
                </div>
              </div>

              {/* Active segment display */}
              {activeSegment && (
                <div
                  style={{
                    padding: 12,
                    backgroundColor: '#e3f2fd',
                    borderRadius: 4,
                    marginBottom: 16,
                    border: '1px solid #90caf9',
                  }}
                >
                  <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 4 }}>
                    Best at ${sliderVal}:{' '}
                    <span style={{ color: '#1565c0' }}>
                      {activeSegment.retailer_name}
                    </span>{' '}
                    via {activeSegment.path}
                  </div>
                  <div style={{ fontSize: 14 }}>
                    ~{Math.round(activeSegment.miles_at_midpoint).toLocaleString()}{' '}
                    miles (at segment midpoint)
                    <span
                      style={{
                        display: 'inline-block',
                        marginLeft: 8,
                        padding: '1px 8px',
                        borderRadius: 12,
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 'bold',
                        backgroundColor:
                          RISK_COLORS[activeSegment.risk_class] || '#666',
                      }}
                    >
                      {activeSegment.risk_class}
                    </span>
                  </div>
                </div>
              )}

              {/* Segment summary table */}
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
                >
                  <thead>
                    <tr>
                      <th style={thStyle}>Spend Range</th>
                      <th style={thStyle}>Best Retailer</th>
                      <th style={thStyle}>Path</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>
                        Miles (midpoint)
                      </th>
                      <th style={thStyle}>Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segments.map((s, i) => {
                      const isActive =
                        sliderVal >= s.spend_from &&
                        (i === segments.length - 1
                          ? sliderVal <= s.spend_to
                          : sliderVal < s.spend_to);
                      return (
                        <tr
                          key={i}
                          style={{
                            backgroundColor: isActive
                              ? '#bbdefb'
                              : i % 2 === 0
                              ? 'transparent'
                              : '#fafafa',
                            fontWeight: isActive ? 'bold' : 'normal',
                          }}
                        >
                          <td style={tdStyle}>
                            ${s.spend_from.toFixed(0)} &ndash; $
                            {s.spend_to.toFixed(0)}
                          </td>
                          <td style={tdStyle}>{s.retailer_name}</td>
                          <td style={tdStyle}>{s.path}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>
                            {Math.round(s.miles_at_midpoint).toLocaleString()}
                          </td>
                          <td style={tdStyle}>
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '1px 8px',
                                borderRadius: 12,
                                color: '#fff',
                                fontSize: 11,
                                fontWeight: 'bold',
                                backgroundColor:
                                  RISK_COLORS[s.risk_class] || '#666',
                              }}
                            >
                              {s.risk_class}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const thStyle = {
  padding: '6px 8px',
  fontWeight: 'bold',
  borderBottom: '2px solid #bbb',
  textAlign: 'left',
  whiteSpace: 'nowrap',
};

const tdStyle = {
  padding: '6px 8px',
  borderBottom: '1px solid #ddd',
};
