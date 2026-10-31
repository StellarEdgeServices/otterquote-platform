/**
 * D-407 shared card styles (gh-3283 / gh-3285). Class prefix `d407-`. Byte-identical in both PRs.
 * Dark homeowner-shell theme, same variables the sibling help-* pages use.
 */
export const D407_CSS = `
  .d407-page { max-width: 760px; margin: 0 auto; padding: 2rem 1.5rem 4rem; font-family: inherit; }
  .d407-title { font-size: 1.75rem; font-weight: 800; color: var(--white, #fff); margin: 0 0 1rem; }
  .d407-banner { background: rgba(224,123,0,0.08); border: 1px solid rgba(224,123,0,0.25); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; color: var(--white, #fff); }
  .d407-banner a { color: #d4a017; font-weight: 600; white-space: nowrap; }
  .d407-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .d407-card h2 { font-size: 1.25rem; font-weight: 800; color: var(--white, #fff); margin: 0 0 1rem; }
  .d407-field { margin-bottom: 1rem; }
  .d407-label { display: block; font-weight: 700; font-size: 0.875rem; color: #d4a017; margin-bottom: 0.35rem; }
  .d407-input { width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.25); background: rgba(0,0,0,0.25); color: var(--white, #fff); font: inherit; }
  .d407-input[readonly] { opacity: 0.75; }
  .d407-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 640px) { .d407-row { grid-template-columns: 1fr; } }
  .d407-done { color: #4ade80; font-weight: 700; }
  .d407-btn { background: #b8860b; color: #fff; border: 0; border-radius: 8px; padding: 0.75rem 1.5rem; font-weight: 800; cursor: pointer; font: inherit; }
  .d407-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .d407-btn-link { display: inline-block; text-decoration: none; }
  .d407-error { color: #f87171; font-size: 0.9rem; margin: 0.5rem 0; }
  .d407-missing { color: #f87171; font-size: 0.9rem; margin: 0.5rem 0 0; padding-left: 1.25rem; }
  .d407-note { color: var(--slate, #94a3b8); font-size: 0.9rem; margin: 0 0 1rem; }
  .d407-mat .oqh-mat { padding: 0; max-width: none; }
`;
