/**
 * Unit tests for the non-deadlocking Supabase auth lock (D-211, 2026-06-16).
 * Guards against the supabase-js navigator.locks deadlock that froze the
 * contractor dashboard (the true root of Blocker 1).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { nonDeadlockingLock, LOCK_ACQUIRE_TIMEOUT_MS } from '../supabase-lock';

function setLocks(impl: unknown) {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: impl });
}
function clearLocks() {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
}

afterEach(() => {
  vi.useRealTimers();
  clearLocks();
});

describe('nonDeadlockingLock', () => {
  it('runs fn directly when the Web Locks API is unavailable', async () => {
    clearLocks();
    const fn = vi.fn(async () => 'ok');
    await expect(nonDeadlockingLock('lock:x', -1, fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('acquires the lock and runs fn once when the lock is free', async () => {
    const request = vi.fn((_name: string, _opts: object, cb: (l: unknown) => Promise<unknown>) =>
      Promise.resolve().then(() => cb({})),
    );
    setLocks({ request });
    const fn = vi.fn(async () => 'value');
    await expect(nonDeadlockingLock('lock:x', -1, fn)).resolves.toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('proceeds unlocked (no hang) when an orphaned lock can never be acquired', async () => {
    vi.useFakeTimers();
    const request = vi.fn(
      (_name: string, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            (e as Error).name = 'AbortError';
            reject(e);
          });
          // never grants — simulates an orphaned/held exclusive lock
        }),
    );
    setLocks({ request });
    const fn = vi.fn(async () => 'unblocked');
    const p = nonDeadlockingLock('lock:x', -1, fn);
    await vi.advanceTimersByTimeAsync(LOCK_ACQUIRE_TIMEOUT_MS + 50);
    await expect(p).resolves.toBe('unblocked');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('with acquireTimeout 0 uses ifAvailable and still runs fn when the lock is held', async () => {
    const request = vi.fn((_name: string, opts: { ifAvailable?: boolean }, cb: (l: unknown) => Promise<unknown>) => {
      expect(opts.ifAvailable).toBe(true);
      return Promise.resolve().then(() => cb(null)); // lock not granted (held)
    });
    setLocks({ request });
    const fn = vi.fn(async () => 'ran');
    await expect(nonDeadlockingLock('lock:x', 0, fn)).resolves.toBe('ran');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
