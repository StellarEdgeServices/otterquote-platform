'use client';

/**
 * Expansion Waitlist panel (D-178, port of loadWaitlistStats + toggleWaitlistPanel,
 * admin-contractors.html:1736–1821). Collapsible by-state table (Total / Opted In).
 * Data loaded by the page (expansion_waitlist read); Refresh re-runs it. All values
 * render as JSX text — no innerHTML.
 */

import { type WaitlistRow, groupWaitlistByState } from './utils';

const th: React.CSSProperties = { textAlign: 'left', padding: '6px 10px', color: '#64748b', fontWeight: 600 };
const thRight: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', color: '#64748b', fontWeight: 600 };

export interface WaitlistPanelProps {
  open: boolean;
  onToggle: () => void;
  loading: boolean;
  error: string | null;
  rows: WaitlistRow[];
  lastRefreshed: string;
  onRefresh: () => void;
}

export function WaitlistPanel({ open, onToggle, loading, error, rows, lastRefreshed, onRefresh }: WaitlistPanelProps) {
  const byState = groupWaitlistByState(rows);

  return (
    <div className="oqac-waitlist">
      <div className="oqac-waitlist-bar">
        <button type="button" className="oqac-monitor-toggle" onClick={onToggle} aria-expanded={open}>
          <span>{open ? '▼' : '▶'}</span> Expansion Waitlist
        </button>
        {open && (
          <button type="button" className="oqac-waitlist-refresh" onClick={onRefresh} disabled={loading}>
            ↻ Refresh
          </button>
        )}
        {open && lastRefreshed && (
          <span style={{ color: '#64748b', fontSize: '0.75rem' }}>Last refreshed: {lastRefreshed}</span>
        )}
      </div>

      {open && (
        <div className="oqac-waitlist-panel">
          {loading ? (
            <span style={{ color: '#94a3b8' }}>Loading…</span>
          ) : error ? (
            <span style={{ color: '#ef4444' }}>{error}</span>
          ) : byState.length === 0 ? (
            <span style={{ color: '#64748b', fontSize: '0.875rem' }}>No waitlist entries yet.</span>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <th style={th}>State</th>
                  <th style={thRight}>Total</th>
                  <th style={thRight}>Opted In</th>
                </tr>
              </thead>
              <tbody>
                {byState.map((s) => (
                  <tr key={s.state} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '6px 10px', fontWeight: 500 }}>{s.state}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{s.total}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{s.optedIn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
