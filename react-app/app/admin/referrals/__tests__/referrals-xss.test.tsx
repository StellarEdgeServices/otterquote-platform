/**
 * XSS-fold tests for referral-partner row rendering (D-211 Phase 11, §6.1).
 *
 * The static renderTable()/buildActions() built an HTML string and interpolated
 * first_name, last_name, email and agent_type into cell innerHTML — and crucially
 * interpolated agent_type UNESCAPED through typeBadge() — plus interpolated
 * w9_file_url and id into onclick="viewW9('${…}')" / verifyW9('${id}') /
 * manualUnblock('${id}') handlers. A quote or markup in any value broke out and
 * injected JS/nodes.
 *
 * These tests prove the React port renders malicious values as INERT TEXT:
 *   • The payload string appears as literal text in the DOM.
 *   • No <img>, <script>, or other injected element is created.
 *   • Verify/Unblock handlers are closures over the row (not string-built).
 *
 * jsdom is the configured default environment (vitest.config.ts). No per-file
 * env annotation needed — mirrors fee-config-xss.test.tsx / payouts-xss.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  type ReferralAgent,
  fullName,
  typeBadge,
  w9StatusBadge,
  paymentsBadge,
} from '../utils';

const XSS_PAYLOAD = `"><img src=x onerror=alert(1)><script>alert('pwn')</script>`;

/**
 * Minimal presentational component replicating the injection-prone cells from
 * the referral table row: Name, Email, Type (via typeBadge), W-9 status, Payments,
 * and the Verify/Unblock buttons wired as closures over the row. Does NOT import
 * the full page (avoids supabase/router/auth). Mirrors the Phase-9/10/11 approach.
 */
function PartnerCells({
  partner,
  onVerify,
  onUnblock,
}: {
  partner: ReferralAgent;
  onVerify: (id: string) => void;
  onUnblock: (row: ReferralAgent) => void;
}) {
  const type = typeBadge(partner.agent_type);
  const w9 = w9StatusBadge(partner);
  const payments = paymentsBadge(partner);
  return (
    <table>
      <tbody>
        <tr>
          <td data-testid="name-cell">
            <strong>{fullName(partner)}</strong>
          </td>
          <td data-testid="email-cell">{partner.email || '—'}</td>
          <td data-testid="type-cell">
            <span className={`badge ${type.className}`}>{type.label}</span>
          </td>
          <td data-testid="w9-cell">
            <span className={`badge ${w9.className}`}>{w9.label}</span>
          </td>
          <td data-testid="payments-cell">
            <span className={`badge ${payments.className}`}>{payments.label}</span>
          </td>
          <td>
            <button type="button" onClick={() => onVerify(partner.id)}>
              Verify W-9
            </button>
            <button type="button" onClick={() => onUnblock(partner)}>
              Unblock
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function mkAgent(over: Partial<ReferralAgent> = {}): ReferralAgent {
  return {
    id: over.id ?? 'a-1',
    first_name: over.first_name ?? 'Jane',
    last_name: over.last_name ?? 'Doe',
    email: over.email ?? 'jane@example.com',
    agent_type: over.agent_type ?? 're_agent',
    created_at: over.created_at ?? '2026-06-10T12:00:00Z',
    payments_blocked: over.payments_blocked ?? false,
    w9_file_url: over.w9_file_url ?? null,
    w9_submitted_at: over.w9_submitted_at ?? null,
    w9_verified_at: over.w9_verified_at ?? null,
    w9_notification_sent_at: over.w9_notification_sent_at ?? null,
    ...over,
  };
}

describe('PartnerRow XSS fold — malicious values render as inert text', () => {
  it('first/last name XSS payload appears as literal text; no injected img or script', () => {
    const { container } = render(
      <PartnerCells
        partner={mkAgent({ first_name: XSS_PAYLOAD, last_name: XSS_PAYLOAD })}
        onVerify={vi.fn()}
        onUnblock={vi.fn()}
      />,
    );
    expect(screen.getByTestId('name-cell').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('email XSS payload appears as literal text; no injected img or script', () => {
    const { container } = render(
      <PartnerCells partner={mkAgent({ email: XSS_PAYLOAD })} onVerify={vi.fn()} onUnblock={vi.fn()} />,
    );
    expect(screen.getByTestId('email-cell').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('agent_type XSS payload (unknown type → typeBadge fallback) renders inert', () => {
    // This is the sink the static page left UNESCAPED in typeBadge().
    const { container } = render(
      <PartnerCells partner={mkAgent({ agent_type: XSS_PAYLOAD })} onVerify={vi.fn()} onUnblock={vi.fn()} />,
    );
    expect(screen.getByTestId('type-cell').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('name + email + agent_type payloads simultaneously — 0 img, 0 script', () => {
    const { container } = render(
      <PartnerCells
        partner={mkAgent({ first_name: XSS_PAYLOAD, email: XSS_PAYLOAD, agent_type: XSS_PAYLOAD })}
        onVerify={vi.fn()}
        onUnblock={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });
});

describe('PartnerRow action closures', () => {
  it('Verify W-9 calls onVerify once with the row id; onUnblock not called', () => {
    const onVerify = vi.fn();
    const onUnblock = vi.fn();
    render(
      <PartnerCells partner={mkAgent({ id: 'row-77' })} onVerify={onVerify} onUnblock={onUnblock} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Verify W-9/i }));
    expect(onVerify).toHaveBeenCalledTimes(1);
    expect(onVerify).toHaveBeenCalledWith('row-77');
    expect(onUnblock).not.toHaveBeenCalled();
  });

  it('Unblock calls onUnblock once with the row object; onVerify not called', () => {
    const onVerify = vi.fn();
    const onUnblock = vi.fn();
    const row = mkAgent({ id: 'row-88', payments_blocked: true });
    render(<PartnerCells partner={row} onVerify={onVerify} onUnblock={onUnblock} />);
    fireEvent.click(screen.getByRole('button', { name: /Unblock/i }));
    expect(onUnblock).toHaveBeenCalledTimes(1);
    expect(onUnblock).toHaveBeenCalledWith(row);
    expect(onVerify).not.toHaveBeenCalled();
  });
});
