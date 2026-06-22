/**
 * Scoped styles for /bids (D-211 P21). Behaviour-parity port of bids.html — not
 * pixel-parity (same standard as the H1 dashboard). All classes are oqb-*-scoped
 * and injected via a single <style> tag from the page, matching the shell's
 * inline-<style> convention.
 */

export const BIDS_STYLES = `
  .oqb-wrap { max-width: 1040px; margin: 0 auto; padding: 1.5rem; color: rgba(255,255,255,0.92); }
  .oqb-title { font-size: 1.5rem; color: rgba(255,255,255,0.95); margin-bottom: 1.25rem; }

  .oqb-loading { display: flex; justify-content: center; padding: 4rem 1rem; }
  .oqb-spin { width: 28px; height: 28px; border: 3px solid rgba(224,123,0,0.2); border-top-color: var(--amber, #E07B00); border-radius: 50%; animation: oqh-spin 0.8s linear infinite; }

  /* Banners */
  .oqb-banner { display: flex; align-items: center; gap: 0.75rem; padding: 0.85rem 1rem; border-radius: 10px; margin-bottom: 1rem; font-size: 0.9rem; }
  .oqb-banner.updated { background: rgba(37,99,235,0.12); border: 1px solid rgba(37,99,235,0.4); }
  .oqb-banner.expired { background: rgba(217,119,6,0.12); border: 1px solid rgba(217,119,6,0.45); }
  .oqb-banner-icon { font-size: 1.2rem; }
  .oqb-banner-dismiss { margin-left: auto; background: transparent; border: none; color: inherit; cursor: pointer; font-size: 0.9rem; opacity: 0.7; }
  .oqb-banner-dismiss:hover { opacity: 1; }

  /* Empty / waiting / error */
  .oqb-empty { text-align: center; padding: 3rem 1rem; }
  .oqb-empty-icon { font-size: 2.5rem; margin-bottom: 0.5rem; }
  .oqb-empty h2 { font-size: 1.2rem; margin-bottom: 0.5rem; }
  .oqb-empty p { color: var(--slate, #94a3b8); max-width: 440px; margin: 0 auto 1.25rem; }
  .oqb-waiting { display: flex; align-items: center; justify-content: center; gap: 0.6rem; color: var(--slate, #94a3b8); font-size: 0.85rem; }
  .oqb-waiting-dots { display: inline-flex; gap: 4px; }
  .oqb-waiting-dots span { width: 7px; height: 7px; border-radius: 50%; background: var(--amber, #E07B00); animation: oqb-pulse 1s ease-in-out infinite; }
  .oqb-waiting-dots span:nth-child(2) { animation-delay: 0.15s; }
  .oqb-waiting-dots span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes oqb-pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
  .oqb-error { text-align: center; padding: 3rem 1rem; }
  .oqb-error p { color: var(--slate, #94a3b8); margin-bottom: 1rem; }

  /* View toggle */
  .oqb-view-toggle { display: inline-flex; gap: 0; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; overflow: hidden; margin-bottom: 1rem; }
  .oqb-view-btn { background: transparent; color: var(--slate, #94a3b8); border: none; padding: 0.5rem 1.1rem; font-size: 0.85rem; font-weight: 700; cursor: pointer; font-family: inherit; }
  .oqb-view-btn.active { background: var(--amber, #E07B00); color: var(--navy, #0B1929); }

  /* Cards grid */
  .oqb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.25rem; }
  .oqb-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 1.25rem; }
  .oqb-card.lowest { border-color: rgba(22,163,74,0.5); }
  .oqb-card.expired { opacity: 0.6; filter: grayscale(0.55); }
  .oqb-card-top { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
  .oqb-jobtype { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #fff; padding: 3px 9px; border-radius: 999px; }
  .oqb-expired-badge { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; color: var(--amber, #E07B00); }
  .oqb-best { font-size: 0.7rem; font-weight: 700; color: var(--green, #16A34A); }
  .oqb-card-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
  .oqb-avatar { width: 48px; height: 48px; border-radius: 50%; background: rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: center; font-weight: 800; overflow: hidden; flex-shrink: 0; }
  .oqb-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .oqb-name { font-weight: 700; font-size: 1rem; }
  .oqb-meta { display: flex; gap: 0.6rem; flex-wrap: wrap; color: var(--slate, #94a3b8); font-size: 0.8rem; margin-top: 2px; }
  .oqb-verified { color: var(--green, #16A34A); }

  .oqb-expiry-warning { background: rgba(217,119,6,0.12); color: #f5b85b; border-radius: 8px; padding: 0.55rem 0.7rem; font-size: 0.8rem; margin-bottom: 0.85rem; }
  .oqb-expiry-notice { background: rgba(255,255,255,0.04); border-radius: 8px; padding: 0.55rem 0.7rem; font-size: 0.8rem; margin-bottom: 0.85rem; position: relative; }
  .oqb-expiry-info { margin-left: 6px; width: 18px; height: 18px; border-radius: 50%; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; font-size: 0.7rem; line-height: 1; }
  .oqb-expiry-tooltip { margin-top: 0.5rem; background: var(--navy, #0B1929); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 0.6rem 0.7rem; font-size: 0.78rem; color: var(--slate, #cbd5e1); line-height: 1.45; }

  .oqb-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; margin-bottom: 0.85rem; }
  .oqb-metric { display: flex; flex-direction: column; gap: 2px; }
  .oqb-metric.wide { grid-column: 1 / -1; }
  .oqb-metric-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--slate, #94a3b8); }
  .oqb-metric-value { font-weight: 600; }
  .oqb-metric-value.price { font-size: 1.4rem; font-weight: 800; color: var(--amber, #E07B00); }

  .oqb-net { background: rgba(255,255,255,0.03); border-radius: 8px; padding: 0.5rem 0.7rem; font-size: 0.78rem; color: var(--slate, #94a3b8); margin-bottom: 0.85rem; }
  .oqb-net strong { color: #fff; }

  .oqb-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .oqb-btn { font-family: inherit; font-weight: 700; font-size: 0.85rem; padding: 0.55rem 1rem; border-radius: 8px; cursor: pointer; border: 1.5px solid transparent; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
  .oqb-btn.primary { background: var(--amber, #E07B00); color: var(--navy, #0B1929); }
  .oqb-btn.secondary { background: rgba(255,255,255,0.1); color: #fff; }
  .oqb-btn.ghost { background: transparent; color: #fff; border-color: rgba(255,255,255,0.2); }
  .oqb-btn.renew { background: var(--amber, #E07B00); color: var(--navy, #0B1929); }
  .oqb-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  /* Comparison grid */
  .oqb-compare-empty { padding: 2rem 1rem; text-align: center; color: var(--slate, #94a3b8); background: rgba(255,255,255,0.03); border-radius: 12px; }
  .oqb-compare { display: grid; gap: 1px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; overflow: hidden; }
  .oqb-compare-corner { background: var(--navy, #0B1929); }
  .oqb-compare-header { background: var(--navy, #0B1929); padding: 0.75rem; text-align: center; }
  .oqb-compare-name { font-weight: 700; font-size: 0.85rem; }
  .oqb-compare-price { font-weight: 800; color: var(--amber, #E07B00); }
  .oqb-compare-best { font-size: 0.7rem; color: var(--green, #16A34A); }
  .oqb-compare-section-header { grid-column: 1 / -1; background: rgba(255,255,255,0.06); padding: 0.45rem 0.75rem; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: var(--slate, #cbd5e1); }
  .oqb-compare-row-label { background: rgba(11,25,41,0.85); padding: 0.55rem 0.75rem; font-size: 0.8rem; color: var(--slate, #cbd5e1); }
  .oqb-compare-cell { background: rgba(11,25,41,0.6); padding: 0.55rem 0.75rem; font-size: 0.82rem; text-align: center; }
  .oqb-compare-row.identical .oqb-compare-row-label,
  .oqb-compare-row.identical .oqb-compare-cell { opacity: 0.55; }
  .oqb-compare-cell.cell-included { color: var(--green, #16A34A); }
  .oqb-compare-cell.cell-oop { color: #E07B00; }
  .oqb-compare-cell.cell-excluded { color: rgba(255,255,255,0.4); }
  .oqb-compare-cell.cell-na { color: rgba(255,255,255,0.4); }
  .oqb-compare-cell.cell-accent { font-weight: 800; color: var(--amber, #E07B00); }

  /* Modal */
  .oqb-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 1rem; }
  .oqb-modal { background: var(--navy, #0B1929); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 1.5rem; max-width: 440px; width: 100%; }
  .oqb-modal-title { font-size: 1.15rem; margin-bottom: 0.75rem; }
  .oqb-modal-body { color: var(--slate, #cbd5e1); font-size: 0.9rem; line-height: 1.5; margin-bottom: 1.25rem; }
  .oqb-modal-actions { display: flex; gap: 0.6rem; justify-content: flex-end; }
  .oqb-modal-spinner { width: 28px; height: 28px; border: 3px solid rgba(224,123,0,0.2); border-top-color: var(--amber, #E07B00); border-radius: 50%; animation: oqh-spin 0.8s linear infinite; margin: 0 auto 0.75rem; }

  @media (max-width: 640px) {
    .oqb-metrics { grid-template-columns: 1fr; }
    .oqb-grid { grid-template-columns: 1fr; }
  }
`;
