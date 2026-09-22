/**
 * Dirty-state storage fixtures — gh-2060.
 *
 * Every test file that touches sessionStorage/localStorage in this suite
 * clears it in its own `beforeEach` (see e.g.
 * app/lib/__tests__/cookie-storage.test.ts, app/contractor/_shell/__tests__/
 * ContractorShell.test.tsx, app/trade-selector/__tests__/gh2004-address-
 * fallback.test.tsx). That default is correct for most tests — it is what
 * makes tests independent of run order — and this fixture does NOT remove
 * or weaken it.
 *
 * What it fixes: with every test starting from empty storage, no test in
 * the suite could ever express "a previous visitor/tab/session left this
 * behind" — the entire class of stale-state bugs (a stranger's identity
 * surviving into a fresh load, an old referral's attribution bleeding into
 * a new one, a half-written value from a failed request) was invisible by
 * construction, not merely untested. gh-2060 found two real instances of
 * this in one day, both missed by 1,392 green tests.
 *
 * `seedStaleStorage` is the escape hatch: call it from INSIDE a test body,
 * after the suite's own `beforeEach` has already run its normal clear, and
 * immediately before exercising the code under test. It writes directly to
 * the browser storage APIs so the test can start "dirty" on purpose, while
 * every other test in the file (and every other file) keeps the clean-by-
 * default isolation untouched.
 *
 * Usage:
 *
 *   import { seedStaleStorage } from '@/test/storage-fixtures';
 *
 *   it('does not let a prior visitor's agent id leak into an unrelated write', () => {
 *     seedStaleStorage({
 *       localStorage: { oq_referral_agent_id: 'AGENT-FROM-A-DIFFERENT-VISIT' },
 *       sessionStorage: { oq_referral_agent_id: 'AGENT-FROM-A-DIFFERENT-VISIT' },
 *     });
 *     // ... call the code under test, assert it does not see the stale value ...
 *   });
 */

export interface StaleStorageSeed {
  /** Key/value pairs to write into window.localStorage before the seed call returns. */
  localStorage?: Record<string, string>;
  /** Key/value pairs to write into window.sessionStorage before the seed call returns. */
  sessionStorage?: Record<string, string>;
  /** Key/value pairs to write as document.cookie entries (Path=/) before the seed call returns. */
  cookies?: Record<string, string>;
}

/**
 * Seed one or more browser storage surfaces with values a test wants to
 * treat as already present — i.e. left behind by someone/something else —
 * before mounting the component or calling the function under test.
 *
 * Each surface is optional and independent; pass only the ones the test
 * needs dirty. Silently no-ops per-key on a storage write failure (private
 * mode / blocked site data) rather than throwing, matching how the
 * production storage helpers this fixture exists to test already behave.
 */
export function seedStaleStorage(seed: StaleStorageSeed): void {
  if (seed.localStorage) {
    for (const [key, value] of Object.entries(seed.localStorage)) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Storage blocked in this environment — nothing to seed.
      }
    }
  }
  if (seed.sessionStorage) {
    for (const [key, value] of Object.entries(seed.sessionStorage)) {
      try {
        window.sessionStorage.setItem(key, value);
      } catch {
        // Storage blocked in this environment — nothing to seed.
      }
    }
  }
  if (seed.cookies) {
    for (const [key, value] of Object.entries(seed.cookies)) {
      try {
        document.cookie = `${key}=${encodeURIComponent(value)}; path=/`;
      } catch {
        // Cookies blocked in this environment — nothing to seed.
      }
    }
  }
}
