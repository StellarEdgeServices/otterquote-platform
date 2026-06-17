'use client';

/**
 * The three admin-action modals (port of the static #rejectModal / #insuranceModal /
 * #approveConfirmModal + their submit handlers). React state-driven: each modal owns
 * its input + inline validation/error; the async work + the EF/RPC contracts live in
 * the page, passed in via onSubmit which resolves to an error string (shown inline) or
 * null on success (page closes the modal). All contractor-controlled values render as
 * JSX text — no innerHTML (§6.1 XSS fold).
 */

import { useState } from 'react';
import type { Contractor } from './utils';

function ModalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="oqac-modal-overlay" role="dialog" aria-modal="true">
      <div className="oqac-modal">
        <div className="oqac-modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

// ── Reject ─────────────────────────────────────────────────────────────────
export function RejectModal({
  contractor,
  onSubmit,
  onClose,
}: {
  contractor: Contractor;
  onSubmit: (reason: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const r = reason.trim();
    if (!r) {
      setError('Please provide a reason for rejection');
      return;
    }
    setError(null);
    setBusy(true);
    const err = await onSubmit(r);
    setBusy(false);
    if (err) setError(err);
  }

  return (
    <ModalShell title="Reject Application">
      <div className="oqac-modal-field">
        <label className="oqac-modal-label">Company Name</label>
        <div className="oqac-modal-readonly">{contractor.company_name || contractor.id}</div>
      </div>
      <div className="oqac-modal-field">
        <label className="oqac-modal-label" htmlFor="oqac-reject-reason">
          Reason for Rejection
        </label>
        <textarea
          id="oqac-reject-reason"
          className="oqac-modal-textarea"
          placeholder="e.g., Missing documentation, Insurance not current, License verification failed..."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && <div className="oqac-modal-error">{error}</div>}
      </div>
      <div className="oqac-modal-buttons">
        <button type="button" className="oqac-modal-btn oqac-modal-btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="oqac-modal-btn oqac-modal-btn-primary" onClick={submit} disabled={busy}>
          Reject Application
        </button>
      </div>
    </ModalShell>
  );
}

// ── Insurance verification ───────────────────────────────────────────────────
export function InsuranceModal({
  contractor,
  onSubmit,
  onClose,
}: {
  contractor: Contractor;
  onSubmit: (brokerEmail: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [brokerEmail, setBrokerEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const email = brokerEmail.trim();
    if (!email) {
      setError('Email is required');
      return;
    }
    setError(null);
    setBusy(true);
    const err = await onSubmit(email);
    setBusy(false);
    if (err) setError(err);
  }

  return (
    <ModalShell title="Request Insurance Verification">
      <div className="oqac-modal-field">
        <label className="oqac-modal-label" htmlFor="oqac-broker-email">
          Broker Email
        </label>
        <input
          id="oqac-broker-email"
          type="email"
          className="oqac-modal-input"
          placeholder="insurance-broker@example.com"
          value={brokerEmail}
          onChange={(e) => setBrokerEmail(e.target.value)}
        />
        {error && <div className="oqac-modal-error">{error}</div>}
      </div>
      <div className="oqac-modal-field">
        <label className="oqac-modal-label">Company Name</label>
        <div className="oqac-modal-readonly">{contractor.company_name || '—'}</div>
      </div>
      <div className="oqac-modal-buttons">
        <button type="button" className="oqac-modal-btn oqac-modal-btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="oqac-modal-btn oqac-modal-btn-primary" onClick={submit} disabled={busy}>
          Send Verification Email
        </button>
      </div>
    </ModalShell>
  );
}

// ── Approve confirmation (D-210 contractor_has_required_docs gate lives in onSubmit) ──
export function ApproveConfirmModal({
  contractor,
  onSubmit,
  onClose,
}: {
  contractor: Contractor;
  onSubmit: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    const err = await onSubmit();
    setBusy(false);
    if (err) setError(err);
  }

  return (
    <ModalShell title="Approve Contractor">
      <p className="oqac-modal-text">
        Approve <strong>{contractor.company_name}</strong>? This will activate their account and send them a welcome
        email.
      </p>
      {error && <div className="oqac-modal-error">{error}</div>}
      <div className="oqac-modal-buttons">
        <button type="button" className="oqac-modal-btn oqac-modal-btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="oqac-modal-btn oqac-modal-btn-primary" onClick={submit} disabled={busy}>
          Confirm Approval
        </button>
      </div>
    </ModalShell>
  );
}
