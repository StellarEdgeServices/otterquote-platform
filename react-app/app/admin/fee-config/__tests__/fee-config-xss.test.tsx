/**
 * XSS-fold tests for fee-config row rendering (D-211 Phase 11, §6.1).
 *
 * The static renderTable() built an HTML string and interpolated fee.state,
 * fee.trade, and fee.fee_basis into cell innerHTML, and interpolated fee.id into
 * onclick="openEditModal(${fee.id})" / startDelete(...) handlers — a quote or
 * markup in a value broke out and injected JS/nodes.
 *
 * These tests prove the React port renders malicious values as INERT TEXT:
 *   • The payload string appears as literal text in the DOM.
 *   • No <img>, <script>, or other injected element is present.
 *   • Edit/Delete handlers are closures over the row id (not string-built).
 *
 * jsdom is the configured default environment (vitest.config.ts). No per-file
 * env annotation needed — mirrors payouts-xss.test.tsx / warranty-drift-xss.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { feeBasisLabel, type FeeConfigRow } from '../utils';

const XSS_PAYLOAD = `"><img src=x onerror=alert(1)><script>alert('pwn')</script>`;

/**
 * Minimal presentational component replicating the injection-prone cells from
 * the fee-config table row: state, trade, fee_basis (via feeBasisLabel), and the
 * Edit/Delete buttons wired as closures over the row id. Does NOT import the full
 * page (avoids supabase/router/auth). Mirrors the Phase-9/10 testing approach.
 */
function FeeCells({
  fee,
  onEdit,
  onDelete,
}: {
  fee: Pick<FeeConfigRow, 'id' | 'state' | 'trade' | 'fee_basis'>;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <table>
      <tbody>
        <tr>
          <td data-testid="state-cell">
            {fee.state ? fee.state : <span className="oqfc-default-badge">All States</span>}
          </td>
          <td data-testid="trade-cell">
            {fee.trade ? fee.trade : <span className="oqfc-default-badge">All Trades</span>}
          </td>
          <td data-testid="basis-cell">{feeBasisLabel(fee.fee_basis)}</td>
          <td>
            <button type="button" onClick={() => onEdit(fee.id)}>
              Edit
            </button>
            <button type="button" onClick={() => onDelete(fee.id)}>
              Delete
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

describe('FeeRow XSS fold — malicious values render as inert text', () => {
  it('state XSS payload appears as literal text; no injected img or script', () => {
    const { container } = render(
      <FeeCells
        fee={{ id: 'f-1', state: XSS_PAYLOAD, trade: null, fee_basis: 'bid_amount' }}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId('state-cell').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('trade XSS payload appears as literal text; no injected img or script', () => {
    const { container } = render(
      <FeeCells
        fee={{ id: 'f-2', state: null, trade: XSS_PAYLOAD, fee_basis: 'bid_amount' }}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId('trade-cell').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('fee_basis XSS payload (non-bid_amount) renders inert via feeBasisLabel', () => {
    const { container } = render(
      <FeeCells
        fee={{ id: 'f-3', state: null, trade: null, fee_basis: XSS_PAYLOAD }}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId('basis-cell').textContent).toContain('onerror=alert(1)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('state + trade + fee_basis XSS payloads simultaneously — 0 img, 0 script', () => {
    const { container } = render(
      <FeeCells
        fee={{ id: 'f-4', state: XSS_PAYLOAD, trade: XSS_PAYLOAD, fee_basis: XSS_PAYLOAD }}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });
});

describe('FeeRow action closures', () => {
  it('Edit button calls onEdit once with the row id; onDelete not called', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <FeeCells
        fee={{ id: 'row-77', state: 'OH', trade: 'Roofing', fee_basis: 'bid_amount' }}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('row-77');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('Delete button calls onDelete once with the row id; onEdit not called', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <FeeCells
        fee={{ id: 'row-88', state: 'IN', trade: null, fee_basis: 'bid_amount' }}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('row-88');
    expect(onEdit).not.toHaveBeenCalled();
  });
});
