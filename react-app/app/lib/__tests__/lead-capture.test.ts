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
 * found nothing left to retry.
 *
 * M3 fix (comment 5823511418): the M2 fix assumed a network error or
 * aborted fetch makes the RPC call THROW. The real supabase-js client
 * never does — it RESOLVES with `{ data: null, error, status: 0 }`. Every
 * mock below therefore returns a resolved value with an explicit `status`
 * (the real shape), never a rejected promise, and the assertions are keyed
 * off status: 200–499 is a definitive answer (clears the capture) —
 * success, a definitive `false`, or a real server-side rejection alike —
 * while `status: 0` (network error / abort) or a 5xx KEEPS the capture for
 * the next call site to retry. A timeout (the RPC never resolves within
 * linkPendingLeadOnce's bound) also keeps the capture.
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
    const rpc = vi.fn(() => Promise.resolve({ data: true, error: null, status: 200 }));

    await linkPendingLeadOnce({ rpc });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('set_lead_converted', { p_lead_id: 'lead-abc' });
    // Consumed: a second call in the same "session" does not re-fire.
    await linkPendingLeadOnce({ rpc });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('negative control: nothing captured -> set_lead_converted is never called', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: true, error: null, status: 200 }));
    await linkPendingLeadOnce({ rpc });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('M2: success (status 200, no error, data true) clears the capture', async () => {
    setStored({ id: 'lead-success', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() => Promise.resolve({ data: true, error: null, status: 200 }));

    await linkPendingLeadOnce({ rpc });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(readPendingLeadId()).toBeNull();
  });

  it('M2: a definitive false (RPC resolved 200, not an error — e.g. already-converted or too-old) still clears the capture', async () => {
    setStored({ id: 'lead-false', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() => Promise.resolve({ data: false, error: null, status: 200 }));

    await linkPendingLeadOnce({ rpc });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(readPendingLeadId()).toBeNull();
  });

  it('a real server-side 4xx rejection (e.g. anon caller, status 403) does not throw, and clears the capture (a real HTTP response is still a definitive answer)', async () => {
    setStored({ id: 'lead-rejected', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'permission denied' }, status: 403 }),
    );

    await expect(linkPendingLeadOnce({ rpc })).resolves.toBeUndefined();
    expect(readPendingLeadId()).toBeNull();
  });

  it('M3: a network error / aborted fetch — the REAL supabase-js shape ({data:null, error, status:0}, never a thrown rejection) — KEEPS the capture for the next call site to retry', async () => {
    setStored({ id: 'lead-network-error', exp: Date.now() + LEAD_TTL_MS });
    // This is what supabase-js's postgrest-js layer actually resolves with
    // on a network error or an aborted fetch — it never rejects (comment
    // 5823511418). The PR's original M2 test mocked a thrown rejection,
    // which the real client never produces; this is the shape M3 requires.
    const rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }),
    );

    await expect(linkPendingLeadOnce({ rpc })).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledTimes(1);
    // Unlike every 200-499 case above, the capture survives — the next
    // call site (e.g. /auth-callback) gets a chance to link it.
    expect(readPendingLeadId()).toBe('lead-network-error');
  });

  it('M3: a 5xx server error also KEEPS the capture (the server errored, not our caller — not a real answer)', async () => {
    setStored({ id: 'lead-server-error', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'internal server error' }, status: 503 }),
    );

    await expect(linkPendingLeadOnce({ rpc })).resolves.toBeUndefined();
    expect(readPendingLeadId()).toBe('lead-server-error');
  });

  it('M3 defensive path: a thrown/rejected call (not the real client\'s shape, but handled anyway) also keeps the capture', async () => {
    setStored({ id: 'lead-thrown', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(() => Promise.reject(new DOMException('The user aborted a request.', 'AbortError')));

    await expect(linkPendingLeadOnce({ rpc })).resolves.toBeUndefined();
    expect(readPendingLeadId()).toBe('lead-thrown');
  });

  it('M3: a slow RPC call (1.5 s) is not cancelled by the caller navigating away — linkPendingLeadOnce is awaited to completion (bounded to its own 2.5 s default) and still clears the capture on a definitive answer', async () => {
    setStored({ id: 'lead-slow', exp: Date.now() + LEAD_TTL_MS });
    const rpc = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ data: true, error: null, status: 200 }), 1500);
        }),
    );

    // Simulates the M3 auth-callback race: the caller awaits
    // linkPendingLeadOnce() (bounded to 2.5s) before doing anything that
    // would otherwise tear the page down (e.g. window.location.href) —
    // here, simply awaiting the call itself proves it is not abandoned
    // partway through a 1.5s RPC.
    await linkPendingLeadOnce({ rpc });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(readPendingLeadId()).toBeNull();
  });

  it('M3: linkPendingLeadOnce gives up waiting after its own timeout and keeps the capture, without cancelling the underlying call', async () => {
    setStored({ id: 'lead-timeout', exp: Date.now() + LEAD_TTL_MS });
    let resolveRpc: (v: { data: boolean; error: null; status: number }) => void = () => {};
    const rpc = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRpc = resolve;
        }),
    );

    await linkPendingLeadOnce({ rpc }, 10); // 10ms bound, RPC never resolves in time

    // Timed out waiting -> not a definitive answer yet -> capture kept.
    expect(readPendingLeadId()).toBe('lead-timeout');

    // The underlying call is still allowed to finish in the background and
    // clear the capture later, once it does.
    resolveRpc({ data: true, error: null, status: 200 });
    await Promise.resolve();
    await Promise.resolve();
    expect(readPendingLeadId()).toBeNull();
  });
});
