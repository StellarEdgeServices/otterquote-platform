/**
 * 5-Page Revenue-Path Smoke Check (gh-1261).
 *
 * Five pages chosen for revenue-path coverage: the homeowner and contractor
 * front doors, the two pages that carry the actual conversion asks, and the
 * partner profession gate. contractor-how-it-works.html is where the 5%
 * fee / $10k floor is actually stated — there is no pricing.html.
 *
 * Each page must return 200, render its own visible <h1>, and produce zero
 * uncaught console errors or page errors. A check that only asserts 200 is
 * theatre: a Netlify shell returns 200 for a page that never rendered.
 */
import { test, expect } from '@playwright/test';

const PAGES = [
  '/index.html',
  '/landing.html',
  '/contractor-join.html',
  '/contractor-how-it-works.html',
  '/partners.html',
];

for (const path of PAGES) {
  test(`${path} — 200 + visible h1 + no console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      errors.push(`pageerror: ${err.message}`);
    });

    const response = await page.goto(path, { waitUntil: 'load' });
    expect(response, `${path} produced no response`).not.toBeNull();
    expect(response?.status(), `${path} did not return HTTP 200`).toBe(200);

    const h1 = page.locator('h1').first();
    await expect(h1, `${path} has no visible <h1>`).toBeVisible();
    const h1Text = (await h1.textContent())?.trim() ?? '';
    expect(h1Text.length, `${path} <h1> is empty`).toBeGreaterThan(0);

    expect(errors, `${path} produced console/page errors:\n${errors.join('\n')}`).toEqual([]);
  });
}
