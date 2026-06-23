/**
 * help-materials (H8) styles — dark homeowner-shell theme (var(--white),
 * var(--slate), amber #b8860b), matching the H1/H2/H7 React look. Pixel parity
 * with the light static page is NOT required (same standard as the siblings);
 * behaviour parity is. Class prefix `hm-`.
 */
export const HELP_MATERIALS_CSS = `
  .oqh-mat {
    max-width: 980px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
    font-family: inherit;
  }

  /* Header */
  .hm-header { margin-bottom: 1.75rem; }
  .hm-back {
    display: inline-block;
    color: var(--slate, #94a3b8);
    text-decoration: none;
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    transition: color 0.15s;
  }
  .hm-back:hover { color: var(--white, #fff); }
  .hm-title {
    font-size: 1.75rem;
    font-weight: 800;
    color: var(--white, #fff);
    margin: 0 0 0.25rem;
  }
  .hm-subtitle { color: var(--slate, #94a3b8); font-size: 1rem; margin: 0; }

  /* Spinner */
  .hm-spinner {
    display: flex; align-items: center; justify-content: center; min-height: 200px;
  }
  .hm-spinner-ring {
    width: 32px; height: 32px;
    border: 3px solid rgba(184,134,11,0.2);
    border-top-color: #b8860b;
    border-radius: 50%;
    animation: hm-spin 0.8s linear infinite;
  }
  @keyframes hm-spin { to { transform: rotate(360deg); } }

  /* Progress indicator */
  .hm-progress {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 0.5rem; margin-bottom: 2.25rem;
  }
  .hm-step { display: flex; flex-direction: column; align-items: center; flex: 1; position: relative; }
  .hm-step::after {
    content: ''; position: absolute; top: 1.1rem; left: 50%;
    width: calc(100% - 1.6rem); height: 2px;
    background: rgba(255,255,255,0.1); z-index: 0;
  }
  .hm-step:last-child::after { display: none; }
  .hm-step-circle {
    width: 2.25rem; height: 2.25rem; border-radius: 50%;
    background: rgba(255,255,255,0.06); color: var(--slate, #94a3b8);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 0.9rem; position: relative; z-index: 1;
    border: 1.5px solid rgba(255,255,255,0.1);
    transition: all 0.25s;
  }
  .hm-step.active .hm-step-circle { background: #b8860b; color: #fff; border-color: #b8860b; }
  .hm-step.done .hm-step-circle { background: rgba(184,134,11,0.25); color: #d4a017; border-color: rgba(184,134,11,0.4); }
  .hm-step-label {
    font-size: 0.78rem; color: var(--slate, #94a3b8); margin-top: 0.5rem;
    text-align: center; font-weight: 600;
  }
  .hm-step.active .hm-step-label { color: #d4a017; }

  /* Section heading */
  .hm-section { margin-bottom: 1.75rem; }
  .hm-section-heading {
    font-size: 1.25rem; font-weight: 800; color: var(--white, #fff); margin: 0 0 0.4rem;
  }
  .hm-section-desc { color: var(--slate, #94a3b8); font-size: 0.925rem; margin: 0 0 1.25rem; line-height: 1.6; }

  /* Choice cards (category / type) */
  .hm-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; }
  .hm-card {
    background: rgba(255,255,255,0.04);
    border: 1.5px solid rgba(255,255,255,0.1);
    border-radius: 12px; padding: 1.5rem;
    cursor: pointer; text-align: left; width: 100%; font-family: inherit; color: inherit;
    transition: border-color 0.15s, background 0.15s;
    display: flex; flex-direction: column; gap: 0.5rem;
  }
  .hm-card:hover, .hm-card:focus-visible {
    border-color: #b8860b; background: rgba(184,134,11,0.07); outline: none;
  }
  .hm-card.selected { border-color: #b8860b; background: rgba(184,134,11,0.1); }
  .hm-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; }
  .hm-card-title { font-size: 1.1rem; font-weight: 700; color: var(--white, #fff); }
  .hm-card-desc { font-size: 0.875rem; color: var(--slate, #94a3b8); line-height: 1.55; }
  .hm-card-details { font-size: 0.8rem; color: rgba(148,163,184,0.7); }

  /* Card badges */
  .hm-badge {
    display: inline-block; font-size: 0.68rem; font-weight: 700;
    padding: 0.25rem 0.6rem; border-radius: 20px;
    text-transform: uppercase; letter-spacing: 0.4px; white-space: nowrap;
    background: #b8860b; color: #fff; flex-shrink: 0;
  }
  .hm-badge.premium { background: #d4af37; color: #0B1929; }
  .hm-badge.basic { background: rgba(255,255,255,0.15); color: var(--slate, #94a3b8); }

  /* Option groups (impact / metal material) */
  .hm-options {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;
  }
  .hm-options-title { font-size: 1rem; font-weight: 700; color: var(--white, #fff); margin: 0 0 1.25rem; }
  .hm-options-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
  .hm-option {
    border: 1.5px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 1.1rem;
    cursor: pointer; text-align: left; width: 100%; font-family: inherit; color: inherit;
    background: rgba(255,255,255,0.02); transition: border-color 0.15s, background 0.15s;
  }
  .hm-option:hover, .hm-option:focus-visible { border-color: #b8860b; background: rgba(184,134,11,0.06); outline: none; }
  .hm-option.selected { border-color: #b8860b; background: rgba(184,134,11,0.1); }
  .hm-option-label { font-weight: 700; color: var(--white, #fff); margin-bottom: 0.35rem; font-size: 0.95rem; }
  .hm-option-desc { font-size: 0.825rem; color: var(--slate, #94a3b8); line-height: 1.5; }

  /* Designer product grid */
  .hm-mfr-group { margin-bottom: 1.75rem; }
  .hm-mfr-name {
    font-size: 0.85rem; font-weight: 800; color: #d4a017;
    margin: 0 0 0.75rem; padding-bottom: 0.5rem;
    border-bottom: 1.5px solid rgba(255,255,255,0.1);
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .hm-product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.85rem; }
  .hm-product {
    background: rgba(255,255,255,0.04); border: 1.5px solid rgba(255,255,255,0.1);
    border-radius: 10px; padding: 1.1rem; cursor: pointer; text-align: left;
    width: 100%; font-family: inherit; color: inherit;
    transition: border-color 0.15s, background 0.15s;
    display: flex; flex-direction: column; gap: 0.5rem;
  }
  .hm-product:hover, .hm-product:focus-visible { border-color: #b8860b; background: rgba(184,134,11,0.06); outline: none; }
  .hm-product.selected { border-color: #b8860b; background: rgba(184,134,11,0.1); }
  .hm-product-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; }
  .hm-product-name { font-size: 1rem; font-weight: 700; color: var(--white, #fff); }
  .hm-product-badges { display: flex; gap: 0.3rem; flex-shrink: 0; }
  .hm-product-badge {
    font-size: 0.62rem; font-weight: 700; padding: 0.18rem 0.45rem;
    border-radius: 10px; text-transform: uppercase; letter-spacing: 0.3px; white-space: nowrap;
  }
  .hm-product-badge.impact4 { background: #2d5016; color: #fff; }
  .hm-product-badge.impact3 { background: #5a7a3a; color: #fff; }
  .hm-product-badge.tier-mid { background: #b8860b; color: #fff; }
  .hm-product-badge.tier-premium { background: #8b6914; color: #fff; }
  .hm-product-desc { font-size: 0.825rem; color: var(--slate, #94a3b8); line-height: 1.5; }
  .hm-product-link { font-size: 0.8rem; color: #d4a017; text-decoration: none; font-weight: 700; align-self: flex-start; }
  .hm-product-link:hover { text-decoration: underline; }
  .hm-products-empty { color: var(--slate, #94a3b8); text-align: center; padding: 2rem; font-size: 0.9rem; }
  .hm-products-error { color: #fca5a5; text-align: center; padding: 2rem; font-size: 0.9rem; }

  /* Pricing guidance */
  .hm-pricing {
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px; padding: 1.5rem; margin: 1.5rem 0;
  }
  .hm-pricing-title { font-size: 0.95rem; font-weight: 700; color: var(--white, #fff); margin: 0 0 1rem; }
  .hm-pricing-items { display: grid; gap: 0.75rem; }
  .hm-pricing-item {
    display: flex; justify-content: space-between; align-items: center; gap: 1rem;
    padding: 0.85rem 1rem; background: rgba(255,255,255,0.03);
    border-radius: 8px; border-left: 3px solid #b8860b; flex-wrap: wrap;
  }
  .hm-pricing-name { font-weight: 700; color: var(--white, #fff); font-size: 0.9rem; }
  .hm-pricing-value { color: var(--slate, #94a3b8); font-size: 0.85rem; font-style: italic; }

  /* Confirmation */
  .hm-confirm {
    background: linear-gradient(135deg, rgba(13,27,46,0.85) 0%, rgba(0,51,102,0.55) 100%);
    border: 1px solid rgba(184,134,11,0.3);
    border-radius: 12px; padding: 1.75rem; margin-bottom: 2rem;
  }
  .hm-confirm-title { font-size: 1.25rem; font-weight: 800; color: var(--white, #fff); margin: 0 0 1rem; }
  .hm-confirm-summary {
    background: rgba(255,255,255,0.06); border-left: 3px solid #b8860b;
    padding: 1.25rem; border-radius: 8px; margin-bottom: 1.5rem;
    display: grid; gap: 0.6rem;
  }
  .hm-confirm-row { display: flex; gap: 1rem; align-items: flex-start; }
  .hm-confirm-label { font-weight: 700; min-width: 96px; color: #d4a017; font-size: 0.9rem; }
  .hm-confirm-value { color: var(--white, #fff); font-size: 0.9rem; }
  .hm-confirm-btn {
    background: #b8860b; color: #fff; border: none;
    padding: 0.9rem 2rem; font-size: 0.95rem; font-weight: 800; border-radius: 8px;
    cursor: pointer; width: 100%; font-family: inherit; transition: background 0.15s, opacity 0.15s;
  }
  .hm-confirm-btn:hover:not(:disabled) { background: #d4a017; }
  .hm-confirm-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Status messages */
  .hm-status { padding: 0.85rem 1.25rem; border-radius: 8px; font-size: 0.9rem; font-weight: 600; margin-bottom: 1.25rem; }
  .hm-status.error { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.25); color: #fca5a5; }
  .hm-status.success { background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.25); color: #86efac; }

  /* Info note */
  .hm-note {
    background: rgba(255,255,255,0.04); border-left: 3px solid #b8860b;
    border-radius: 0 8px 8px 0; padding: 0.9rem 1.25rem; margin-bottom: 1.5rem;
    font-size: 0.875rem; color: var(--slate, #94a3b8); line-height: 1.6;
  }
  .hm-note strong { color: var(--white, #fff); }

  /* Success screen */
  .hm-success { text-align: center; padding: 2.5rem 1rem; }
  .hm-success-icon { font-size: 3rem; display: block; margin-bottom: 1rem; color: #22c55e; }
  .hm-success h2 { font-size: 1.5rem; font-weight: 800; color: var(--white, #fff); margin: 0 0 0.75rem; }
  .hm-success p { color: var(--slate, #94a3b8); font-size: 0.95rem; line-height: 1.65; max-width: 460px; margin: 0 auto 1.5rem; }
  .hm-success-link {
    display: inline-flex; align-items: center; justify-content: center;
    background: #b8860b; color: #fff; text-decoration: none;
    padding: 0.75rem 1.75rem; border-radius: 8px; font-weight: 700; font-size: 0.9rem;
  }
  .hm-success-link:hover { background: #d4a017; }

  @media (max-width: 600px) {
    .oqh-mat { padding: 1.25rem 1rem 3rem; }
    .hm-cards, .hm-options-grid, .hm-product-grid { grid-template-columns: 1fr; }
    .hm-step::after { display: none; }
    .hm-title { font-size: 1.4rem; }
  }
`;
