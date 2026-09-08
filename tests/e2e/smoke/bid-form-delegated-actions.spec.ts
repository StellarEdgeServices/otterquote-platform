/**
 * contractor-bid-form.html delegated-action reachability (gh-1730 / gh-1693).
 *
 * gh-1730 names `contractor-bid-form.html` as carrying "a live #1693-shaped
 * inline handler that no guard currently covers", and asks for the file to be
 * pinned in `tools/inline_handler_attr_check.py`'s STRICT_FILES with the guard
 * "shown failing before the fix and passing after".
 *
 * Kevin's evidence on the issue (comment 5577936855) corrected the cited line:
 * the flagged shape lives at lines 2752 / 4803 / 4837 — three
 * `onclick="fn(${idx})"` attributes rendered inside template literals, whose
 * closing quote is supplied by interpolated code. They work today only because
 * `${idx}` is a counter and so never contains a quote. That is the gh-1693
 * shape, latent rather than broken.
 *
 * The companion change converts all three to `data-oq-action` + one delegated
 * listener per container — the same fix contractor-opportunities.html carries.
 * Converting a working button is exactly the operation that produced #1693 in
 * the first place, so this spec exists to prove the converted controls can
 * still be OPERATED, not merely that they are present:
 *
 *   1. EXISTS  — the control is in the DOM after the page's own render ran.
 *   2. BOUND   — it carries `data-oq-action` AND an ancestor carries the
 *                delegated-listener marker `data-oq-actions-bound="1"`.
 *   3. REACHES — a REAL Playwright click reaches the target function, proven
 *                by wrapping that function with a spy before the click and
 *                asserting the spy recorded the call with the right index.
 *
 * Assertion 3 is the only one that can catch #1693's class. Assertion 1 is
 * what the 5-page smoke check already does, and it is what PASSED on #1693's
 * broken deploy.
 *
 * ⛔ HELPER DUPLICATION, DELIBERATE AND TEMPORARY. `forceDemoMode` /
 * `installSpy` below are the same technique as
 * ./entry-point-reachability.spec.ts, which owns the shared versions. That
 * file is being edited by open PR #1833 (gh-1730's own coverage extension);
 * touching it here would collide. Next concrete step once #1833 merges: lift
 * these two helpers into a shared `reachability-helpers.ts` and have both
 * specs import it. Recorded here rather than left for someone to discover.
 */
import { test, expect, type Page } from '@playwright/test';

const PAGE = '/contractor-bid-form.html';

/**
 * contractor-bid-form.html redirects an unauthenticated visitor before this
 * spec can touch anything. Patching js/config.js's response (rather than
 * injecting on DOMContentLoaded) guarantees DEMO_MODE is true the instant that
 * script finishes, before auth.js or the page's own inline script run — the
 * same race ./entry-point-reachability.spec.ts documents at length.
 */
async function forceDemoMode(page: Page) {
  await page.route('**/js/config.js', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    return route.fulfill({ response, body: body + '\nwindow.CONFIG.DEMO_MODE = true;\n' });
  });
}

/**
 * Wraps `name` with a call-recording spy, refusing outright if the target is
 * not already a live function — installing a spy on a missing target would
 * CREATE the binding this spec exists to verify (PR #1720 comment 5560323618,
 * "DEFECT 1"). The wrapper calls through to the original, so a live handler
 * can never report as dead. Uses the bare identifier, not `window[name]`:
 * these are top-level `function` declarations in a classic script.
 */
async function installSpy(page: Page, name: string) {
  await page.evaluate((targetName) => {
    const original = new Function(
      `return (typeof ${targetName} !== 'undefined') ? ${targetName} : undefined;`,
    )();
    if (typeof original !== 'function') {
      throw new Error(
        `[gh-1730] installSpy('${targetName}') FAILED: typeof ${targetName} is '${typeof original}', not 'function'. Refusing to install a spy on a target that does not exist.`,
      );
    }
    const wrapper = (...args: unknown[]) => {
      (window as any).__oqSpyCalls.push([targetName, ...args]);
      return original.apply(window, args);
    };
    new Function(`${targetName} = arguments[0];`)(wrapper);
  }, name);
}

/**
 * Loads the page and renders one gutter-guard entry and one warranty card.
 *
 * ⚠ FINDING, recorded here because a test that silently works around a bug is
 * how the bug survives: `addWarrantyCard()` appends to
 * `document.getElementById('warrantyCardsContainer')`, and NO element with
 * that id exists anywhere in contractor-bid-form.html's markup (two
 * getElementById reads, zero definitions, repo-wide). The function has no null
 * guard, so it throws `TypeError: Cannot read properties of null (reading
 * 'appendChild')` — the warranty-card render path is dead in the shipped page.
 * That is a defect of its own, NOT introduced by the gh-1730 conversion, and
 * per this issue's dispatch rule it gets its own issue rather than widening
 * this change's scope.
 *
 * So this spec creates that container itself before calling addWarrantyCard(),
 * and says so. What it then proves is exactly what gh-1730 asks: that the two
 * converted warranty controls are bound and operable through the delegated
 * dispatcher. It does NOT claim the warranty section is reachable by a real
 * contractor today — it is not.
 */
