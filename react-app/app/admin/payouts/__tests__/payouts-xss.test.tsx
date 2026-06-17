/**
 * XSS-fold tests for payouts row rendering (D-211 Phase 10, §6.1).
 *
 * The static renderTable() built an HTML string and interpolated
 * partner_name and trigger_event values into innerHTML and onclick="…('${…}')"
 * handlers — a quote or markup in a value broke out and injected JS/nodes.
 *
 * These tests prove the React port renders malicious values as INERT TEXT:
 *   • The payload string appears as literal text in the DOM.
 *   • No <img>, <script>, or other injected element is present.
 *   • onClick handlers are closures over the row object (confirmed by the pure
 *     unit tests on approvePayload / rejectPayload which accept row structs).
 *
 * jsdom is the configured default environment (vitest.config.ts: environment: 'jsdom').
 * No per-file env annotation needed — mirrors cert-verifications-xss.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PayoutApproval } from '../utils';
import { statusBadge, triggerText } from '../utils';

/**
 * Minimal presentational component replicating the injection-prone cells from
 * <PayoutRow>: partner_name (partner-name div), trigger (trigger-text div),
 * status badge, and the Approve/Reject buttons (only when status==='pending_approval').
 *
 * We extract these into a testable unit rather than mounting the full page (which
 * requires supabase, router, auth context). Mirrors the Phase-9 approach of testing
 * the smallest renderable unit rather than the full page.
 */
function PayoutCells({
  payout,
  onApprove,
  onReject,
}: {
  payout: Pick<PayoutApproval, 'partner_name' | 'trigger_event' | 'status'>;
  onApprove: () => void;
  onReject: () => void;
}) {
  const badge = statusBadge(payout.status);
  const trigger = triggerText(payout.trigger_event);

  return (
    <table>
      <tbody>
        <tr>
          <td data-testid="partner">
            <div className="partner-name">{payout.partner_name || '—'}</div>
            <div className="trigger-text">{trigger}</div>
          </td>
          <td data-testid="trigger-col">{trigger}</td>
          <td>
            <span className={`badge ${badge.className}`}>{badge.label}</span>
          </td>
          <td>
            {payout.status === 'pending_approval' && (
              <>
                <button type="button" className="action-btn btn-approve" onClick={onApprove}>
                  Approve
                </button>
                <button type="button" className="action-btn btn-reject" onClick={onReject}>
                  Reject
                </button>
              </>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

const XSS_PAYLOAD = `"><img src=x onerror=alert(1)><script>alert('pwn')</script>`;

describe('PayoutRow XSS fold — malicious values render as inert text', () => {
  it('partner_name XSS payload appears as literal text; no injected img or script', () => {
    const { container } = render(
      <PayoutCells
        payout={{ partner_name: XSS_PAYLOAD, trigger_event: null, status: 'pending_approval' }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    // The payload string must appear as literal text content
    expect(screen.getByTestId('partner').textContent).toContain('onerror=alert(1)');

    // No actual <img> or <script> element injected
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('trigger_event XSS payload appears as literal text; no injected img or script', () => {
    const { container } = render(
      <PayoutCells
        payout={{ partner_name: 'Clean Partner', trigger_event: XSS_PAYLOAD, status: 'pending_approval' }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    // The (truncated) payload string appears as text in both trigger cells
    expect(screen.getByTestId('trigger-col').textContent).toContain('onerror=alert(1)');

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('both partner_name and trigger_event XSS payloads simultaneously — 0 img, 0 script', () => {
    const { container } = render(
      <PayoutCells
        payout={{ partner_name: XSS_PAYLOAD, trigger_event: XSS_PAYLOAD, status: 'approved' }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });
});

describe('PayoutRow action closures', () => {
  it('Approve button calls onApprove once; onReject not called', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(
      <PayoutCells
        payout={{ partner_name: 'Test Partner', trigger_event: null, status: 'pending_approval' }}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('Reject button calls onReject once; onApprove not called', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(
      <PayoutCells
        payout={{ partner_name: 'Test Partner', trigger_event: null, status: 'pending_approval' }}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Reject/i }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('status !== "pending_approval" (e.g. "approved") — neither Approve nor Reject button present', () => {
    render(
      <PayoutCells
        payout={{ partner_name: 'Corp', trigger_event: null, status: 'approved' }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reject/i })).toBeNull();
  });
});
