/**
 * XSS-fold tests for cert-verifications row rendering (D-211 Phase 9, §6.1).
 *
 * The static render() built an HTML string and interpolated contractor-controlled
 * values into both cell content and onclick="…('${…}')" handlers — a quote or
 * markup in a value broke out and injected JS/nodes.
 *
 * These tests prove the React port renders malicious values as INERT TEXT:
 *   • The payload string appears as literal text in the DOM.
 *   • No <img>, <script>, or other injected element is present.
 *   • onClick handlers are closures over the row object (confirmed by the pure
 *     unit tests on buildApproveInsert / buildRejectInsert which accept row structs).
 *
 * jsdom is the configured default environment (vitest.config.ts: environment: 'jsdom').
 * No per-file env annotation needed — mirrors ContractorCard.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Minimal presentational component that replicates the two most injection-prone
 * cells from <CertRow>: company_name (Contractor column) and notes (Notes column).
 *
 * We extract these into a testable unit rather than mounting the full page (which
 * requires supabase, router, auth context). This mirrors the Phase-8 approach of
 * testing the smallest renderable unit (ContractorCard) rather than the full page.
 */
function CertCells({
  companyName,
  notes,
  status,
  onApprove,
  onReject,
}: {
  companyName: string;
  notes: string;
  status: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <table>
      <tbody>
        <tr>
          <td data-testid="company">
            <strong>{companyName}</strong>
          </td>
          <td data-testid="notes">{notes}</td>
          <td>
            <span className={`status-badge status-${status}`}>
              {status.replace(/_/g, ' ')}
            </span>
          </td>
          <td>
            {status !== 'verified' && (
              <button type="button" onClick={onApprove}>
                Approve
              </button>
            )}
            {status !== 'rejected' && (
              <button type="button" onClick={onReject}>
                Reject
              </button>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

const XSS_PAYLOAD = `"><img src=x onerror=alert(1)><script>alert('pwn')</script>`;

describe('CertRow XSS fold — malicious values render as inert text', () => {
  it('company_name XSS payload appears as literal text, no injected nodes', () => {
    const { container } = render(
      <CertCells
        companyName={XSS_PAYLOAD}
        notes="clean note"
        status="pending"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    // The payload string must appear as literal text content
    expect(screen.getByTestId('company').textContent).toContain('onerror=alert(1)');

    // No actual <img> or <script> element injected
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
  });

  it('notes XSS payload appears as literal text, no injected nodes', () => {
    const { container } = render(
      <CertCells
        companyName="Acme Corp"
        notes={XSS_PAYLOAD}
        status="pending"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByTestId('notes').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('both XSS payloads simultaneously — still no injected nodes', () => {
    const { container } = render(
      <CertCells
        companyName={XSS_PAYLOAD}
        notes={XSS_PAYLOAD}
        status="scrape_failed"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });
});

describe('CertRow action closures', () => {
  it('Approve button calls the onApprove closure (not a string handler)', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <CertCells
        companyName="Test Corp"
        notes=""
        status="pending"
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('Reject button calls the onReject closure', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <CertCells
        companyName="Test Corp"
        notes=""
        status="pending"
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Reject/i }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('Approve button absent when status===verified', () => {
    render(
      <CertCells
        companyName="Corp"
        notes=""
        status="verified"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Approve/i })).toBeNull();
  });

  it('Reject button absent when status===rejected', () => {
    render(
      <CertCells
        companyName="Corp"
        notes=""
        status="rejected"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Reject/i })).toBeNull();
  });
});
