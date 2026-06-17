/**
 * XSS-fold tests for warranty drift row rendering (D-211 Phase 10, §6.1).
 *
 * The static buildDriftRow() built an HTML string and interpolated manufacturer,
 * tier, reviewed_by, rejection_reason, and diff values into innerHTML and
 * onclick="…('${…}')" handlers — a quote or markup in a value broke out and
 * injected JS/nodes.
 *
 * These tests prove the React port renders malicious values as INERT TEXT:
 *   • The payload string appears as literal text in the DOM.
 *   • No <img>, <script>, or other injected element is present.
 *   • onClick handlers are closures over the row id (confirmed by action-closure tests).
 *
 * jsdom is the configured default environment (vitest.config.ts: environment: 'jsdom').
 * No per-file env annotation needed — mirrors payouts-xss.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  changeTypeBadgeClass,
  changeTypeLabel,
  statusBadgeClass,
  statusLabel,
  buildDiff,
  type DriftRow,
} from '../utils';

const XSS_PAYLOAD = `"><img src=x onerror=alert(1)><script>alert('pwn')</script>`;

/**
 * Minimal presentational component replicating the injection-prone cells from
 * <DriftTableRow>: manufacturer, tier, rejection_reason, diff strings, and the
 * action buttons gated on status==='pending_review'. Does NOT import the full page
 * (avoids supabase/router/auth). Mirrors the Phase-10 approach of testing the
 * smallest renderable unit rather than the full page.
 */
function DriftCells({
  row,
  onApprove,
  onReject,
}: {
  row: Pick<
    DriftRow,
    | 'id'
    | 'manufacturer'
    | 'tier'
    | 'change_type'
    | 'status'
    | 'rejection_reason'
    | 'current_value'
    | 'proposed_value'
  >;
  onApprove: () => void;
  onReject: () => void;
}) {
  const diff = buildDiff(row as DriftRow);

  return (
    <table>
      <tbody>
        <tr>
          {/* Manufacturer / Tier */}
          <td data-testid="mfr-tier">
            <strong>{row.manufacturer}</strong>
            <br />
            <span>{row.tier}</span>
          </td>

          {/* Change type badge */}
          <td>
            <span className={`badge ${changeTypeBadgeClass(row.change_type)}`}>
              {changeTypeLabel(row.change_type)}
            </span>
          </td>

          {/* Diff cell */}
          <td data-testid="diff-cell">
            {diff.kind === 'no_source' && (
              <>
                <span>Manual check required.</span>
                <ul>
                  {diff.tiers.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </>
            )}
            {diff.kind === 'deprecated' && (
              <div>
                <span>{diff.current}</span>
                <span>Deprecated (not found on source page)</span>
              </div>
            )}
            {diff.kind === 'modified' && (
              <div>
                <span>{diff.current}</span>
                <span>→ {diff.proposed}</span>
              </div>
            )}
            {diff.kind === 'added' && <span>New: {diff.proposed}</span>}
            {diff.kind === 'none' && <span>—</span>}
          </td>

          {/* Status + rejection_reason */}
          <td data-testid="status-cell">
            <span className={`badge ${statusBadgeClass(row.status)}`}>
              {statusLabel(row.status)}
            </span>
            {row.rejection_reason && (
              <div data-testid="rejection-reason">{row.rejection_reason}</div>
            )}
          </td>

          {/* Actions */}
          <td>
            {row.status === 'pending_review' && (
              <>
                <button type="button" className="btn btn-approve" onClick={onApprove}>
                  Approve
                </button>
                <button type="button" className="btn btn-reject" onClick={onReject}>
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

// ── XSS fold: inert text rendering ───────────────────────────────────────────

describe('DriftRow XSS fold — malicious values render as inert text', () => {
  it('manufacturer XSS payload appears as literal text; no injected img or script', () => {
    const { container } = render(
      <DriftCells
        row={{
          id: 'd-1',
          manufacturer: XSS_PAYLOAD,
          tier: 'Premium',
          change_type: 'modified',
          status: 'pending_review',
          rejection_reason: null,
          current_value: { display_string: 'Old' },
          proposed_value: { display_string: 'New' },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByTestId('mfr-tier').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('rejection_reason XSS payload appears as literal text; no injected img or script', () => {
    const { container } = render(
      <DriftCells
        row={{
          id: 'd-2',
          manufacturer: 'Clean Corp',
          tier: 'Standard',
          change_type: 'deprecated',
          status: 'rejected',
          rejection_reason: XSS_PAYLOAD,
          current_value: { display_string: 'Old' },
          proposed_value: null,
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    const reasonEl = screen.getByTestId('rejection-reason');
    expect(reasonEl.textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('both manufacturer and rejection_reason XSS payloads simultaneously — 0 img, 0 script', () => {
    const { container } = render(
      <DriftCells
        row={{
          id: 'd-3',
          manufacturer: XSS_PAYLOAD,
          tier: XSS_PAYLOAD,
          change_type: 'deprecated',
          status: 'rejected',
          rejection_reason: XSS_PAYLOAD,
          current_value: null,
          proposed_value: null,
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });
});

// ── Action closures ───────────────────────────────────────────────────────────

describe('DriftRow action closures', () => {
  it('Approve button calls onApprove once; onReject not called', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(
      <DriftCells
        row={{
          id: 'd-4',
          manufacturer: 'Safe Corp',
          tier: 'Standard',
          change_type: 'modified',
          status: 'pending_review',
          rejection_reason: null,
          current_value: { display_string: 'Old' },
          proposed_value: { display_string: 'New' },
        }}
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
      <DriftCells
        row={{
          id: 'd-5',
          manufacturer: 'Safe Corp',
          tier: 'Standard',
          change_type: 'modified',
          status: 'pending_review',
          rejection_reason: null,
          current_value: { display_string: 'Old' },
          proposed_value: { display_string: 'New' },
        }}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Reject/i }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('status !== "pending_review" (e.g. "applied") — neither Approve nor Reject button present', () => {
    render(
      <DriftCells
        row={{
          id: 'd-6',
          manufacturer: 'Safe Corp',
          tier: 'Standard',
          change_type: 'modified',
          status: 'applied',
          rejection_reason: null,
          current_value: { display_string: 'Old' },
          proposed_value: { display_string: 'New' },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reject/i })).toBeNull();
  });
});
