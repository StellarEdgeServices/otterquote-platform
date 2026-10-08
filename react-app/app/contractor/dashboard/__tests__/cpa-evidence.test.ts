/**
 * gh-2444 part (a): the shared CPA evidence helper must treat a RETURNED supabase-js
 * `{ error }` (not just a throw) as a failure.
 */
import { describe, it, expect, vi } from 'vitest';
import { recordCpaAcceptanceEvidence, type CpaEvidenceClient } from '../cpa-evidence';

const ARGS = { contractorId: 'c-1', userId: 'u-1', now: '2026-10-07T00:00:00.000Z', title: 'T' };

function client(opts: { rpc?: () => Promise<{ error: unknown }>; insert?: () => Promise<{ error: unknown }> } = {}) {
  const rpc = vi.fn(opts.rpc ?? (async () => ({ error: null })));
  const insert = vi.fn(opts.insert ?? (async () => ({ error: null })));
  const from = vi.fn(() => ({ insert }));
  return { c: { rpc, from } as unknown as CpaEvidenceClient, rpc, insert, from };
}

describe('recordCpaAcceptanceEvidence (gh-2444)', () => {
  it('success: calls record_cpa_ip then inserts the cpa_accepted row, returns null', async () => {
    const { c, rpc, insert, from } = client();
    expect(await recordCpaAcceptanceEvidence(c, ARGS)).toBeNull();
    expect(rpc).toHaveBeenCalledWith('record_cpa_ip', { p_contractor_id: 'c-1' });
    expect(from).toHaveBeenCalledWith('activity_log');
    expect(insert).toHaveBeenCalledWith({ user_id: 'u-1', event_type: 'cpa_accepted', title: 'T', created_at: ARGS.now });
  });

  it('RETURNED rpc error is a failure and skips the activity_log insert', async () => {
    const err = { message: 'rpc denied' };
    const { c, insert } = client({ rpc: async () => ({ error: err }) });
    expect(await recordCpaAcceptanceEvidence(c, ARGS)).toBe(err);
    expect(insert).not.toHaveBeenCalled();
  });

  it('RETURNED activity_log insert error is a failure', async () => {
    const err = { message: 'insert denied' };
    const { c } = client({ insert: async () => ({ error: err }) });
    expect(await recordCpaAcceptanceEvidence(c, ARGS)).toBe(err);
  });

  it('a thrown rpc / insert is also a failure', async () => {
    const boom = new Error('network');
    expect(await recordCpaAcceptanceEvidence(client({ rpc: async () => { throw boom; } }).c, ARGS)).toBe(boom);
    expect(await recordCpaAcceptanceEvidence(client({ insert: async () => { throw boom; } }).c, ARGS)).toBe(boom);
  });
});
