'use client';

/**
 * Contractor Bid Form — shared presentational primitives + styles (D-211 Phase 7 / BF-2).
 * Small, controlled inputs so bid-form.tsx renders the (many) ported fields without
 * repeating markup. No DB-/user value is ever set via innerHTML — everything is JSX text.
 */

import React from 'react';

export function Card({ title, sub, tone, children, id }: {
  title?: string; sub?: string; tone?: 'warn'; children: React.ReactNode; id?: string;
}) {
  return (
    <section className={'oqb-card' + (tone === 'warn' ? ' oqb-card-warn' : '')} id={id}>
      {title && <h2 className={'oqb-card-title' + (tone === 'warn' ? ' oqb-title-warn' : '')}>{title}</h2>}
      {sub && <p className="oqb-card-sub">{sub}</p>}
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="oqb-field">
      {label && <span className="oqb-label">{label}</span>}
      {children}
      {hint && <span className="oqb-hint">{hint}</span>}
    </label>
  );
}

export function TextInput({ value, onChange, placeholder, type = 'text', id }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string; id?: string;
}) {
  return <input id={id} className="oqb-input" type={type} value={value} placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)} />;
}

export function MoneyInput({ value, onChange, placeholder, id }: {
  value: string; onChange: (v: string) => void; placeholder?: string; id?: string;
}) {
  return (
    <div className="oqb-money">
      <span aria-hidden="true">$</span>
      <input id={id} className="oqb-input" type="number" step="0.01" min="0" value={value}
        placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function TextArea({ value, onChange, placeholder, rows = 3 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number;
}) {
  return <textarea className="oqb-input oqb-textarea" rows={rows} value={value} placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)} />;
}

export interface Opt { value: string; label: string }

