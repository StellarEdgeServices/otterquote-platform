// gh-2881 / D-390: the shared browser column list and the owner RPC reader.
import { describe, expect, it } from 'vitest';
import { CLAIM_PUBLIC_COLUMNS, fetchClaimPrivateText } from '../claim-columns';

describe('CLAIM_PUBLIC_COLUMNS', () => {
  const cols = CLAIM_PUBLIC_COLUMNS.split(',').map((c) => c.trim());
  it('excludes the three homeowner-typed columns and is not a star select', () => {
    for (const p of ['homeowner_notes', 'urgency_reason', 'project_confirmation']) expect(cols).not.toContain(p);
    expect(cols).not.toContain('*');
  });
  it('keeps the columns the homeowner pages depend on', () => {
    for (const c of ['id', 'user_id', 'status', 'property_address', 'selected_contractor_id', 'platform_fee_charged', 'parsed_line_items', 'trades']) expect(cols).toContain(c);
  });
  it('has no duplicates', () => expect(new Set(cols).size).toBe(cols.length));
});

describe('fetchClaimPrivateText', () => {
  const row = { homeowner_notes: 'n', urgency_reason: 'u', project_confirmation: { a: 1 } };
  it('returns the first row of the RPC result', async () => {
    const calls: unknown[] = [];
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push([fn, args]); return { data: [row], error: null }; } };
    expect(await fetchClaimPrivateText(client, 'c1')).toEqual(row);
    expect(calls).toEqual([['claim_private_text', { p_claim_id: 'c1' }]]);
  });
  it('returns null (not loaded) on an RPC error, an empty result, or a thrown error', async () => {
    expect(await fetchClaimPrivateText({ rpc: async () => ({ data: null, error: { message: 'x' } }) }, 'c1')).toBeNull();
    expect(await fetchClaimPrivateText({ rpc: async () => ({ data: [], error: null }) }, 'c1')).toBeNull();
    expect(await fetchClaimPrivateText({ rpc: async () => { throw new Error('net'); } }, 'c1')).toBeNull();
  });
});
