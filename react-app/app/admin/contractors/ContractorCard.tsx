'use client';

/**
 * One contractor card (port of the renderContractors() per-row markup,
 * admin-contractors.html:1015–1200) — the §6.1 Phase-8 XSS site.
 *
 * The static version built an HTML string and interpolated contractor-controlled
 * values (company_name, contact_name, email, admin_notes, license fields …) both as
 * text AND inside onclick="…('${c.company_name}')" handlers — a quote in a value
 * broke out and injected JS. This port closes that inherently:
 *   • every DB/user value is rendered as JSX text (React-escaped) — no innerHTML;
 *   • every action is a React onClick closure over the contractor object — no
 *     string-built handler, nothing interpolated into markup.
 */

import { useState } from 'react';
import type { Contractor } from './utils';
import {
  statusLabel,
  formatAppliedDate,
  coiHeaderBadge,
  showPcTemplateBadge,
  showNoAttestationBadge,
  deriveServiceStates,
  profileChecklist,
} from './utils';
import { DocumentSubCards } from './DocumentSubCards';

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString() : '';
}

function HeaderCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="oqac-header-cell">
      <div className="oqac-header-cell-label">{label}</div>
      <div className="oqac-header-cell-value">{value}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="oqac-info-row">
      <div className="oqac-info-label">{label}</div>
      <div className="oqac-info-value">{value}</div>
    </div>
  );
}

export interface ContractorCardProps {
  contractor: Contractor;
  expanded: boolean;
  onToggleExpand: () => void;
  onMarkLicenseVerified: (c: Contractor) => void;
  onSearchLicenseBoard: (c: Contractor) => void;
  onRequestInsurance: (c: Contractor) => void;
  onMarkInsuranceVerified: (c: Contractor) => void;
  onSaveNotes: (c: Contractor, notes: string) => Promise<boolean>;
  onApprove: (c: Contractor) => void;
  onReject: (c: Contractor) => void;
  now?: Date;
}

