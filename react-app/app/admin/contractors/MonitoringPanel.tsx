'use client';

/**
 * Platform Monitoring panel (port of loadCronHealth + helpers,
 * admin-contractors.html:1493–1728). Collapsible. Renders:
 *   • Active Alerts table (unacked platform_alerts_log) with Acknowledge
 *   • Edge Function Health table (ef-* cron_health rows)
 *   • DocuSign Envelopes usage card (docusign-usage row)
 *   • Cron Job Health table (the remaining job rows)
 * Plus a "Run Health Check Now" button.
 *
 * Data is loaded by the page (supabase reads) and passed in. The acknowledge_alert
 * RPC + platform-health-check EF are called via page-provided callbacks (UNCHANGED
 * contracts). XSS-fold: every cell value renders as JSX text; Acknowledge is an
 * onClick closure over a.id — never an injected handler.
 */

import { useState } from 'react';
import {
  type CronRow,
  type PlatformAlert,
  type CronStatusBadge,
  splitCronRows,
  efFunctionName,
  findDocusignRow,
  cronJobRows,
  parseDocusignMeta,
  alertTypeLabel,
  cronStatusBadge,
  timeAgo,
  firstMessageLine,
} from './utils';

const th: React.CSSProperties = { padding: '0.4rem 0.6rem', textAlign: 'left' };
const thRight: React.CSSProperties = { padding: '0.4rem 0.6rem', textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.4rem 0.6rem' };

function StatusPill({ badge }: { badge: CronStatusBadge }) {
  return (
    <span
      title={badge.title}
      style={{
        background: badge.bg,
        color: badge.color,
        borderRadius: '0.25rem',
        padding: '0.15rem 0.5rem',
        fontSize: '0.72rem',
        fontWeight: 600,
      }}
    >
      {badge.text}
    </span>
  );
}

export interface MonitoringPanelProps {
  open: boolean;
  onToggle: () => void;
  loading: boolean;
  error: string | null;
  cronRows: CronRow[];
  alerts: PlatformAlert[];
  onRunHealthCheck: () => Promise<number>;
  onAcknowledge: (alertId: string) => void;
}

export function MonitoringPanel({
  open,
  onToggle,
  loading,
  error,
  cronRows,
  alerts,
  onRunHealthCheck,
  onAcknowledge,
}: MonitoringPanelProps) {
  const [runLabel, setRunLabel] = useState('▶ Run Health Check Now');
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setRunLabel('⏳ Running…');
    try {
      const total = await onRunHealthCheck();
      setRunLabel(total > 0 ? `⚠️ ${total} alert(s) fired` : '✅ All clear');
    } catch {
      setRunLabel('❌ Error');
    } finally {
      setRunning(false);
      setTimeout(() => setRunLabel('▶ Run Health Check Now'), 4000);
    }
  }

  const { efRows, jobRows } = splitCronRows(cronRows);
  const docusign = findDocusignRow(jobRows);
  const jobs = cronJobRows(jobRows);

  return (
    <div className="oqac-monitor">
      <div className="oqac-monitor-bar">
        <button type="button" className="oqac-monitor-toggle" onClick={onToggle} aria-expanded={open}>
          <span>{open ? '▼' : '▶'}</span> Platform Monitoring
        </button>
        {open && (
          <button type="button" className="oqac-monitor-run" onClick={run} disabled={running}>
            {runLabel}
          </button>
        )}
      </div>

      {open && (
        <div className="oqac-monitor-panel">
          {loading ? (
            <span style={{ color: '#94a3b8' }}>Loading…</span>
          ) : error ? (
            <span style={{ color: '#ef4444' }}>{error}</span>
          ) : (
            <>
              {/* Active Alerts */}
              {alerts.length > 0 ? (
                <div style={{ marginBottom: '1.5rem' }}>
                  <div
                    style={{
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      color: '#ef4444',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      marginBottom: '0.5rem',
                    }}
                  >
                    ⚠️ Active Alerts ({alerts.length})
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                    <thead>
                      <tr style={{ background: '#1e293b', color: '#94a3b8' }}>
                        <th style={th}>Time</th>
                        <th style={th}>Type</th>
                        <th style={th}>Function</th>
                        <th style={th}>Message</th>
                        <th style={th}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {alerts.map((a) => {
                        const type = alertTypeLabel(a.alert_type);
                        return (
                          <tr key={a.id} style={{ borderBottom: '1px solid #1e293b' }}>
                            <td style={{ ...td, color: '#cbd5e1', whiteSpace: 'nowrap' }}>
                              {a.sent_at ? new Date(a.sent_at).toLocaleString() : '—'}
                            </td>
                            <td style={td}>
                              <span
                                style={{
                                  background: type.bg,
                                  color: type.color,
                                  borderRadius: '0.25rem',
                                  padding: '0.15rem 0.5rem',
                                  fontSize: '0.72rem',
                                  fontWeight: 600,
                                }}
                              >
                                {type.text}
                              </span>
                            </td>
                            <td style={{ ...td, color: '#e2e8f0', fontFamily: 'monospace' }}>{a.function_name}</td>
                            <td
                              style={{
                                ...td,
                                color: '#94a3b8',
                                maxWidth: 280,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {firstMessageLine(a.message)}
                            </td>
                            <td style={td}>
                              <button
                                type="button"
                                onClick={() => onAcknowledge(a.id)}
                                style={{
                                  background: '#0D1B2E',
                                  border: '1px solid #334155',
                                  color: '#94a3b8',
                                  fontSize: '0.75rem',
                                  padding: '0.25rem 0.6rem',
                                  borderRadius: '0.3rem',
                                  cursor: 'pointer',
                                }}
                              >
                                Acknowledge
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ color: '#22c55e', fontSize: '0.8rem', marginBottom: '1.25rem' }}>✅ No active alerts</div>
              )}

              {/* Edge Function Health */}
              <div style={{ marginBottom: '1.5rem' }}>
                <div
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    color: '#94a3b8',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    marginBottom: '0.5rem',
                  }}
                >
                  Edge Function Health
                </div>
                {efRows.length === 0 ? (
                  <div style={{ color: '#64748b', fontSize: '0.8rem' }}>
                    No health ping data yet. Run a health check to populate.
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                    <thead>
                      <tr style={{ background: '#1e293b', color: '#94a3b8' }}>
                        <th style={th}>Function</th>
                        <th style={th}>Last Ping</th>
                        <th style={th}>Status</th>
                        <th style={thRight}>Pings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {efRows.map((r) => (
                        <tr key={r.job_name} style={{ borderBottom: '1px solid #1e293b' }}>
                          <td style={{ ...td, color: '#e2e8f0', fontFamily: 'monospace' }}>
                            {efFunctionName(r.job_name)}
                          </td>
                          <td style={{ ...td, color: '#cbd5e1' }}>{r.last_run_at ? timeAgo(r.last_run_at) : '—'}</td>
                          <td style={td}>
                            <StatusPill badge={cronStatusBadge(r.last_run_status, r.last_error)} />
                          </td>
                          <td style={{ ...td, color: '#64748b', textAlign: 'right' }}>{r.run_count || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* DocuSign Envelopes */}
              {docusign && <DocusignCard row={docusign} />}

              {/* Cron Job Health */}
              <div>
                <div
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    color: '#94a3b8',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    marginBottom: '0.5rem',
                  }}
                >
                  Cron Job Health
                </div>
                {jobs.length === 0 ? (
                  <div style={{ color: '#64748b', fontSize: '0.8rem' }}>No cron health data yet.</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                    <thead>
                      <tr style={{ background: '#1e293b', color: '#94a3b8' }}>
                        <th style={th}>Job</th>
                        <th style={th}>Last Run</th>
                        <th style={th}>Status</th>
                        <th style={th}>Error</th>
                        <th style={thRight}>Runs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map((r) => {
                        const errText = r.last_error
                          ? r.last_error.substring(0, 60) + (r.last_error.length > 60 ? '…' : '')
                          : '—';
                        return (
                          <tr key={r.job_name} style={{ borderBottom: '1px solid #1e293b' }}>
                            <td style={{ ...td, color: '#e2e8f0', fontFamily: 'monospace' }}>{r.job_name}</td>
                            <td style={{ ...td, color: '#cbd5e1' }}>{r.last_run_at ? timeAgo(r.last_run_at) : '—'}</td>
                            <td style={td}>
                              <StatusPill badge={cronStatusBadge(r.last_run_status, r.last_error)} />
                            </td>
                            <td style={{ ...td, color: '#64748b', fontSize: '0.75rem' }}>{errText}</td>
                            <td style={{ ...td, color: '#64748b', textAlign: 'right' }}>{r.run_count || 0}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DocusignCard({ row }: { row: CronRow }) {
  const m = parseDocusignMeta(row);
  const lastRun = row.last_run_at ? timeAgo(row.last_run_at) : '—';
  return (
    <div style={{ background: '#1e293b', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e2e8f0' }}>📧 DocuSign Envelopes</span>
        <span style={{ fontSize: '0.75rem', color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          Last checked: {lastRun} <StatusPill badge={cronStatusBadge(row.last_run_status, row.last_error)} />
        </span>
      </div>
      <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.4rem' }}>
        Plan: Basic API Plan · Monthly limit: {m.limit} envelopes
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div style={{ flex: 1, background: '#0f172a', borderRadius: 4, height: 8, overflow: 'hidden' }}>
          <div style={{ width: m.barWidth + '%', height: '100%', background: m.barColor, transition: 'width 0.3s' }} />
        </div>
        <span style={{ fontSize: '0.8rem', color: '#e2e8f0', whiteSpace: 'nowrap' }}>
          {m.used} / {m.limit} ({m.pct != null ? m.pct : '—'}%)
        </span>
      </div>
      <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.35rem' }}>
        {m.alertSent ? '⚠️ Alert sent' : 'No alert'}
      </div>
    </div>
  );
}
