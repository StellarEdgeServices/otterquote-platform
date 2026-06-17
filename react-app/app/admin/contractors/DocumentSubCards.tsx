'use client';

/**
 * D-210 document status sub-cards (port of renderDocumentSubCards,
 * admin-contractors.html:896). Three badges: CGL COI, Workers' Comp (incl.
 * WCE-1-EXEMPT), and License (D-218 contractor_licenses-or-attestation).
 *
 * XSS-fold: colors/icons come from pure helpers; all text is rendered as JSX
 * (React-escaped) — no innerHTML.
 */

import type { Contractor } from './utils';
import { cglDocBadge, wcDocBadge, licenseDocBadge } from './utils';

export function DocumentSubCards({ contractor }: { contractor: Contractor }) {
  const cgl = cglDocBadge(contractor);
  const wc = wcDocBadge(contractor);
  const lic = licenseDocBadge(contractor);

  // Display-only expiry suffix (kept in the component, not the pure helper).
  const coiExpiry =
    contractor.coi_file_url != null && contractor.coi_expires_at
      ? ' • ' + new Date(contractor.coi_expires_at).toLocaleDateString()
      : '';

  return (
    <div className="oqac-doc-cards">
      <div className="oqac-doc-badge" style={{ background: cgl.bg, color: cgl.color }}>
        {cgl.icon} {cgl.text}
        {coiExpiry}
      </div>
      <div className="oqac-doc-badge" style={{ background: wc.bg, color: wc.color }}>
        {wc.icon} {wc.text}
      </div>
      <div className="oqac-doc-badge" style={{ background: lic.bg, color: lic.color }}>
        {lic.icon} {lic.text}
      </div>
    </div>
  );
}
