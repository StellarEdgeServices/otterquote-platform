/**
 * gh-2559 (Ben #2569 6029315131 A/B.4): the submit waits for the uploaded estimate to be read (loss_sheet_parsed_at) before it
 * opens the claim for bids, because the database now refuses to open a claim on an unread estimate. No new homeowner text:
 * the refusal string stays a null placeholder and the database error passes through unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn(), storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));

import { supabase } from '@/lib/supabase';
import { submitForBids, waitForEstimateRead, BID_OPEN_REFUSAL_TEXT_PLACEHOLDER } from '../actions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;
beforeEach(() => vi.clearAllMocks());

function wire(rows: Array<Record<string, unknown>>, update: () => Promise<{ data: unknown; error: unknown }>) {
  let i = 0;
  const reads = { n: 0 };
  sb.from.mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () => {
          reads.n++;
          return Promise.resolve({ data: rows[Math.min(i++, rows.length - 1)], error: null });
        },
      }),
    }),
    update: () => ({ eq: () => ({ select: update }) }),
  }));
  return reads;
}

describe('waitForEstimateRead (gh-2559)', () => {
  it('returns at once when the claim has no estimate', async () => {
    const reads = wire([{ estimate_filename: null, has_estimate: false, loss_sheet_parsed_at: null }], () => Promise.resolve({ data: [], error: null }));
    await waitForEstimateRead('c1', { waitMs: 50, pollMs: 5 });
    expect(reads.n).toBe(1);
  });
  it('polls until loss_sheet_parsed_at is set', async () => {
    const reads = wire(
      [
        { estimate_filename: 'u/e.pdf', loss_sheet_parsed_at: null },
        { estimate_filename: 'u/e.pdf', loss_sheet_parsed_at: null },
        { estimate_filename: 'u/e.pdf', loss_sheet_parsed_at: '2026-10-19T00:00:00Z' },
      ],
      () => Promise.resolve({ data: [], error: null }),
    );
    await waitForEstimateRead('c1', { waitMs: 2000, pollMs: 5 });
    expect(reads.n).toBe(3);
  });
  it('stops waiting when the platform marked the file unsupported (the parser cannot read it)', async () => {
    const reads = wire([{ estimate_filename: 'u/e.docx', loss_sheet_parsed_at: null, loss_sheet_parse_status: 'unsupported' }], () => Promise.resolve({ data: [], error: null }));
    await waitForEstimateRead('c1', { waitMs: 2000, pollMs: 5 });
    expect(reads.n).toBe(1);
  });
  it("stops waiting when the provider rejected the file (status 'failed')", async () => {
    const reads = wire([{ estimate_filename: 'u/e.pdf', loss_sheet_parsed_at: null, loss_sheet_parse_status: 'failed' }], () => Promise.resolve({ data: [], error: null }));
    await waitForEstimateRead('c1', { waitMs: 2000, pollMs: 5 });
    expect(reads.n).toBe(1);
  });
  it('gives up at the deadline and lets the database decide (negative control: it does not hang)', async () => {
    const reads = wire([{ estimate_filename: 'u/e.pdf', loss_sheet_parsed_at: null }], () => Promise.resolve({ data: [], error: null }));
    await waitForEstimateRead('c1', { waitMs: 30, pollMs: 10 });
    expect(reads.n).toBeGreaterThan(1);
  });
});

describe('submitForBids (gh-2559)', () => {
  it('never shows the guard database text: error is undefined so Checklist uses its generic line (review 6276857463 blocker 2)', async () => {
    expect(BID_OPEN_REFUSAL_TEXT_PLACEHOLDER).toBeNull();
    wire([{ estimate_filename: null }], () =>
      Promise.resolve({ data: null, error: { message: '[gh2559-bid-open:unread_estimate] PLACEHOLDER-PENDING-BEN: x' } }));
    const res = await submitForBids('c1');
    expect(res.ok).toBe(false);
    expect(res.error).toBeUndefined();
  });
  it('negative control: an ordinary database error still passes through', async () => {
    wire([{ estimate_filename: null }], () => Promise.resolve({ data: null, error: { message: 'permission denied' } }));
    const res = await submitForBids('c1');
    expect(res.error).toBe('permission denied');
  });
});
