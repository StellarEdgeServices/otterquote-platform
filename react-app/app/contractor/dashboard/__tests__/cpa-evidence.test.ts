/**
 * gh-2444 part (a): the shared CPA evidence helper must treat a RETURNED supabase-js
 * `{ error }` (not just a throw) as a failure.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recordCpaAcceptanceEvidence, writeCpaAcceptance, type CpaEvidenceClient, type CpaWriteClient } from '../cpa-evidence';

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

// ── gh-2105 (batch 2): the CPA acceptance write must fail loudly on a zero-row match ──
function writeClient(result: { data: unknown; error: unknown } | (() => never)) {
  const select = vi.fn(async () => (typeof result === 'function' ? result() : result));
  const eq = vi.fn(() => ({ select }));
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));
  return { c: { from } as unknown as CpaWriteClient, from, update, eq, select };
}
const PATCH = { cpa_version: 'v', cpa_accepted_at: 'now', needs_cpa_reattestation: false };

describe('writeCpaAcceptance (gh-2105 batch 2)', () => {
  it('a row came back: returns null and targets contractors by id with .select(id)', async () => {
    const { c, from, update, eq, select } = writeClient({ data: [{ id: 'c-1' }], error: null });
    expect(await writeCpaAcceptance(c, 'c-1', PATCH)).toBeNull();
    expect(from).toHaveBeenCalledWith('contractors');
    expect(update).toHaveBeenCalledWith(PATCH);
    expect(eq).toHaveBeenCalledWith('id', 'c-1');
    expect(select).toHaveBeenCalledWith('id');
  });

  it('NEGATIVE CONTROL: error:null with ZERO rows (the RLS-denied shape) now surfaces update_zero_rows', async () => {
    const r = await writeCpaAcceptance(writeClient({ data: [], error: null }).c, 'c-1', PATCH);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/update_zero_rows/);
    // null / non-array data is the same failure
    expect(await writeCpaAcceptance(writeClient({ data: null, error: null }).c, 'c-1', PATCH)).toBeInstanceOf(Error);
  });

  it('a RETURNED error and a thrown error are both returned as failures', async () => {
    const err = { message: 'denied' };
    expect(await writeCpaAcceptance(writeClient({ data: null, error: err }).c, 'c-1', PATCH)).toBe(err);
    const boom = new Error('network');
    expect(await writeCpaAcceptance(writeClient(() => { throw boom; }).c, 'c-1', PATCH)).toBe(boom);
  });
});

describe('dashboard page.tsx uses the guarded write for both CPA paths (gh-2105 batch 2)', () => {
  const src = readFileSync(resolve(__dirname, '..', 'page.tsx'), 'utf8');
  it('no bare contractors .update() remains in the two acceptance modals', () => {
    const a = src.indexOf('function AgreementModal');
    const b = src.indexOf('function Modal(');
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
    const modals = src.slice(a, b);
    expect(modals).not.toMatch(/\.update\(/);
    expect(modals.split('writeCpaAcceptance(supabase').length - 1).toBe(2);
  });
  it('a failed write keeps the existing copy: the re-accept modal shows errorSave and never the raw token', () => {
    const a = src.indexOf('function CpaReacceptModal');
    const modal = src.slice(a, src.indexOf('function Modal('));
    expect(modal).toMatch(/if \(error\) \{[^}]*setErr\(m\.errorSave\)/);
    for (const m of modal.matchAll(/setErr\(([^)]*)\)/g)) expect(m[1]).toMatch(/^(m\.\w+|'')$/);
  });
});
