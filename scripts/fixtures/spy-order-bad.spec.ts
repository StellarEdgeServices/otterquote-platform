/**
 * gh-1840 control-1 fixture: a minimal, deliberately-stubbed reproduction of
 * PR #1720's original defect (commit 133b2db, tests/e2e/smoke/
 * entry-point-reachability.spec.ts before commit 4d542ba's fix) -- a spy
 * that replaces a page global OUTRIGHT, inside a page.evaluate() block, with
 * no `typeof` read of the original binding first. This CREATES the binding
 * the later click-assertion checks, rather than observing a pre-existing
 * one. scripts/spec-spy-order-check.py must REJECT this file.
 */
import { test, expect } from '@playwright/test';

test.describe('bad spy order (fixture)', () => {
  test('unverified spy install', async ({ page }) => {
    await page.goto('/fixture.html');

    // BUG: replaces window.doThing with a bare spy, no typeof guard before
    // this write. If doThing was renamed or never existed, this line still
    // succeeds and silently fabricates it.
    await page.evaluate(() => {
      (window as any).__oqSpyCalls = [];
      (window as any).doThing = (...args: unknown[]) => {
        (window as any).__oqSpyCalls.push(['doThing', ...args]);
      };
    });

    await page.locator('#btn').click();
    const calls = await page.evaluate(() => (window as any).__oqSpyCalls || []);
    expect(calls.length).toBeGreaterThan(0);
  });
});
