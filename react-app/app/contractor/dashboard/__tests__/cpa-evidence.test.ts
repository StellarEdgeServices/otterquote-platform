/**
 * gh-2444 part (a): the shared CPA evidence helper must treat a RETURNED supabase-js
 * `{ error }` (not just a throw) as a failure.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptCpa, recordCpaAcceptanceEvidence, writeCpaAcceptance, type CpaAcceptClient, type CpaEvidenceClient, type CpaWriteClient } from '../cpa-evidence';

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
    expect(insert).toHaveBeenCalledWith({ user_id: 'u-1', event_type: 'cpa_accepted', title: 'T', created_at: ARGS.now, is_test: false });
  });

  it('stamps is_test=true on the activity_log row for a test contractor (CEO RUN 104 finding 8)', async () => {
    const { c, insert } = client();
    expect(await recordCpaAcceptanceEvidence(c, { ...ARGS, isTest: true })).toBeNull();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'cpa_accepted', is_test: true }));
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

// ── gh-2995: one server-side accept_cpa() call ──
function acceptClient(result: { data: unknown; error: unknown } | (() => never)) {
  const rpc = vi.fn(async () => (typeof result === 'function' ? result() : result));
  return { c: { rpc } as unknown as CpaAcceptClient, rpc };
}

describe('acceptCpa (gh-2995)', () => {
  it('calls rpc accept_cpa with ONLY the version id and returns null when the server confirms a record', async () => {
    const { c, rpc } = acceptClient({ data: { acceptance_id: 'acc-1', accepted_at: 'x' }, error: null });
    expect(await acceptCpa(c, 'v1-2026-04')).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('accept_cpa', { p_version: 'v1-2026-04' });
  });

  it('NEGATIVE CONTROL: a RETURNED error is a failure', async () => {
    const err = { message: 'invalid_agreement_version' };
    expect(await acceptCpa(acceptClient({ data: null, error: err }).c, 'v1-2026-04')).toBe(err);
  });

  it('NEGATIVE CONTROL: error:null with no acceptance_id (nothing durable confirmed) is a failure', async () => {
    for (const data of [null, {}, { acceptance_id: '' }, { acceptance_id: 7 }]) {
      const r = await acceptCpa(acceptClient({ data, error: null }).c, 'v1-2026-04');
      expect(r).toBeInstanceOf(Error);
      expect((r as Error).message).toMatch(/accept_cpa_no_record/);
    }
  });

  it('a thrown rpc is returned as a failure, not rethrown', async () => {
    const boom = new Error('network');
    expect(await acceptCpa(acceptClient(() => { throw boom; }).c, 'v1-2026-04')).toBe(boom);
  });
});

describe('dashboard page.tsx uses accept_cpa for both CPA paths (gh-2995)', () => {
  const src = readFileSync(resolve(__dirname, '..', 'page.tsx'), 'utf8');
  const a = src.indexOf('function AgreementModal');
  const b = src.indexOf('function Modal(');
  const modals = src.slice(a, b);
  it('both modals make exactly one acceptCpa call with the version constant', () => {
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
    expect(modals.split('acceptCpa(supabase, CURRENT_CPA_VERSION)').length - 1).toBe(2);
  });
  it('NEGATIVE CONTROL: the browser-side writes are gone (no contractors update, no IP rpc, no activity_log insert, no browser clock, no date as version)', () => {
    expect(modals).not.toMatch(/\.update\(/);
    expect(modals).not.toContain('writeCpaAcceptance');
    expect(modals).not.toContain('recordCpaAcceptanceEvidence');
    expect(modals).not.toContain('record_cpa_ip');
    expect(modals).not.toContain('new Date()');
    expect(modals).not.toMatch(/agreement_version/);
  });
  it('a failed call keeps the existing copy: the re-accept modal shows errorSave, the first modal the existing alert, never a raw token', () => {
    const r = src.slice(src.indexOf('function CpaReacceptModal'), b);
    expect(r).toMatch(/if \(error\) \{ setErr\(m\.errorSave\)/);
    for (const m of r.matchAll(/setErr\(([^)]*)\)/g)) expect(m[1]).toMatch(/^(m\.\w+|'')$/);
    const f = src.slice(a, src.indexOf('function CpaReacceptModal'));
    expect(f).toContain('alert(C.cpaReacceptModal.errorGeneric)');
  });
});