export function ContractorCard({
  contractor: c,
  expanded,
  onToggleExpand,
  onMarkLicenseVerified,
  onSearchLicenseBoard,
  onRequestInsurance,
  onMarkInsuranceVerified,
  onSaveNotes,
  onApprove,
  onReject,
  now,
}: ContractorCardProps) {
  const isPending = c.status === 'pending_approval';
  const trades = c.trades || [];
  const coiBadge = coiHeaderBadge(c, now);
  const states = deriveServiceStates(c);
  const checklist = profileChecklist(c);
  const licenses = c.contractor_licenses || [];

  const [notes, setNotes] = useState<string>(c.admin_notes || '');
  const [notesStatus, setNotesStatus] = useState<{ msg: string; ok: boolean } | null>(null);

  async function saveNotes() {
    const ok = await onSaveNotes(c, notes);
    if (ok) {
      setNotesStatus({ msg: 'Notes saved ✓', ok: true });
      setTimeout(() => setNotesStatus(null), 3000);
    } else {
      setNotesStatus({ msg: 'Failed to save notes', ok: false });
    }
  }

  return (
    <div className="oqac-card">
      <div
        className="oqac-card-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand();
          }
        }}
      >
        <div className="oqac-header-left">
          <HeaderCell label="Company" value={c.company_name || '—'} />
          <HeaderCell label="Owner" value={c.contact_name || '—'} />
          <HeaderCell label="Email" value={c.email || '—'} />
          <HeaderCell label="Applied" value={formatAppliedDate(c.created_at)} />
        </div>
        <div className="oqac-header-badges">
          <span className={'oqac-status-badge oqac-status-' + c.status}>{statusLabel(c.status)}</span>
          {trades.map((t, i) => (
            <span className="oqac-trade-badge" key={i}>
              {t}
            </span>
          ))}
          {showPcTemplateBadge(c) && <span className="oqac-warn-badge oqac-warn-amber">⚠️ PC Template</span>}
          {coiBadge && (
            <span
              className="oqac-warn-badge"
              style={{ background: coiBadge.bg, color: coiBadge.color, border: '1px solid ' + coiBadge.border }}
            >
              {coiBadge.text}
            </span>
          )}
          {showNoAttestationBadge(c) && <span className="oqac-warn-badge oqac-warn-red">⚠️ No Attestation</span>}
          <span className="oqac-caret">▼</span>
        </div>
      </div>

      <DocumentSubCards contractor={c} />

      <div className={'oqac-card-body' + (expanded ? ' is-expanded' : '')}>
        {/* Contact Information */}
        <section className="oqac-section">
          <div className="oqac-section-title">Contact Information</div>
          <InfoRow label="Email" value={<a href={'mailto:' + (c.email || '')}>{c.email || '—'}</a>} />
          <InfoRow label="Phone" value={c.phone || '—'} />
          <InfoRow label="Company" value={c.company_name || '—'} />
          <InfoRow label="Owner" value={c.contact_name || '—'} />
        </section>

        {/* Service Area */}
        <section className="oqac-section">
          <div className="oqac-section-title">Service Area</div>
          <InfoRow label="Counties" value={(c.service_counties || []).join(', ') || '—'} />
          <InfoRow label="States" value={states.join(', ') || '—'} />
        </section>

        {/* Profile Completeness */}
        <section className="oqac-section">
          <div className="oqac-section-title">Profile Completeness</div>
          <div className="oqac-checklist">
            {checklist.map((item) => (
              <div className="oqac-checklist-item" key={item.label}>
                <div className="oqac-checklist-icon">{item.done ? '✅' : '⬜'}</div>
                <div>{item.label}</div>
              </div>
            ))}
          </div>
        </section>

        {/* License Verification */}
        <section className="oqac-section">
          <div className="oqac-section-title">License Verification</div>
          {licenses.length > 0 ? (
            <>
              {licenses.map((lic) => (
                <div className="oqac-license-record" key={lic.id}>
                  <div className="oqac-license-info">
                    <div className="oqac-license-muni">{lic.municipality || 'Unknown Municipality'}</div>
                    <div className="oqac-license-num">License #{lic.license_number || 'N/A'}</div>
                  </div>
                </div>
              ))}
              <div className="oqac-status-line">
                Status: {c.license_verified ? '✅ Verified ' + fmtDate(c.license_verified_at) : 'Not verified'}
              </div>
            </>
          ) : (
            <p className="oqac-muted">No license records submitted</p>
          )}
          <div className="oqac-button-row">
            <button type="button" className="oqac-btn-sm" onClick={() => onSearchLicenseBoard(c)}>
              Search State License Board
            </button>
            {!c.license_verified && (
              <button type="button" className="oqac-btn-sm oqac-btn-sm-primary" onClick={() => onMarkLicenseVerified(c)}>
                Mark as Verified ✓
              </button>
            )}
          </div>
        </section>

        {/* Insurance Verification */}
        <section className="oqac-section">
          <div className="oqac-section-title">Insurance Verification</div>
          <InfoRow label="Workers Comp" value={c.workers_comp_carrier || '—'} />
          <InfoRow label="General Liability" value={c.general_liability_carrier || '—'} />
          <div className="oqac-status-line">
            Status:{' '}
            {c.insurance_verified
              ? '✅ Verified ' + fmtDate(c.insurance_verified_at)
              : c.insurance_verification_sent_at
                ? 'Email sent ' + fmtDate(c.insurance_verification_sent_at)
                : 'Not verified'}
          </div>
          <div className="oqac-button-row">
            <button type="button" className="oqac-btn-sm" onClick={() => onRequestInsurance(c)}>
              Request Verification Email
            </button>
            {!c.insurance_verified && (
              <button
                type="button"
                className="oqac-btn-sm oqac-btn-sm-primary"
                onClick={() => onMarkInsuranceVerified(c)}
              >
                Mark as Verified ✓
              </button>
            )}
          </div>
        </section>

        {/* Admin Notes */}
        <div className="oqac-notes">
          <div className="oqac-notes-label">Admin Notes</div>
          <textarea
            className="oqac-notes-textarea"
            placeholder="Add internal notes about this contractor..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <button type="button" className="oqac-notes-btn" onClick={saveNotes}>
            Save Notes
          </button>
          {notesStatus && (
            <div
              className="oqac-notes-status"
              style={{ color: notesStatus.ok ? 'var(--green,#10B981)' : 'var(--red,#EF4444)' }}
            >
              {notesStatus.msg}
            </div>
          )}
        </div>

        {/* Actions — pending only */}
        {isPending && (
          <div className="oqac-actions-final">
            <button type="button" className="oqac-btn-action oqac-btn-approve" onClick={() => onApprove(c)}>
              ✓ Approve Contractor
            </button>
            <button type="button" className="oqac-btn-action oqac-btn-reject" onClick={() => onReject(c)}>
              ✗ Reject Application
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
