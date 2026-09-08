/**
 * gh-1840 control-1 fixture: a minimal reproduction of the FIXED pattern
 * (tests/e2e/smoke/entry-point-reachability.spec.ts's installSpy() on
 * `main` today, commit 4d542ba) -- the binding is read and verified as a
 * function BEFORE it is wrapped and reassigned. scripts/spec-spy-order-check.py
 * must NOT reject this file.
 */
import { test, expect, Page } from '@playwright/test';

async function installSpy(page: Page, name: string) {
  await page.evaluate((targetName) => {
    const original = new Function(
      `return (typeof ${targetName} !== 'undefined') ? ${targetName} : undefined;`
    )();
    if (typeof original !== 'function') {
      throw new Error(
        `installSpy('${targetName}') FAILED: typeof ${targetName} is not 'function'. ` +
          `Refusing to install a spy on a target that doesn't exist.`
      );
    }
    const wrapper = (...args: unknown[]) => {
      (window as any).__oqSpyCalls.push([targetName, ...args]);
      return original.apply(window, args);
    };
    new Function(`${targetName} = arguments[0];`)(wrapper);
  }, name);
}

test.describe('good spy order (fixture)', () => {
  test('verified spy install', async ({ page }) => {
    await page.goto('/fixture.html');
    await page.evaluate(() => {
      (window as any).__oqSpyCalls = [];
    });
    await installSpy(page, 'doThing');

    await page.locator('#btn').click();
    const calls = await page.evaluate(() => (window as any).__oqSpyCalls || []);
    expect(calls.length).toBeGreaterThan(0);
  });
});
