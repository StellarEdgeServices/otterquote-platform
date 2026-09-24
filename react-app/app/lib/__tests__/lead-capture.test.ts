/**
 * gh-2121 (LRS HO-1 S16) / PR #2163 REVIEW: FAIL fix (comment 5821864061).
 *
 * Unit coverage for lib/lead-capture.ts's read/clear/link helpers — the
 * sessionStorage side of the multi-path capture (app/layout.tsx's strip
 * script writes the same { id, exp } shape this reads; see that file's
 * LEAD_STORAGE_KEY/LEAD_TTL_MS, duplicated there because a
 * beforeInteractive inline script cannot import this module).
 *
 * Positive: an unexpired sessionStorage entry is read, handed to
 * set_lead_converted (p_lead_id only — no user id, S1), and consumed
 * (cleared) exactly once.
 * Negative controls: (a) an EXPIRED entry (TTL-simulated random/stale
 * lead) is not read at all and set_lead_converted is never called — the
 * client-side half of "an expired lead is not linked"; the server-side
 * half (the RPC's own `created_at > now() - interval '24 hours'` guard) is
 * exercised live via the Supabase MCP BEGIN..ROLLBACK check in this PR's
 * report, since this is a client-only test file. (b) a malformed/garbage
 * sessionStorage value (simulating a forged or corrupted entry — the
 * "random lead" case from the client's point of view) is likewise
 * discarded, not passed to the RPC.
 *
 * M2 fix (comment 5822978578): linkPendingLeadOnce() used to clear the
 * capture BEFORE awaiting the RPC, so a navigation that cancelled the
 * in-flight call lost the lead for good — the retry at /auth-callback
 * found nothing left to retry. Covered below: a resolved success clears
 * the capture; a resolved-but-definitive `false` (not an error) also
 * clears it; a thrown/rejected call (network error, timeout, or an
 * aborted fetch — the actual M2 failure mode) leaves the capture in place
 * so the next call site can retry it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEAD_STORAGE_KEY,
  LEAD_TTL_MS,
  readPendingLeadId,
  clearPendingLeadId,
  linkPendingLeadOnce,
} from '../lead-capture';

function setStored(value: unknown) {
  sessionStorage.setItem(LEAD_STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('lib/lead-capture', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });

  afterEach(() => {
    sessionStorage.clear();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });

  it('prefers window.__oqRouterLeadId over sessionStorage when both are set', () => {
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = 'from-window';
    setStored({ id: 'from-storage', exp: Date.now() + LEAD_TTL_MS });
    expect(readPendingLeadId()).toBe('from-window');
  });

  it('falls back to an unexpired sessionStorage entry', () => {
    setStored({ id: 'lead-fresh', exp: Date.now() + LEAD_TTL_MS });
    expect(readPendingLeadId()).toBe('lead-fresh');
  });

  it('negative control: an expired sessionStorage entry is not returned', () => {
    setStored({ id: 'lead-stale', exp: Date.now() - 1 });
    expect(readPendingLeadId()).toBeNull();
    // Also self-cleans, so a later read (or a debugger poking at storage)
    // does not find a stale id either.
    expect(sessionStorage.getItem(LEAD_STORAGE_KEY)).toBeNull();
  });

  it('negative control: a malformed/forged sessionStorage entry is not returned', () => {
    setStored('not json');
    expect(readPendingLeadId()).toBeNull();
    setStored({ notAnId: true });
    expect(readPendingLeadId()).toBeNull();
  });

  it('clearPendingLeadId removes both the window bridge and the storage marker', () => {
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = 'x';
    setStored({ id: 'x', exp: Date.now() + LEAD_TTL_MS });
    clearPendingLeadId();
    expect(readPendingLeadId()).toBeNull();
  });

  it('linkPendingLeadOnce calls set_lead_converted with only p_lead_id (S1: no p_user_id) and consumes the capture', async () => {
    setStored({ id: 'lead-abc', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() => Promise.resolve({ error: null }));

    await linkPendingLeadOnce({ rpc });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('set_lead_converted', { p_lead_id: 'lead-abc' });
    // Consumed: a second call in the same "session" does not re-fire.
    await linkPendingLeadOnce({ rpc });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('negative control: nothing captured -> set_lead_converted is never called', async () => {
    const rpc = vi.fn(() => Promise.resolve({ error: null }));
    await linkPendingLeadOnce({ rpc });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('M2: success (no error, data true) clears the capture', async () => {
    setStored({ id: 'lead-success', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() => Promise.resolve({ data: true, error: null }));

    await linkPendingLeadOnce({ rpc });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(readPendingLeadId()).toBeNull();
  });

  it('M2: a definitive false (RPC resolved, not an error — e.g. already-converted or too-old) still clears the capture', async () => {
    setStored({ id: 'lead-false', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() => Promise.resolve({ data: false, error: null }));

    await linkPendingLeadOnce({ rpc });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(readPendingLeadId()).toBeNull();
  });

  it('a rejected RPC call (e.g. anon caller or expired/already-converted lead, S1) does not throw, and clears the capture (a resolved response is still a definitive answer)', async () => {
    setStored({ id: 'lead-rejected', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() => Promise.resolve({ error: { message: 'permission denied' } }));

    await expect(linkPendingLeadOnce({ rpc })).resolves.toBeUndefined();
    expect(readPendingLeadId()).toBeNull();
  });

  it('M2 negative control: a network error / aborted call KEEPS the capture for the next call site to retry', async () => {
    setStored({ id: 'lead-network-error', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() => Promise.reject(new DOMException('The user aborted a request.', 'AbortError')));

    await expect(linkPendingLeadOnce({ rpc })).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledTimes(1);
    // Unlike every "resolved" case above, the capture survives — the next
    // call site (e.g. /auth-callback) gets a chance to link it.
    expect(readPendingLeadId()).toBe('lead-network-error');
  });
});
