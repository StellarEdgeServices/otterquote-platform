/**
 * gh-3199 (Ben's ruling on #3199): a `rejected` template shows "Upload a corrected template" and
 * NOT "Request admin review" (the RPC accepts only pending_validation and manual_mapping_pending).
 * "Request admin review" stays on manual_mapping_pending. pending_validation is not in
 * D199_FAIL_STATES, so the action row has never been shown for it; that is asserted unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

const rows: Record<string, unknown> = {};
vi.mock('@/lib/supabase', () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    q.select = () => q; q.eq = () => q;
    q.maybeSingle = async () => ({ data: rows.current ?? null, error: null });
    q.single = async () => ({ data: rows.current ?? null, error: null });
    return q;
  };
  return { supabase: { from: chain, rpc: vi.fn(), functions: { invoke: vi.fn() } } };
});

import { D199Validation } from '../d199-validation';

async function renderWith(status: string, onUpload?: () => void) {
  cleanup();
  rows.current = { id: 't1', status, validation_result: { requiredCount: 3, requiredFoundCount: 1, anchors: [] } };
  render(<D199Validation contractorId="c1" trade="roofing" fundingType="insurance" storagePath="p.pdf" onUploadCorrected={onUpload} />);
  await waitFor(() => expect(document.querySelector('.oqp-val')).not.toBeNull());
}

describe('d199-validation action row by status (gh-3199)', () => {
  it('rejected: upload action calls the existing upload picker; no "Request admin review"', async () => {
    const onUpload = vi.fn();
    await renderWith('rejected', onUpload);
    expect(screen.queryByText('Request admin review')).toBeNull();
    expect(screen.queryByText('Map anchors manually')).toBeNull();
    fireEvent.click(screen.getByText('Upload a corrected template'));
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it('manual_mapping_pending: "Request admin review" present, no upload-corrected button', async () => {
    await renderWith('manual_mapping_pending');
    expect(screen.getByText('Request admin review')).toBeTruthy();
    expect(screen.getByText('Map anchors manually')).toBeTruthy();
    expect(screen.queryByText('Upload a corrected template')).toBeNull();
  });

  it('pending_validation: action row behaviour unchanged (hidden), neither button shown', async () => {
    await renderWith('pending_validation');
    expect(screen.queryByText('Request admin review')).toBeNull();
    expect(screen.queryByText('Upload a corrected template')).toBeNull();
  });
});
