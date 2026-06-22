export const HELP_ESTIMATE_CSS = `
  .oqh-help {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
    font-family: inherit;
  }

  /* Header */
  .he-header {
    margin-bottom: 2rem;
  }
  .he-back {
    display: inline-block;
    color: var(--slate, #94a3b8);
    text-decoration: none;
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    transition: color 0.15s;
  }
  .he-back:hover {
    color: var(--white, #fff);
  }
  .he-title {
    font-size: 1.75rem;
    font-weight: 800;
    color: var(--white, #fff);
    margin: 0 0 0.25rem;
  }
  .he-subtitle {
    color: var(--slate, #94a3b8);
    font-size: 1rem;
    margin: 0;
  }

  /* Spinner */
  .he-spinner {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
  }
  .he-spinner-ring {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(184,134,11,0.2);
    border-top-color: #b8860b;
    border-radius: 50%;
    animation: he-spin 0.8s linear infinite;
  }
  @keyframes he-spin { to { transform: rotate(360deg); } }

  /* Triage cards */
  .he-triage-question {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--white, #fff);
    margin-bottom: 1.25rem;
  }
  .he-triage-cards {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }
  .he-triage-card {
    background: rgba(255,255,255,0.04);
    border: 1.5px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 1.25rem 1.5rem;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s, background 0.15s;
    width: 100%;
    font-family: inherit;
    color: inherit;
  }
  .he-triage-card:hover,
  .he-triage-card:focus-visible {
    border-color: #b8860b;
    background: rgba(184,134,11,0.07);
    outline: none;
  }
  .he-triage-card h3 {
    margin: 0 0 0.3rem;
    font-size: 1rem;
    font-weight: 700;
    color: var(--white, #fff);
  }
  .he-triage-card p {
    margin: 0;
    font-size: 0.875rem;
    color: var(--slate, #94a3b8);
    line-height: 1.5;
  }

  /* Section cards */
  .he-section-card {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 1.75rem;
    margin-bottom: 1.5rem;
  }
  .he-section-heading {
    font-size: 1.2rem;
    font-weight: 800;
    color: var(--white, #fff);
    margin: 0 0 0.5rem;
  }
  .he-section-intro {
    color: var(--slate, #94a3b8);
    font-size: 0.925rem;
    margin: 0 0 1.25rem;
    line-height: 1.6;
  }

  /* Carrier tips */
  .he-carrier-tips {
    background: rgba(184,134,11,0.08);
    border: 1px solid rgba(184,134,11,0.25);
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.25rem;
  }
  .he-carrier-tips h4 {
    margin: 0 0 0.75rem;
    font-size: 0.95rem;
    font-weight: 700;
    color: #b8860b;
  }
  .he-carrier-tips ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .he-carrier-tips li {
    padding: 0.35rem 0 0.35rem 1.5rem;
    position: relative;
    font-size: 0.9rem;
    color: var(--slate, #94a3b8);
    line-height: 1.55;
  }
  .he-carrier-tips li::before {
    content: "→";
    position: absolute;
    left: 0;
    color: #b8860b;
  }
  .he-carrier-tips a {
    color: #b8860b;
    text-decoration: underline;
  }
  .he-carrier-tips a:hover {
    color: #d4a017;
  }

  /* General tips list */
  .he-tips-list {
    padding-left: 1.5rem;
    margin: 0 0 1.25rem;
    color: var(--slate, #94a3b8);
    font-size: 0.9rem;
    line-height: 1.7;
  }
  .he-tips-list li {
    margin-bottom: 0.4rem;
  }

  /* Form */
  .he-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  .he-form-full {
    grid-column: 1 / -1;
  }
  .he-field-label {
    display: block;
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--slate, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 0.4rem;
  }
  .he-input {
    width: 100%;
    box-sizing: border-box;
    background: rgba(255,255,255,0.06);
    border: 1.5px solid rgba(255,255,255,0.12);
    border-radius: 8px;
    padding: 0.65rem 0.9rem;
    color: var(--white, #fff);
    font-size: 0.925rem;
    font-family: inherit;
    transition: border-color 0.15s;
    outline: none;
  }
  .he-input:focus {
    border-color: #b8860b;
  }
  .he-input::placeholder {
    color: rgba(148,163,184,0.5);
  }

  /* Preview */
  .he-preview {
    background: rgba(13,27,46,0.6);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    overflow: hidden;
    margin-bottom: 1rem;
  }
  .he-preview-header {
    padding: 0.85rem 1.25rem;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    background: rgba(255,255,255,0.03);
  }
  .he-preview-row {
    display: flex;
    gap: 0.5rem;
    font-size: 0.85rem;
    margin-bottom: 0.25rem;
    color: var(--slate, #94a3b8);
  }
  .he-preview-row:last-child {
    margin-bottom: 0;
  }
  .he-preview-label {
    font-weight: 700;
    color: rgba(148,163,184,0.7);
    min-width: 52px;
  }
  .he-preview-value {
    color: var(--white, #fff);
  }
  .he-preview-body {
    padding: 1rem 1.25rem;
  }
  .he-preview-textarea {
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    border: none;
    color: var(--slate, #94a3b8);
    font-size: 0.85rem;
    font-family: inherit;
    line-height: 1.6;
    resize: none;
    outline: none;
    min-height: 140px;
  }

  /* Checkbox row */
  .he-checkbox-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
    cursor: pointer;
    font-size: 0.9rem;
    color: var(--slate, #94a3b8);
    line-height: 1.5;
  }
  .he-checkbox-row input[type="checkbox"] {
    margin-top: 2px;
    accent-color: #b8860b;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    cursor: pointer;
  }

  /* Buttons */
  .he-btn-row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 1.25rem;
  }
  .he-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.7rem 1.5rem;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 700;
    font-family: inherit;
    cursor: pointer;
    border: none;
    transition: opacity 0.15s, background 0.15s;
    text-decoration: none;
  }
  .he-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .he-btn-amber {
    background: #b8860b;
    color: #fff;
  }
  .he-btn-amber:hover:not(:disabled) {
    background: #d4a017;
  }
  .he-btn-outline {
    background: transparent;
    color: var(--slate, #94a3b8);
    border: 1.5px solid rgba(255,255,255,0.15);
  }
  .he-btn-outline:hover:not(:disabled) {
    color: var(--white, #fff);
    border-color: rgba(255,255,255,0.3);
  }

  /* Info callout */
  .he-info-callout {
    background: rgba(255,255,255,0.04);
    border-left: 3px solid #b8860b;
    border-radius: 0 8px 8px 0;
    padding: 0.9rem 1.25rem;
    margin-bottom: 1.25rem;
    font-size: 0.9rem;
    color: var(--slate, #94a3b8);
    line-height: 1.6;
  }
  .he-info-callout strong {
    color: var(--white, #fff);
  }

  /* Follow-up note */
  .he-followup {
    font-size: 0.825rem;
    color: rgba(148,163,184,0.7);
    line-height: 1.55;
    margin-bottom: 0.5rem;
  }

  /* Status messages */
  .he-status {
    padding: 0.85rem 1.25rem;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }
  .he-status.error {
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.25);
    color: #fca5a5;
  }
  .he-status.success {
    background: rgba(34,197,94,0.1);
    border: 1px solid rgba(34,197,94,0.25);
    color: #86efac;
  }

  /* Success section */
  .he-success {
    text-align: center;
    padding: 2.5rem 1rem;
  }
  .he-success-icon {
    font-size: 3rem;
    display: block;
    margin-bottom: 1rem;
    color: #22c55e;
  }
  .he-success h2 {
    font-size: 1.5rem;
    font-weight: 800;
    color: var(--white, #fff);
    margin: 0 0 0.75rem;
  }
  .he-success p {
    color: var(--slate, #94a3b8);
    font-size: 0.95rem;
    line-height: 1.65;
    max-width: 480px;
    margin: 0 auto 0.75rem;
  }
  .he-success-followup {
    font-size: 0.85rem;
    color: rgba(148,163,184,0.6);
    margin: 0.25rem auto 1.75rem;
    max-width: 460px;
  }

  /* Explainer sections */
  .he-explainer-section {
    margin-bottom: 1.5rem;
  }
  .he-explainer-section h3 {
    font-size: 1rem;
    font-weight: 700;
    color: var(--white, #fff);
    margin: 0 0 0.5rem;
  }
  .he-explainer-section p {
    font-size: 0.9rem;
    color: var(--slate, #94a3b8);
    line-height: 1.65;
    margin: 0 0 0.5rem;
  }

  @media (max-width: 600px) {
    .oqh-help { padding: 1.25rem 1rem 3rem; }
    .he-form { grid-template-columns: 1fr; }
    .he-btn-row { flex-direction: column; }
    .he-btn { width: 100%; justify-content: center; }
    .he-title { font-size: 1.4rem; }
  }
`;
