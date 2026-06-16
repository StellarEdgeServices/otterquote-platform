'use client';

/**
 * Non-deadlocking auth lock for the Supabase client (D-211, 2026-06-16).
 *
 * supabase-js v2 serializes auth operations (getSession, token refresh) behind a
 * Web Lock — `navigator.locks.request('lock:' + storageKey, acquireTimeout, fn)`.
 * For getSession it waits for the lock INDEFINITELY. When a prior page context
 * leaves the exclusive lock orphaned (observed live after rapid full-page reloads
 * of /contractor/dashboard), getSession() hangs forever: the React AuthProvider
 * never resolves and the contractor dashboard freezes on its gate spinner. This
 * was the TRUE root cause of D-211 Blocker 1 — the "intermittent bounce to
 * /contractor/login; cookies present; static stack fine" symptom was this hang
 * tripping the provider's 1.5s fallback.
 *
 * This replacement serializes normally when the lock is free, but BOUNDS the wait:
 * if the lock can't be acquired within LOCK_ACQUIRE_TIMEOUT_MS (orphaned/stuck) it
 * proceeds WITHOUT the lock rather than hang. Token refresh is idempotent and the
 * cookie write is last-writer-wins, so a rare un-serialized refresh is benign
 * compared with a frozen app. Falls back to running `fn` directly where the Web
 * Locks API is unavailable (SSR / older browsers / tests).
 */

export const LOCK_ACQUIRE_TIMEOUT_MS = 2500;

type LockManagerLike = {
  request: (name: string, options: object, cb: (lock: unknown) => Promise<unknown>) => Promise<unknown>;
};

export async function nonDeadlockingLock<R>(
  name: string,
  acquireTimeout: number,
  fn: () => Promise<R>,
): Promise<R> {
  const locks: LockManagerLike | null =
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { locks?: LockManagerLike }).locks &&
    typeof (navigator as Navigator & { locks?: LockManagerLike }).locks!.request === 'function'
      ? (navigator as Navigator & { locks?: LockManagerLike }).locks!
      : null;

  // No Web Locks API: nothing to serialize against — just run.
  if (!locks) return fn();

  // acquireTimeout === 0 means "only if immediately available" (supabase contract).
  // Honor the fast path, but run fn whether or not the lock was granted — never block.
  if (acquireTimeout === 0) {
    return locks.request(name, { ifAvailable: true }, async () => fn()) as Promise<R>;
  }

  // Otherwise bound the wait so an orphaned lock can't hang us forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCK_ACQUIRE_TIMEOUT_MS);
  try {
    return (await locks.request(name, { signal: controller.signal }, async () => fn())) as R;
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err as { name?: string } | null)?.name === 'AbortError';
    if (aborted) {
      // Couldn't acquire within the bound (lock stuck/orphaned) — proceed unlocked.
      return fn();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
