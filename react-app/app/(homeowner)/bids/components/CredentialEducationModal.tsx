'use client';

/**
 * #534 credential-education popup — GC-locked copy (see ./copy.ts) plus the
 * D-218 per-contractor license drill-down. Opened from either credential chip
 * on a bid card. React parity of the bids.html credentialEducationModal.
 */

import {
  CREDENTIAL_EDUCATION_CLOSING,
  CREDENTIAL_EDUCATION_SECTIONS,
  CREDENTIAL_EDUCATION_TITLE,
  LICENSE_NOT_PROVIDED_LINE,
} from '../copy';
import { licenseDocState } from '../utils';
import type { ContractorProfile, PublicLicense } from '../types';

function formatLicDate(d: string): string {
  const parsed = new Date(d);
  return isNaN(parsed.getTime())
    ? d
    : parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

interface CredentialEducationModalProps {
  contractor: ContractorProfile;
  licenses: PublicLicense[];
  onClose: () => void;
}

export function CredentialEducationModal({
  contractor,
  licenses,
  onClose,
}: CredentialEducationModalProps) {
  const hasDoc = licenses.length > 0 || licenseDocState(contractor.license_path) === 'uploaded';

  return (
    <div
      className="oqb-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="oqb-edu-card" role="dialog" aria-modal="true" aria-labelledby="oqb-edu-title">
        <div className="oqb-edu-head">
          <h3 id="oqb-edu-title" className="oqb-modal-title">
            {CREDENTIAL_EDUCATION_TITLE}
          </h3>
          <button type="button" className="oqb-edu-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="oqb-edu-body">
          {CREDENTIAL_EDUCATION_SECTIONS.map((s) => (
            <p key={s.lead}>
              <strong>{s.lead}</strong> {s.body}
            </p>
          ))}
          <p>{CREDENTIAL_EDUCATION_CLOSING}</p>
        </div>

        <div className="oqb-edu-licenses">
          <h4>{contractor.company_name || 'This contractor'} — licensing</h4>
          {licenses.length > 0 ? (
            licenses.map((lic, i) => {
              const jur = [lic.jurisdiction_level, lic.municipality].filter(Boolean).join(' — ');
              return (
                <div className="oqb-edu-license-row" key={`${lic.license_number || 'lic'}-${i}`}>
                  <span>{lic.license_number ? `License #${lic.license_number}` : 'License on file'}</span>
                  {jur && <span className="oqb-lic-meta">{jur}</span>}
                  {lic.expiration_date && (
                    <span className="oqb-lic-meta">Expires {formatLicDate(lic.expiration_date)}</span>
                  )}
                  {lic.verification_url && (
                    <a href={lic.verification_url} target="_blank" rel="noopener noreferrer">
                      Verify with issuing agency →
                    </a>
                  )}
                </div>
              );
            })
          ) : hasDoc ? (
            <div className="oqb-edu-license-row">
              <span>License on file</span>
              {contractor.license_number && (
                <span className="oqb-lic-meta">License #{contractor.license_number}</span>
              )}
            </div>
          ) : (
            <div className="oqb-edu-license-row">
              <span>{LICENSE_NOT_PROVIDED_LINE}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
