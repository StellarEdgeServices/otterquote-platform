/**
 * repair-intake (H9) styles — dark homeowner-shell theme (var(--white),
 * var(--slate), amber), matching the H1/H2/H7/H8 React look. Pixel parity with
 * the light static page is NOT required (same standard as the siblings);
 * behaviour parity is. Class prefix `ri-`.
 */
export const REPAIR_INTAKE_CSS = `
  .ri-wrap {
    max-width: 820px;
    margin: 0 auto;
    padding: 2rem 1.5rem 6rem;
    font-family: inherit;
  }

  /* Disclaimer banner */
  .ri-disclaimer {
    background: linear-gradient(135deg, #FB923C 0%, #F97316 100%);
    border-left: 6px solid #D97706;
    padding: 1.75rem;
    margin-bottom: 1.75rem;
    border-radius: 10px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.15);
  }
  .ri-disclaimer h2 {
    font-size: 1.4rem;
    color: #fff;
    margin: 0 0 0.6rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    line-height: 1.3;
  }
  .ri-disclaimer .ri-otter { font-size: 1.75rem; }
  .ri-disclaimer .ri-sub { color: rgba(255,255,255,0.95); font-style: italic; margin: 0 0 0.75rem; }
  .ri-disclaimer p { color: rgba(255,255,255,0.92); font-size: 0.95rem; margin: 0; line-height: 1.6; }

  /* Section container */
  .ri-section {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 1.75rem;
    margin-bottom: 1.5rem;
  }
  .ri-section h2 {
    font-size: 1.3rem;
    color: var(--white, #fff);
    margin: 0 0 0.4rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .ri-section .ri-subtitle { color: var(--slate, #94a3b8); margin: 0 0 1.25rem; font-size: 0.95rem; }

  /* Repair-type cards */
  .ri-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1rem;
  }
  .ri-card {
    border: 2px solid rgba(255,255,255,0.12);
    border-radius: 10px;
    padding: 1.4rem 1rem;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
    background: rgba(255,255,255,0.02);
    font-family: inherit;
    color: var(--white, #fff);
  }
  .ri-card:hover { border-color: var(--amber, #E07B00); background: rgba(224,123,0,0.08); }
  .ri-card.selected { border-color: var(--amber, #E07B00); background: rgba(224,123,0,0.14); box-shadow: 0 4px 12px rgba(224,123,0,0.2); }
  .ri-card .ri-icon { font-size: 2.25rem; display: block; margin-bottom: 0.5rem; }
  .ri-card .ri-card-title { font-weight: 700; color: var(--white, #fff); margin-bottom: 0.35rem; }
  .ri-card .ri-card-desc { font-size: 0.83rem; color: var(--slate, #94a3b8); }

  /* Inputs */
  .ri-input, .ri-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.7rem 0.85rem;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    background: rgba(255,255,255,0.04);
    color: var(--white, #fff);
    font-family: inherit;
    font-size: 0.95rem;
    margin-bottom: 0.75rem;
  }
  .ri-textarea { resize: vertical; min-height: 90px; }
  .ri-input:focus, .ri-textarea:focus {
    outline: none;
    border-color: var(--amber, #E07B00);
    box-shadow: 0 0 0 3px rgba(224,123,0,0.18);
  }
  .ri-field-label { display: block; font-size: 0.9rem; font-weight: 600; color: var(--white, #fff); margin: 0.5rem 0 0.4rem; }

  /* Photo instructions */
  .ri-instructions { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1.25rem; }
  .ri-instruction {
    padding: 0.65rem 0.85rem;
    background: rgba(255,255,255,0.04);
    border-left: 3px solid var(--amber, #E07B00);
    border-radius: 6px;
    font-size: 0.9rem;
    color: var(--white, #fff);
  }

  /* Upload zone */
  .ri-upload-zone {
    border: 2px dashed rgba(255,255,255,0.18);
    border-radius: 10px;
    padding: 1.75rem 1rem;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    background: rgba(255,255,255,0.02);
    margin-bottom: 0.75rem;
  }
  .ri-upload-zone:hover, .ri-upload-zone.dragover { border-color: var(--amber, #E07B00); background: rgba(224,123,0,0.08); }
  .ri-upload-zone .ri-up-emoji { font-size: 2rem; display: block; margin-bottom: 0.4rem; }
  .ri-upload-zone p { color: var(--slate, #94a3b8); margin: 0.15rem 0; font-size: 0.9rem; }
  .ri-upload-zone p strong { color: var(--white, #fff); }
  .ri-file-input { display: none; }

  /* Thumbnails */
  .ri-thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 0.75rem; margin-bottom: 0.75rem; }
  .ri-thumb {
    position: relative;
    aspect-ratio: 1;
    border-radius: 8px;
    overflow: hidden;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.1);
    display: flex; align-items: center; justify-content: center;
  }
  .ri-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .ri-thumb .ri-doc { font-size: 0.7rem; color: var(--slate, #94a3b8); padding: 0.4rem; text-align: center; word-break: break-word; }
  .ri-thumb .ri-doc .ri-doc-icon { font-size: 1.6rem; display: block; }
  .ri-thumb .ri-remove {
    position: absolute; top: 4px; right: 4px;
    background: rgba(0,0,0,0.65); color: #fff; border: none; border-radius: 50%;
    width: 24px; height: 24px; font-size: 0.95rem; cursor: pointer; line-height: 1;
    display: flex; align-items: center; justify-content: center;
  }
  .ri-thumb .ri-remove:hover { background: rgba(0,0,0,0.85); }

  /* Validation errors */
  .ri-errors { list-style: none; padding: 0; margin: 0 0 0.75rem; }
  .ri-errors li {
    background: rgba(239,68,68,0.12);
    border-left: 3px solid #ef4444;
    color: #fca5a5;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.85rem;
    margin-bottom: 0.4rem;
  }

  /* Accordions (material tiers) */
  .ri-accordion { border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; margin-bottom: 1rem; overflow: hidden; }
  .ri-acc-header {
    background: rgba(255,255,255,0.04);
    padding: 1.1rem 1.25rem;
    cursor: pointer;
    display: flex; justify-content: space-between; align-items: center;
    font-weight: 600; color: var(--white, #fff);
    border: none; width: 100%; text-align: left; font-family: inherit; font-size: 0.98rem;
  }
  .ri-acc-header:hover { background: rgba(255,255,255,0.07); }
  .ri-acc-header.open { background: rgba(224,123,0,0.1); border-bottom: 2px solid var(--amber, #E07B00); }
  .ri-acc-toggle { font-size: 1.1rem; transition: transform 0.2s; }
  .ri-acc-header.open .ri-acc-toggle { transform: rotate(180deg); }
  .ri-acc-content { padding: 1.25rem; border-top: 1px solid rgba(255,255,255,0.08); }
  .ri-acc-content p { margin: 0 0 0.75rem; color: var(--slate, #cbd5e1); font-size: 0.92rem; }
  .ri-acc-content p strong { color: var(--white, #fff); }

  .ri-checklist { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1rem; }
  .ri-check-item { display: flex; align-items: center; gap: 0.6rem; color: var(--white, #fff); font-size: 0.9rem; }
  .ri-check-item input { width: auto; margin: 0; }

  .ri-mat-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.85rem; margin-bottom: 0.5rem; }

  .ri-tier-price {
    display: inline-block;
    background: rgba(224,123,0,0.16);
    color: var(--amber, #E07B00);
    padding: 0.15rem 0.6rem;
    border-radius: 5px;
    font-size: 0.78rem;
    font-weight: 700;
    margin-left: 0.4rem;
  }
  .ri-coming-soon {
    background: rgba(224,123,0,0.1);
    border-left: 3px solid var(--amber, #E07B00);
    padding: 0.7rem 0.9rem;
    border-radius: 6px;
    margin-bottom: 1rem;
    color: var(--white, #fff);
    font-size: 0.9rem;
  }
  .ri-itel-address {
    background: rgba(255,255,255,0.04);
    padding: 0.9rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    font-size: 0.88rem;
    color: var(--slate, #cbd5e1);
  }
  .ri-itel-note { background: rgba(34,197,94,0.1); border-left: 3px solid #22C55E; padding: 0.65rem 0.85rem; border-radius: 6px; color: #86efac; font-size: 0.85rem; }

  /* Buttons */
  .ri-btn {
    display: inline-block;
    padding: 0.7rem 1.4rem;
    border: none;
    border-radius: 8px;
    font-family: inherit;
    font-size: 0.95rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s, box-shadow 0.15s;
    text-decoration: none;
  }
  .ri-btn-primary { background: var(--amber, #E07B00); color: #1a1207; }
  .ri-btn-primary:hover:not(:disabled) { background: #f59324; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(224,123,0,0.3); }
  .ri-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

  /* Contractor list */
  .ri-contractor {
    padding: 1.1rem 1.25rem;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    margin-bottom: 0.85rem;
    background: rgba(255,255,255,0.03);
  }
  .ri-contractor-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; }
  .ri-contractor-name { font-size: 1.02rem; font-weight: 700; color: var(--white, #fff); }
  .ri-contractor-years { margin-left: 0.6rem; font-size: 0.82rem; color: var(--slate, #94a3b8); font-weight: 500; }
  .ri-contractor-rating { background: rgba(224,123,0,0.16); color: var(--amber, #E07B00); padding: 0.2rem 0.65rem; border-radius: 5px; font-size: 0.82rem; font-weight: 700; white-space: nowrap; }
  .ri-contractor-repairs { margin: 0.5rem 0 0; font-size: 0.83rem; color: #86efac; }
  .ri-empty-contractors {
    padding: 1.25rem;
    background: rgba(224,123,0,0.08);
    border-left: 3px solid var(--amber, #E07B00);
    border-radius: 8px;
    color: var(--white, #fff);
  }
  .ri-empty-contractors p { margin: 0.5rem 0 0; font-size: 0.88rem; color: var(--slate, #cbd5e1); }
  .ri-loading-contractors { color: var(--slate, #94a3b8); }

  /* Submit summary */
  .ri-summary {
    background: rgba(255,255,255,0.04);
    padding: 1.25rem;
    border-radius: 8px;
    margin-bottom: 1.25rem;
    border-left: 4px solid var(--amber, #E07B00);
  }
  .ri-summary-item { display: flex; justify-content: space-between; margin-bottom: 0.6rem; font-size: 0.92rem; }
  .ri-summary-item:last-child { margin-bottom: 0; }
  .ri-summary-item .ri-sum-label { font-weight: 600; color: var(--white, #fff); }
  .ri-summary-item .ri-sum-value { color: var(--slate, #94a3b8); }
  .ri-summary-item.complete .ri-sum-value { color: #22C55E; font-weight: 600; }

  .ri-submit-error {
    background: rgba(239,68,68,0.12);
    border-left: 3px solid #ef4444;
    color: #fca5a5;
    padding: 0.7rem 0.9rem;
    border-radius: 6px;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }

  @media (max-width: 768px) {
    .ri-cards { grid-template-columns: 1fr; }
    .ri-mat-fields { grid-template-columns: 1fr; }
    .ri-section, .ri-disclaimer { padding: 1.25rem; }
  }
`;