async function openWithRenderedControls(page: Page) {
  await forceDemoMode(page);
  await page.goto(PAGE);
  await page.waitForFunction(
    () => typeof (window as any).addGutterGuardEntry === 'function' &&
      typeof (window as any).addWarrantyCard === 'function',
  );
  await page.evaluate(() => {
    (window as any).__oqSpyCalls = [];
    (window as any).addGutterGuardEntry();
    if (!document.getElementById('warrantyCardsContainer')) {
      const synthetic = document.createElement('div');
      synthetic.id = 'warrantyCardsContainer';
      synthetic.dataset.oqSyntheticFixture = '1';
      document.body.appendChild(synthetic);
    }
    (window as any).addWarrantyCard();
    // The gutter-guard block ships inside a collapsed section that a
    // contractor opens by choosing "gutter guard" on the real form. This spec
    // drives the render functions directly rather than the whole form flow, so
    // it un-collapses the ancestors of the rendered controls. Visibility is
    // presentation; what is under test is whether a real click REACHES the
    // handler, and Playwright refuses to click a hidden element at all.
    const reveal = (sel: string) => {
      let el = document.querySelector(sel) as HTMLElement | null;
      while (el) {
        if (getComputedStyle(el).display === 'none') el.style.display = 'block';
        el.hidden = false;
        el = el.parentElement;
      }
    };
    reveal('#gutterGuardEntries');
    reveal('#warrantyCardsContainer');
  });
}

const ACTIONS = [
  { action: 'gutter-remove', target: 'removeGutterGuardEntry', label: 'gutter-guard Remove' },
  { action: 'warranty-remove', target: 'removeWarrantyCard', label: 'warranty Remove' },
  { action: 'warranty-save-template', target: 'saveWarrantyAsTemplate', label: 'warranty Save as Template' },
] as const;

test.describe('contractor-bid-form.html delegated actions (gh-1730)', () => {
  for (const { action, target, label } of ACTIONS) {
    test(`${label} [data-oq-action="${action}"] exists, is bound, and a real click reaches ${target}()`, async ({ page }) => {
      await openWithRenderedControls(page);
      const btn = page.locator(`[data-oq-action="${action}"]`).first();

      // 1. EXISTS
      expect(
        await btn.count(),
        `[${label}] ASSERTION 1 (exists) FAILED: no [data-oq-action="${action}"] in the DOM after the page's own render ran.`,
      ).toBeGreaterThan(0);

      // 2. BOUND — a delegated ancestor actually carries the listener marker.
      const bound = await btn.evaluate((el) => {
        const node = el as HTMLElement;
        if (!node.dataset || !node.dataset.oqAction) return false;
        let a: HTMLElement | null = node.parentElement;
        while (a) {
          if (a.dataset && a.dataset.oqActionsBound === '1') return true;
          a = a.parentElement;
        }
        return false;
      });
      expect(
        bound,
        `[${label}] ASSERTION 2 (bound) FAILED: the control carries data-oq-action but NO ancestor carries data-oq-actions-bound="1", so nothing is listening. This is the gh-1693 shape with a different costume.`,
      ).toBe(true);

      // 3. REACHES — a real click, not el.click() in-page.
      await installSpy(page, target);
      await btn.click();
      const calls = await page.evaluate(() => (window as any).__oqSpyCalls || []);
      expect(
        calls.map((c: unknown[]) => c[0]),
        `[${label}] ASSERTION 3 (reaches) FAILED: a real click did not reach ${target}(). Recorded calls: ${JSON.stringify(calls)}`,
      ).toContain(target);
      // and it is called with the numeric index, not a string or NaN
      const call = calls.find((c: unknown[]) => c[0] === target) as unknown[];
      expect(
        typeof call[1] === 'number' && Number.isFinite(call[1]),
        `[${label}] ASSERTION 3b FAILED: ${target}() was reached but with a non-numeric index (${JSON.stringify(call[1])}). A NaN index removes nothing and looks exactly like a dead button.`,
      ).toBe(true);
    });
  }

  test('NEGATIVE CONTROL: contractor-bid-form.html renders NO inline onclick on any dynamic control', async ({ page }) => {
    await openWithRenderedControls(page);
    // The three converted controls, and every sibling produced by the same
    // two render functions. A single surviving compiled onclick means the
    // conversion was partial — which is worse than not doing it, because the
    // STRICT_FILES pin would then be green on a file that still carries one.
    const withInline = await page.evaluate(() => {
      const scopes = ['#gutterGuardEntries', '#warrantyCardsContainer'];
      const out: string[] = [];
      for (const sel of scopes) {
        const root = document.querySelector(sel);
        if (!root) continue;
        root.querySelectorAll('*').forEach((el) => {
          if (typeof (el as any).onclick === 'function') out.push(sel + ' :: ' + el.outerHTML.slice(0, 120));
        });
      }
      return out;
    });
    expect(withInline, `Inline onclick handlers still present: ${JSON.stringify(withInline, null, 2)}`).toEqual([]);
  });
});
