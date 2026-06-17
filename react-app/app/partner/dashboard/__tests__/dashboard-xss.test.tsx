/**
 * XSS-fold tests for partner-dashboard row rendering (D-211 Phase 12).
 *
 * The static page built HTML strings and interpolated DB/user values into
 * innerHTML. Notably populateReferralsTable() interpolated the referral client
 * name (homeowner_name || homeowner_email || 'Visitor') UNESCAPED into
 * `<td>${clientName}</td>` — a stored-XSS sink (homeowner_name/email are
 * user-controlled). populateRecruitsTable() escaped the recruit name via
 * escapeHtml(), but the React port should make BOTH inert by construction.
 *
 * These tests prove the React cells render malicious values as INERT TEXT:
 *   • the payload appears as literal text in the DOM
 *   • no <img> / <script> node is injected
 *
 * jsdom is the configured default environment (vitest.config.ts) — mirrors the
 * sibling referrals-xss.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  type PartnerReferral,
  type RecruitRecord,
  referralClientName,
  referralStatusLabel,
  referralStatusClass,
  recruitName,
  recruitTypeLabel,
} from '../utils';

const XSS_PAYLOAD = `"><img src=x onerror=alert(1)><script>alert('pwn')</script>`;

/**
 * Minimal presentational cells replicating the injection-prone columns from the
 * partner referral + recruit tables, rendered exactly as page.tsx renders them
 * (JSX text). Does NOT import the full page (avoids supabase/router/auth).
 */
function ReferralCells({ referral }: { referral: PartnerReferral }) {
  return (
    <table>
      <tbody>
        <tr>
          <td data-testid="client-cell">{referralClientName(referral)}</td>
          <td data-testid="status-cell">
            <span className={`status-badge ${referralStatusClass(referral.status)}`}>
              {referralStatusLabel(referral.status)}
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function RecruitCells({ recruit }: { recruit: RecruitRecord }) {
  return (
    <table>
      <tbody>
        <tr>
          <td data-testid="recruit-name-cell">{recruitName(recruit)}</td>
          <td data-testid="recruit-type-cell">{recruitTypeLabel(recruit.agent_type)}</td>
        </tr>
      </tbody>
    </table>
  );
}

describe('partner dashboard XSS fold — malicious values render as inert text', () => {
  it('referral client name (the UNESCAPED static sink) renders inert', () => {
    const { container } = render(
      <ReferralCells referral={{ id: 'r1', homeowner_name: XSS_PAYLOAD, status: 'registered' }} />,
    );
    expect(screen.getByTestId('client-cell').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('referral client name falls through homeowner_email (also user-controlled) inertly', () => {
    const { container } = render(
      <ReferralCells referral={{ id: 'r1', homeowner_name: null, homeowner_email: XSS_PAYLOAD, status: 'clicked' }} />,
    );
    expect(screen.getByTestId('client-cell').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('an unknown referral status renders as inert raw text (label fallback)', () => {
    const { container } = render(
      <ReferralCells referral={{ id: 'r1', homeowner_name: 'Jane', status: XSS_PAYLOAD }} />,
    );
    expect(screen.getByTestId('status-cell').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('recruit name + agent_type render inert', () => {
    const { container } = render(
      <RecruitCells recruit={{ id: 'rec1', first_name: XSS_PAYLOAD, last_name: null, email: null, agent_type: XSS_PAYLOAD }} />,
    );
    expect(screen.getByTestId('recruit-name-cell').textContent).toContain('onerror=alert(1)');
    // agent_type is mapped through recruitTypeLabel → unknown falls back to 'Partner' (inert)
    expect(screen.getByTestId('recruit-type-cell').textContent).toBe('Partner');
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });
});