export function Select({ value, onChange, options, id }: {
  value: string; onChange: (v: string) => void; options: Opt[]; id?: string;
}) {
  return (
    <select id={id} className="oqb-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode }) {
  return (
    <label className="oqb-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function RadioRow({ name, value, onChange, options }: {
  name: string; value: string; onChange: (v: string) => void; options: Opt[];
}) {
  return (
    <div className="oqb-radio-row">
      {options.map((o) => (
        <label key={o.value} className={'oqb-radio' + (value === o.value ? ' is-on' : '')}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** USD formatting parity with the static formatCurrency (Intl en-US, 2dp). */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
}

export const BID_STYLES = `
  .oqb-wrap { max-width: 880px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  .oqb-h1 { font-size: 1.5rem; font-weight: 800; color: var(--navy, #0B1929); margin: 0 0 0.25rem; }
  .oqb-sub { color: var(--gray, #64748b); margin: 0 0 1.5rem; font-size: 0.95rem; }
  .oqb-card { background: var(--white, #fff); border: 1px solid #E5E7EB; border-radius: 12px; padding: 1.25rem 1.25rem; margin-bottom: 1rem; }
  .oqb-card-warn { border-color: #FCD34D; background: #FFFBEB; }
  .oqb-card-title { font-size: 1.05rem; font-weight: 700; color: var(--navy, #0B1929); margin: 0 0 0.25rem; }
  .oqb-title-warn { color: #92400E; }
  .oqb-card-sub { color: var(--gray, #64748b); font-size: 0.85rem; margin: 0 0 0.9rem; }
  .oqb-field { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.85rem; }
  .oqb-label { font-size: 0.82rem; font-weight: 600; color: #334155; }
  .oqb-hint { font-size: 0.74rem; color: #94a3b8; }
  .oqb-input { width: 100%; box-sizing: border-box; padding: 0.55rem 0.7rem; border: 1.5px solid #D1D5DB; border-radius: 8px; font-size: 0.9rem; font-family: inherit; color: var(--navy, #0B1929); background: #fff; }
  .oqb-input:focus { outline: none; border-color: var(--amber, #E07B00); }
  .oqb-textarea { resize: vertical; }
  .oqb-money { display: flex; align-items: center; gap: 0.4rem; }
  .oqb-money > span { color: #64748b; font-weight: 700; }
  .oqb-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1rem; }
  .oqb-check { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.86rem; color: #334155; cursor: pointer; margin: 0.35rem 0; }
  .oqb-check input { margin-top: 0.2rem; }
  .oqb-radio-row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .oqb-radio { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.75rem; border: 1.5px solid #E5E7EB; border-radius: 8px; cursor: pointer; font-size: 0.85rem; }
  .oqb-radio.is-on { border-color: var(--amber, #E07B00); background: rgba(224,123,0,0.06); }
  .oqb-fee-box { background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 10px; padding: 1rem; }
  .oqb-fee-row { display: flex; justify-content: space-between; font-size: 0.9rem; padding: 0.25rem 0; }
  .oqb-fee-row.total { font-weight: 800; color: var(--navy, #0B1929); border-top: 1px solid #E5E7EB; margin-top: 0.4rem; padding-top: 0.5rem; }
  .oqb-fee-info { font-size: 0.8rem; color: #475569; margin-top: 0.5rem; }
  .oqb-accept { display: flex; align-items: flex-start; gap: 0.6rem; background: #FFF7ED; border: 1px solid #FED7AA; border-radius: 10px; padding: 0.85rem; margin-top: 0.85rem; font-size: 0.85rem; color: #7C2D12; }
  .oqb-btn { background: var(--amber, #E07B00); color: #fff; border: none; border-radius: 10px; padding: 0.8rem 1.4rem; font-size: 0.95rem; font-weight: 800; cursor: pointer; font-family: inherit; }
  .oqb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .oqb-btn-secondary { background: #fff; color: var(--navy, #0B1929); border: 1.5px solid #CBD5E1; }
  .oqb-btn-danger { background: #DC2626; color: #fff; }
  .oqb-actions { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-top: 0.5rem; }
  .oqb-banner { border-radius: 10px; padding: 0.85rem 1rem; font-size: 0.88rem; margin-bottom: 1rem; }
  .oqb-banner-change { background: #EFF6FF; border: 1px solid #BFDBFE; color: #1E40AF; }
  .oqb-banner-renew { background: #ECFDF5; border: 1px solid #A7F3D0; color: #065F46; }
  .oqb-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem; font-size: 0.86rem; }
  .oqb-summary-k { color: #64748b; } .oqb-summary-v { color: var(--navy, #0B1929); font-weight: 600; }
  .oqb-doclinks { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
  .oqb-doclink { border: 1.5px solid #CBD5E1; background: #fff; border-radius: 8px; padding: 0.45rem 0.8rem; font-size: 0.82rem; font-weight: 600; color: var(--navy, #0B1929); cursor: pointer; }
  .oqb-loading { display: flex; align-items: center; justify-content: center; min-height: 60vh; }
  .oqb-spin { width: 28px; height: 28px; border: 3px solid rgba(224,123,0,0.2); border-top-color: var(--amber, #E07B00); border-radius: 50%; animation: oqb-spin 0.8s linear infinite; }
  @keyframes oqb-spin { to { transform: rotate(360deg); } }
  .oqb-success { text-align: center; padding: 2.5rem 1rem; }
  .oqb-success-icon { width: 56px; height: 56px; border-radius: 50%; background: #16A34A; color: #fff; font-size: 1.8rem; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; }
  .oqb-photos-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; }
  .oqb-photos-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; cursor: pointer; border: 1px solid #E5E7EB; }
  .oqb-photos-more { font-size: 0.78rem; color: #64748b; margin-top: 0.5rem; }
  .oqb-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .oqb-lightbox img { max-width: 90vw; max-height: 85vh; border-radius: 8px; }
  .oqb-lightbox button { position: absolute; background: rgba(255,255,255,0.15); color: #fff; border: none; border-radius: 8px; font-size: 1.4rem; width: 44px; height: 44px; cursor: pointer; }
  .oqb-lb-close { top: 1rem; right: 1rem; } .oqb-lb-prev { left: 1rem; } .oqb-lb-next { right: 1rem; }
  .oqb-wizardbar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
  .oqb-wstep { display: flex; align-items: center; gap: 0.4rem; font-size: 0.82rem; color: #94a3b8; font-weight: 600; }
  .oqb-wstep .num { width: 26px; height: 26px; border-radius: 50%; background: #E5E7EB; color: #64748b; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; }
  .oqb-wstep.active .num { background: var(--amber, #E07B00); color: #fff; } .oqb-wstep.active { color: var(--navy, #0B1929); }
  .oqb-wstep.done .num { background: #16A34A; color: #fff; }
  .oqb-wconn { flex: 1; height: 2px; background: #E5E7EB; } .oqb-wconn.done { background: #16A34A; }
  .oqb-trade-badge { display: inline-block; background: var(--navy, #0B1929); color: #fff; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.04em; padding: 0.2rem 0.6rem; border-radius: 6px; margin-bottom: 0.75rem; }
  .oqb-err { color: #B91C1C; font-size: 0.85rem; margin-top: 0.5rem; }
  @media (max-width: 640px) { .oqb-grid2, .oqb-summary { grid-template-columns: 1fr; } .oqb-photos-grid { grid-template-columns: repeat(2, 1fr); } }
`;
