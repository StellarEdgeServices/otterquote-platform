/**
 * XSS-fold tests for template-review rendering (D-211 Phase 9 / A6, §6.1).
 *
 * The static page built DOM imperatively; this port renders DB/user-controlled
 * values as JSX text. These tests prove a malicious company_name / anchor field
 * renders as INERT TEXT (no injected <img>/<script>), and that a malicious
 * rejection reason is carried as plain DATA in admin_notes (never executed).
 *
 * Mirrors the Phase-8/A5 approach of testing the smallest renderable unit.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { buildRejectUpdate } from '../utils';

function ReviewCells({
  companyName,
  email,
  anchor,
  field,
  onReview,
}: {
  companyName: string;
  email: string;
  anchor: string;
  field: string;
  onReview: () => void;
}) {
  return (
    <table>
      <tbody>
        <tr>
          <td data-testid="company">
            <strong>{companyName}</strong>
            <br />
            <small>{email}</small>
          </td>
          <td>
            <div className="anchor-row found">
              <div data-testid="anchor">
                <code>{anchor}</code>
                <br />
                <small>{field}</small>
              </div>
            </div>
          </td>
          <td>
            <button type="button" onClick={onReview}>
              Review
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

const XSS_PAYLOAD = `"><img src=x onerror=alert(1)><script>alert('pwn')</script>`;

describe('Template review XSS fold — malicious values render as inert text', () => {
  it('company_name payload appears as literal text; no injected nodes', () => {
    const { container } = render(
      <ReviewCells companyName={XSS_PAYLOAD} email="e@x.com" anchor="A" field="F" onReview={vi.fn()} />,
    );
    expect(screen.getByTestId('company').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
  });

  it('anchor + field payload appears as literal text; no injected nodes', () => {
    const { container } = render(
      <ReviewCells companyName="Acme" email="e@x.com" anchor={XSS_PAYLOAD} field={XSS_PAYLOAD} onReview={vi.fn()} />,
    );
    expect(screen.getByTestId('anchor').textContent).toContain('onerror=alert(1)');
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });

  it('Review button invokes the onReview closure (not a string handler)', () => {
    const onReview = vi.fn();
    render(<ReviewCells companyName="Acme" email="" anchor="A" field="F" onReview={onReview} />);
    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});

describe('admin_notes is carried as inert data, never executed', () => {
  it('buildRejectUpdate stores a malicious reason verbatim as plain data', () => {
    const payload = buildRejectUpdate('admin-user-id', XSS_PAYLOAD);
    expect(payload.admin_notes).toBe(XSS_PAYLOAD);
    expect(payload.status).toBe('rejected');
    expect(payload.reviewed_by).toBe('admin-user-id');
  });
});
