/**
 * Entry-Point Reachability Spec (gh-1697).
 *
 * #1693: six buttons on contractor-opportunities.html were dead in
 * production -- including the only entry point to the #1411/#1621 upgrade
 * money path -- and every gate we owned passed on it (see gh-1697 for the
 * full table). Every one of those gates measured what was SHIPPED. None of
 * them measured whether the shipped thing could be OPERATED.
 *
 * This spec closes that gap for the money-path controls named below. For
 * each declared entry point it asserts three things, in order:
 *
 *   1. EXISTS       -- the control is present in the DOM.
 *   2. BOUND         -- a handler is actually attached: either
 *                      `typeof el.onclick === 'function'` (inline
 *                      onclick="..." markup -- bids.html, admin-payouts.html),
 *                      or the element carries `data-oq-action` and an
 *                      ancestor carries the delegated listener marker
 *                      (contractor-opportunities.html's gh-1693 fix).
 *   3. REACHES       -- a REAL Playwright click (not `el.click()` in-page)
 *                      reaches the target function, proven by replacing that
 *                      function with a spy before the click and asserting
 *                      the spy was called with the expected arguments.
 *
 * Assertion 3 is the one that matters (see gh-1697's own worked examples: a
 * hoisted-variable refactor and a concatenated-attribute-name refactor both
 * reproduce the gh-1693 defect and both clear every text-level guard we own
 * at exit 0 -- only a real click finds either). Assertion 1 alone is what
 * the 5-Page Revenue-Path Smoke Check already covers and is exactly what
 * passed on #1693's broken deploy.
 *
 * These pages need an authenticated contractor/homeowner/admin session to
 * reach their card markup through the real app flow, which is why the
 * 5-page smoke check above can't touch them (no seeded fixture, no
 * session). This spec sidesteps that: it loads the real page (so every
 * dependency script -- config.js, auth.js, services.js, the page's own
 * inline script -- parses and defines its real, unmodified functions), then
 * calls the page's own exported pure render functions directly with a
 * synthetic fixture instead of running the real Supabase-backed init()
 * flow. `forceDemoMode()` below stops `init()` from ever firing the auth
 * redirect an unauthenticated session would otherwise trigger, which would
 * tear down the page (and, with it, every global function this spec depends
 * on) before this spec gets a chance to run.
 *
 * ── Entry-point catalog (gh-1697's "one list beside the spec") ───────────
 * Adding a money surface means adding a row here AND a test below that
 * exercises it. This list exists for traceability; the heterogeneous DOM
 * shapes across pages (delegated data-oq-action vs. inline onclick vs. a
 * plain navigational <a href>) mean a single generic runner would obscure
 * more than it would save, so each row's test is written out explicitly.
 *
 *   name                          | page                        | kind
 *   ------------------------------|------------------------------|-------------------
 *   upgrade-open (Buy Detailed…)  | contractor-opportunities.html | data-oq-action
 *   upgrade-pay (Pay Securely)    | contractor-opportunities.html | data-oq-action
 *   upgrade-cancel (Cancel)       | contractor-opportunities.html | data-oq-action
 *   doc-estimate (Loss Sheet)     | contractor-opportunities.html | data-oq-action
 *   doc-measurements (View Meas.) | contractor-opportunities.html | data-oq-action
 *   doc-hover (Measurement PDF)   | contractor-opportunities.html | data-oq-action
 *   Submit Bid                    | contractor-opportunities.html | href (navigational)
 *   Renew Bid                     | contractor-opportunities.html | href (navigational)
 *   Select This Contractor        | bids.html                     | inline onclick
 *   Approve                       | admin-payouts.html            | inline onclick
 *   Reject                        | admin-payouts.html            | inline onclick
 *   confirmSelection (Yes, Cont.) | bids.html                     | inline onclick
 *   feeAcceptanceCheckbox         | contractor-bid-form.html      | test.fixme (see gh-1730)
 *   submitBtn (Submit Bid)        | contractor-bid-form.html      | test.fixme (see gh-1730)
 *   signContractBtn (Continue)    | contract-signing.html         | addEventListener (own listener)
 *
 * The six #1693-regression entry points are the first six rows above --
 * those are the ones the gh-1697 closing criterion's negative control
 * (commit 0aa1d61) must show failing. Submit Bid/Renew Bid/Select This
 * Contractor/Approve/Reject were never broken by that bug (they don't use
 * the JSON.stringify-inside-onclick pattern); they're included here because
 * gh-1697 names them as money/critical-control surfaces this mechanism must
 * also cover going forward.
 *
 * ── gh-1730 (Part 1 coverage extension) ───────────────────────────────────
 * PR #1720 (Part 1, above) covered 9 entry points. Wave-4 CTO dispatch
 * (#1730 comment 5572644362) named four more, in priority order because
 * `confirmSelection` is worth more than the other three combined -- it is
 * the button that AWARDS THE CONTRACT, not merely opens the award modal
 * (`selectContractor`, already covered):
 *
 *   1. `confirmSelection` (bids.html) -- full coverage below.
 *   2. `contractor-bid-form.html #feeAcceptanceCheckbox` / `#submitBtn` --
 *      test.fixme below. Neither control's real handler can be verified
 *      "bound" by this spec's existing techniques without an HTML change:
 *      `#submitBtn` submits `<form id="bidForm">` via a bare anonymous
 *      `bidForm.addEventListener('submit', async (e) => {...})` -- no named
 *      target function for installSpy() to wrap at all. `#feeAcceptanceCheckbox`
 *      changes call `updateFeeCheckboxState` (a named function declaration,
 *      so installSpy()'s bare-identifier reassignment SUCCEEDS), but
 *      `_feeAcceptanceCheckbox.addEventListener('change', updateFeeCheckboxState)`
 *      captured that function BY VALUE when the listener was registered --
 *      reassigning the module-scope identifier afterward does not change
 *      what the already-registered listener calls, so a real click would
 *      keep reaching the ORIGINAL function and never the spy, making
 *      Assertion 3 unable to distinguish a live handler from a dead one for
 *      this specific binding shape. This is a fourth defect shape, distinct
 *      from the three DEFECTs installSpy()'s own comment names (assert-after,
 *      replace-not-wrap, `window[name]`-only) -- worth naming here rather
 *      than rediscovering silently: capture-by-value listeners need the spy
 *      installed BEFORE the addEventListener() call that captures it, which
 *      for these two controls means changing the HTML. gh-1730 Part 2 DID
 *      edit contractor-bid-form.html (converting the three STRICT_FILES
 *      call sites below to delegated data-oq-action listeners), but that is
 *      a different pair of controls -- #feeAcceptanceCheckbox and #submitBtn
 *      are untouched by that conversion, so this fourth defect shape still
 *      applies to them unchanged; extending installSpy()/installListenerRegistry()
 *      to intercept the handler reference at registration time (not just
 *      record that a listener was attached) remains the follow-up next build.
 *   3. `contract-signing.html #signContractBtn` -- full coverage below.
 *      Bound via a THIRD binding kind neither `assertHandlerBound()` style
 *      recognizes: a plain, non-delegated `addEventListener('click', ...)`
 *      directly on the element, inside `setupEventListeners()`. See
 *      `installListenerRegistry()` / `assertListenerBound()` below for how
 *      Assertion 2 is established for this kind.
 *
 * Also per 5572644362: `contractor-bid-form.html:4114`'s onclick is cited
 * as gh-1693's shape. Measured against the file as it stands on `main`
 * today, line 4114 (`onclick="openBidFormEstimatePdf()"`) and its two
 * neighbors at 4123/4127 are static, fully-closed inline handlers with no
 * interpolation -- not a violation under `tools/inline_handler_attr_check.py`'s
 * own definition (see that file's module docstring: static handlers are
 * deliberately not flagged, they cannot break). The live instances of the
 * flagged shape in this file today -- interpolated `onclick=` attributes
 * closed outside their JS string literal, the exact structural defect class
 * STRICT_FILES exists to catch -- were at lines 2752, 4803 and 4837 (verified
 * by running the tool with `--verbose` against `main`; see this PR's RED/GREEN
 * evidence). `contractor-bid-form.html` is added to STRICT_FILES below
 * regardless of the exact line drift, because the tool's job is to catch the
 * PATTERN wherever it lives in a converted file, not one cited line number.
 *
 * gh-1730 Part 2: those three sites are now converted to the same delegated
 * `data-oq-action` + addEventListener pattern contractor-opportunities.html
 * uses (`onGutterGuardEntriesClick` / `onWarrantyCardsContainerClick` in
 * contractor-bid-form.html), so `tools/inline_handler_attr_check.py` is green
 * on this file rather than red -- STRICT_FILES now guards real cleanliness
 * here, not a deliberately-red placeholder.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

// ── Shared helpers ──────────────────────────────────────────────────────

/**
 * Every page under test calls Auth.requireAuth(...) on init() and, when
 * unauthenticated, sets `window.location.href` to bounce to a login page
 * before this spec gets a chance to touch anything -- and unlike a fetch or
 * XHR, a same-document `location.href` navigation commits regardless of
 * whether the target request ultimately succeeds, so aborting it at the
 * network layer (tried first; see git blame) still tears down the current
 * document and every global function this spec depends on, landing on
 * chrome-error://chromewebdata/ instead.
 *
 * This spec never authenticates -- it doesn't need to, since it drives the
 * page's own pure functions directly -- so instead it leans on the escape
 * hatch these pages already ship for exactly this situation: CONFIG.DEMO_MODE
 * (js/config.js). `Auth.requireAuth()` (js/auth.js) returns without
 * redirecting whenever DEMO_MODE is true, and each page's own init() takes
 * its demo-data branch instead of querying Supabase.
 *
 * This has to land before ANY page script runs, not just before init() is
 * called: bids.html triggers init() via `Auth.ready().then(init)`, which can
 * resolve before DOMContentLoaded ever fires, so a DOMContentLoaded-based
 * injection loses that race (verified empirically -- it left bids.html
 * redirected to get-started.html before its own DOMContentLoaded listener
 * ever ran). Patching the actual js/config.js response instead guarantees
 * DEMO_MODE is true the instant that script finishes executing, before
 * supabase-client.js/auth.js/the page's own inline script even load,
 * regardless of which trigger a given page uses.
 */
async function forceDemoMode(page: Page) {
  await page.route('**/js/config.js', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    return route.fulfill({ response, body: body + '\nwindow.CONFIG.DEMO_MODE = true;\n' });
  });
}

/** Resets the shared spy-call log in the page. Call before each click. */
async function resetSpyLog(page: Page) {
  await page.evaluate(() => {
    (window as any).__oqSpyCalls = [];
  });
}

/** Reads the accumulated spy-call log back out of the page. */
async function readSpyLog(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window as any).__oqSpyCalls || []);
}

/**
 * Installs a reachability spy on `window[name]`.
 *
 * DEFECT 1 (PR #1720 comment 5560323618): the prior version of this spec
 * replaced each target global outright, so a renamed/missing handler was
 * indistinguishable from a bound one -- the spy CREATED the binding this
 * spec's own assertions exist to verify. That let the spec report `11
 * passed` while an independent no-spy probe showed every renamed target
 * throwing `ReferenceError` on a real click. Asserting `typeof
 * window[name] === 'function'` BEFORE installing anything makes that
 * failure loud instead of invisible.
 *
 * DEFECT 3 (same comment): the prior replacement discarded the original
 * function entirely, so Assertion 3 could not distinguish a genuinely dead
 * handler from one that merely changed declaration shape (e.g. `async
 * function f(` -> `const f = async function (`) -- both looked identical
 * once replaced. WRAPPING the original -- calling through to it after
 * recording the call -- means a real click still reaches real, live code,
 * so a live handler can no longer report as dead.
 *
 * Both checks below use the BARE identifier (`new Function('return ' +
 * name)`), not `window[name]`: a top-level `const`/`let`/`class` in a
 * classic (non-module) <script> is visible by name throughout the page's
 * global scope -- exactly how OQ_CARD_ACTIONS' delegated dispatcher and
 * bids.html/admin-payouts.html's inline `onclick="fn(...)"` markup resolve
 * these identifiers -- but it is NOT a `window` property. Checking only
 * `window[name]` would misreport a live `const`-declared handler as
 * nonexistent, which is DEFECT 3's own shape. Reassigning the bare
 * identifier (rather than only `window[name]`) is what makes the wrap
 * visible to those same call sites for every real handler in this
 * codebase today (each one is a `function` declaration or an explicit
 * `window.x = ...`, for which the identifier binding and the `window`
 * property ARE the same binding). A `const`/`let`/`class`-bound handler
 * cannot be reassigned this way -- JS forbids it outright -- so that
 * specific declaration style is reported as its own distinct, named
 * failure below rather than being conflated with "does not exist".
 */
async function installSpy(page: Page, name: string) {
  await page.evaluate((targetName) => {
    const original = new Function(
      `return (typeof ${targetName} !== 'undefined') ? ${targetName} : undefined;`
    )();
    if (typeof original !== 'function') {
      throw new Error(
        `[gh-1697] installSpy('${targetName}') FAILED: typeof ${targetName} is '${typeof original}', not 'function'. Refusing to install a spy on a target that doesn't exist -- doing so would create the very binding this spec's assertions exist to verify (see PR #1720 comment 5560323618).`
      );
    }
    const wrapper = (...args: unknown[]) => {
      (window as any).__oqSpyCalls.push([targetName, ...args]);
      return original.apply(window, args);
    };
    try {
      new Function(`${targetName} = arguments[0];`)(wrapper);
    } catch (err) {
      throw new Error(
        `[gh-1697] installSpy('${targetName}') FAILED: ${targetName} exists and is a live function, but its binding could not be reassigned (${(err as Error).message}). This spy can only intercept a 'function' declaration or an explicit window.${targetName} assignment -- a const/let/class-bound handler cannot be spied this way and needs a different verification strategy.`
      );
    }
  }, name);
}

/**
 * gh-1730: Assertion 2 ("a handler is actually bound") for a THIRD binding
 * kind this spec did not previously need to recognize -- a plain,
 * non-delegated `el.addEventListener('click', fn)` registered directly on
 * the control itself (contract-signing.html's #signContractBtn). Neither
 * of assertHandlerBound()'s two checks observes this: `typeof el.onclick
 * === 'function'` stays false forever (addEventListener never touches the
 * `.onclick` property, by design -- that's the whole reason DOM listeners
 * support multiple handlers per event), and there is no data-oq-action
 * ancestor marker because this binding isn't delegated.
 *
 * installListenerRegistry() closes that gap the way installSpy() closes
 * gh-1697's DEFECT 1 (assert-before-acting, not after): instrument BEFORE
 * the page's own script can call addEventListener, via page.addInitScript()
 * -- which Playwright guarantees runs before ANY page script, the same
 * ordering guarantee forceDemoMode()'s config.js patch exists to provide
 * for CONFIG.DEMO_MODE (see forceDemoMode()'s own comment). Wraps
 * EventTarget.prototype.addEventListener and records every (elementId,
 * type) pair registered on an Element that carries an id. Call this BEFORE
 * page.goto(), same ordering requirement as forceDemoMode().
 *
 * This is the closest analogue available without a CDP
 * `DOMDebugger.getEventListeners` round trip to what assertHandlerBound()
 * checks for the other two binding kinds: it observes the BINDING CALL
 * itself, not a side effect of it, so a control whose wiring silently never
 * ran (the exact #1693 failure shape, just for a different binding style)
 * is reported as unbound instead of passing by accident.
 */
async function installListenerRegistry(page: Page) {
  await page.addInitScript(() => {
    (window as any).__oqListenerLog = [];
    const origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      ...rest: unknown[]
    ) {
      if (this instanceof Element && this.id) {
        (window as any).__oqListenerLog.push([this.id, type]);
      }
      // @ts-expect-error -- forwarding the original call's exact arguments
      return origAdd.call(this, type, ...rest);
    };
  });
}

/** Assertion 2 (addEventListener binding kind): see installListenerRegistry() above. */
async function assertListenerBound(page: Page, elementId: string, eventType: string, name: string) {
  const bound = await page.evaluate(
    ({ elementId, eventType }) => {
      const log = ((window as any).__oqListenerLog || []) as [string, string][];
      return log.some(([id, type]) => id === elementId && type === eventType);
    },
    { elementId, eventType }
  );
  expect(
    bound,
    `[${name}] ASSERTION 2 (handler bound) FAILED: no addEventListener('${eventType}', ...) was recorded for #${elementId}. installListenerRegistry() instruments EventTarget.prototype.addEventListener before any page script runs (see its own comment) -- this means the binding call itself never happened, not that this check merely couldn't see it.`
  ).toBe(true);
}

async function outerHtmlOf(locator: Locator): Promise<string> {
  try {
    return await locator.evaluate((el) => (el as Element).outerHTML);
  } catch {
    return '(element could not be located for outerHTML)';
  }
}

/** Assertion 1: the control exists in the DOM. */
async function assertExists(locator: Locator, name: string) {
  const count = await locator.count();
  expect(count, `[${name}] ASSERTION 1 (exists) FAILED: control not found in the DOM.`).toBeGreaterThan(0);
}

/**
 * Assertion 2: a handler is actually bound -- either a compiled inline
 * onclick, or a data-oq-action attribute with an ancestor carrying the
 * delegated-listener marker set by bindOpportunityCardActions().
 */
async function assertHandlerBound(locator: Locator, name: string) {
  const bound = await locator.evaluate((el) => {
    const node = el as HTMLElement;
    if (typeof (node as any).onclick === 'function') return true;
    if (node.dataset && node.dataset.oqAction) {
      let ancestor: HTMLElement | null = node.parentElement;
      while (ancestor) {
        if (ancestor.dataset && ancestor.dataset.oqActionsBound === '1') return true;
        ancestor = ancestor.parentElement;
      }
    }
    return false;
  });
  if (!bound) {
    const html = await outerHtmlOf(locator);
    expect(
      bound,
      `[${name}] ASSERTION 2 (handler bound) FAILED: typeof el.onclick is not 'function', and no ancestor carries the delegated data-oq-action listener marker.\nElement: ${html}`
    ).toBe(true);
  }
}

/**
 * Assertion 3: a REAL click reaches the target function. Caller must have
 * already replaced `spyName`'s global binding with a spy (see
 * installSpies()) and called resetSpyLog() beforehand.
 */
async function assertClickReaches(
  page: Page,
  locator: Locator,
  name: string,
  spyName: string,
  expectedArgs: unknown[]
) {
  await locator.click();
  const calls = await readSpyLog(page);
  const matched = calls.filter((c) => Array.isArray(c) && c[0] === spyName);
  const matchedExact = matched.find(
    (c) => JSON.stringify(c.slice(1)) === JSON.stringify(expectedArgs)
  );
  if (!matchedExact) {
    const html = await outerHtmlOf(locator);
    expect(
      Boolean(matchedExact),
      `[${name}] ASSERTION 3 (click reaches target) FAILED: a real click did not reach ${spyName}(${expectedArgs
        .map((a) => JSON.stringify(a))
        .join(', ')}). Spy calls recorded: ${JSON.stringify(calls)}.\nElement: ${html}`
    ).toBe(true);
  }
}

/** Runs all three assertions for one entry point, in order. */
async function assertEntryPointReachable(
  page: Page,
  locator: Locator,
  name: string,
  spyName: string,
  expectedArgs: unknown[]
) {
  await assertExists(locator, name);
  await assertHandlerBound(locator, name);
  await resetSpyLog(page);
  await assertClickReaches(page, locator, name, spyName, expectedArgs);
}

// ── contractor-opportunities.html ──────────────────────────────────────
// gh-1411/gh-1621 upgrade-purchase money path + the document links + the
// bid-submission links, all produced by the page's own pure render layer
// (getDocLinksHtml / getUpgradePurchaseHtml / render). See gh-1693 for why
// these six buttons specifically were the ones that shipped dead.

test.describe('contractor-opportunities.html entry points', () => {
  const PAGE = '/contractor-opportunities.html';

  // Mirrors the exact opportunity shape init() builds from a `claims` row
  // (contractor-opportunities.html ~line 543-609), so render()'s helper
  // functions (getValueDisplay, getTradeBadges, getExpiryCountdownHtml, …)
  // don't hit an unexpected shape.
  const NORMAL_OPP = {
    id: 'reach-claim-normal',
    propertyAddress: '123 Reach St, Indianapolis, IN 46220',
    location: 'Indianapolis',
    zip: '46220',
    state: 'IN',
    jobType: 'insurance_rcv',
    trades: ['roofing'],
    damageType: 'Hail',
    damageDetail: 'Roof damage from hail',
    insuranceCarrier: 'State Farm',
    material: null,
    estimatedValue: 15000,
    acvPayout: 12000,
    deductible: 1000,
    roofSquares: 30,
    repairSquares: null,
    totalSquares: null,
    existingShingle: null,
    estimateAvailable: true,
    measurementsAvailable: true,
    // gh-1411: a numeric hoverSquares + non-'full' measurementShape is what
    // makes getUpgradePurchaseHtml() render the Buy button at all.
    hoverSquares: 30,
    measurementShape: 'basic',
    claimFiledDate: new Date().toISOString(),
    distance: 5,
    urgency: 'flexible',
    urgencyDeadline: null,
    urgencyReason: null,
    homeownerNotes: null,
    contractorScopeSummary: null,
    fundingType: 'insurance',
    releasedTrades: { roofing: true, gutters: false, siding: false, windows: false },
    bidWindowExpiresAt: null,
    estimateFilename: 'reach-claim-normal/estimate.pdf',
    measurementsFilename: 'reach-claim-normal/measurements.pdf',
    hasExpiredBid: false,
  };

  // A second, separate claim id so the Renew Bid link can be checked
  // without colliding with NORMAL_OPP's element ids.
  const EXPIRED_BID_OPP = {
    ...NORMAL_OPP,
    id: 'reach-claim-expired',
    estimateFilename: null,
    measurementsFilename: null,
    measurementsAvailable: false,
    hoverSquares: null, // no upgrade section needed for this fixture
    hasExpiredBid: true,
    expiredQuoteId: 'reach-quote-expired',
  };

  test.beforeEach(async ({ page }) => {
    await forceDemoMode(page);
    await page.goto(PAGE, { waitUntil: 'load' });

    // Replace the six target globals with spies BEFORE render() so the
    // delegated click handler (OQ_CARD_ACTIONS' closures resolve these
    // identifiers at call time, not at definition time) picks up the spy.
    // installSpy() asserts each real handler exists first, then WRAPS it
    // rather than replacing it -- see installSpy()'s own comment.
    await page.evaluate(() => {
      (window as any).__oqSpyCalls = [];
    });
    for (const name of [
      'openEstimatePdf',
      'openMeasurementsPdf',
      'openHoverPdf',
      'openUpgradePanel',
      'confirmUpgradePayment',
      'cancelUpgradePanel',
    ]) {
      await installSpy(page, name);
    }

    await page.evaluate((opps) => {
      // @ts-expect-error -- global defined by contractor-opportunities.html's own inline script
      render(opps);
    }, [NORMAL_OPP, EXPIRED_BID_OPP]);
  });

  test('doc-estimate (Loss Sheet)', async ({ page }) => {
    const loc = page.locator(`#loss-${NORMAL_OPP.id}`);
    await assertEntryPointReachable(page, loc, 'doc-estimate', 'openEstimatePdf', [NORMAL_OPP.id]);
  });

  test('doc-measurements (View Measurements)', async ({ page }) => {
    const loc = page.locator(`#measurements-${NORMAL_OPP.id}`);
    await assertEntryPointReachable(page, loc, 'doc-measurements', 'openMeasurementsPdf', [NORMAL_OPP.id]);
  });

  test('doc-hover (Measurement PDF)', async ({ page }) => {
    const loc = page.locator(`#hover-${NORMAL_OPP.id}`);
    await assertEntryPointReachable(page, loc, 'doc-hover', 'openHoverPdf', [NORMAL_OPP.id]);
  });

  test('upgrade-open (Buy Detailed Measurement Report)', async ({ page }) => {
    const loc = page.locator(`#upgrade-btn-${NORMAL_OPP.id}`);
    await assertEntryPointReachable(page, loc, 'upgrade-open', 'openUpgradePanel', [
      NORMAL_OPP.id,
      NORMAL_OPP.id, // safeId === id here (no chars stripped by the safeId sanitizer)
    ]);
  });

  test('upgrade-pay (Pay Securely)', async ({ page }) => {
    const loc = page.locator(`#upgrade-pay-btn-${NORMAL_OPP.id}`);
    // Pay Securely ships `disabled` until openUpgradePanel's real Stripe
    // init enables it, and its panel starts display:none until 'open' is
    // added. This spec replaced openUpgradePanel with a spy above (that's
    // upgrade-open's own entry point, tested separately) so nothing in this
    // test's flow performs that lifecycle -- simulate "the panel is already
    // open with a price loaded" state explicitly so THIS entry point's
    // click-reachability can be exercised on its own.
    await page.locator(`#upgrade-panel-${NORMAL_OPP.id}`).evaluate((el) => el.classList.add('open'));
    await loc.evaluate((el) => ((el as HTMLButtonElement).disabled = false));
    await assertEntryPointReachable(page, loc, 'upgrade-pay', 'confirmUpgradePayment', [
      NORMAL_OPP.id,
      NORMAL_OPP.id,
    ]);
  });

  test('upgrade-cancel (Cancel)', async ({ page }) => {
    const loc = page.locator(`#upgrade-cancel-btn-${NORMAL_OPP.id}`);
    await page.locator(`#upgrade-panel-${NORMAL_OPP.id}`).evaluate((el) => el.classList.add('open'));
    await assertEntryPointReachable(page, loc, 'upgrade-cancel', 'cancelUpgradePanel', [
      NORMAL_OPP.id,
      NORMAL_OPP.id,
    ]);
  });

  // ── Submit Bid / Renew Bid: plain navigational <a href>, not a JS handler.
  // There is no onclick to spy on -- the href itself IS the mechanism that
  // "reaches" contractor-bid-form.html, so existence + a correct href
  // collapses assertions 2 and 3 into one check for this entry-point kind.
  test('Submit Bid (contractor-opportunities.html -> contractor-bid-form.html)', async ({ page }) => {
    const card = page.locator(`.opportunity-card[data-claim-id="${NORMAL_OPP.id}"]`);
    const loc = card.getByRole('link', { name: 'Submit Bid' });
    await assertExists(loc, 'Submit Bid');
    const href = await loc.getAttribute('href');
    expect(href, `[Submit Bid] ASSERTION 2+3 (href reaches target) FAILED: unexpected href "${href}".\nElement: ${await outerHtmlOf(loc)}`).toBe(
      `contractor-bid-form.html?project=${NORMAL_OPP.id}`
    );
  });

  test('Renew Bid (contractor-opportunities.html -> contractor-bid-form.html?renew=true)', async ({ page }) => {
    const card = page.locator(`.opportunity-card[data-claim-id="${EXPIRED_BID_OPP.id}"]`);
    const loc = card.getByRole('link', { name: /Renew Bid/ });
    await assertExists(loc, 'Renew Bid');
    const href = await loc.getAttribute('href');
    const expected = `contractor-bid-form.html?renew=true&quote_id=${EXPIRED_BID_OPP.expiredQuoteId}&claim_id=${EXPIRED_BID_OPP.id}`;
    expect(href, `[Renew Bid] ASSERTION 2+3 (href reaches target) FAILED: unexpected href "${href}".\nElement: ${await outerHtmlOf(loc)}`).toBe(expected);
  });
});

// ── bids.html ───────────────────────────────────────────────────────────
// The homeowner's award action. Uses inline onclick="selectContractor(...)"
// markup (unaffected by the gh-1693 JSON.stringify-in-onclick bug -- this
// page interpolates a bare id, not a JSON.stringify()'d one -- but still a
// named money/critical-control surface per gh-1697).
//
// Unlike contractor-opportunities.html, bids.html wraps its ENTIRE inline
// script in an IIFE (`(function() { 'use strict'; ... })();`) -- `bids`,
// `contractors`, `currentClaim`, `render`, `renderBids` are all closed over
// and genuinely unreachable from outside, even via page.evaluate(). Only the
// handful of functions the page deliberately assigns onto `window`
// (selectContractor among them) cross that boundary. So this test can't
// inject a synthetic fixture the way the contractor-opportunities.html tests
// do -- instead it drives the REAL demo dataset loadDemoData()/render()
// populate under CONFIG.DEMO_MODE (bid-001 / "Hoosier Roofing Co.", a
// `pending`, non-awarded bid that renders "Select This Contractor").

test.describe('bids.html entry points', () => {
  const PAGE = '/bids.html';
  const DEMO_BID_ID = 'bid-001';
  const DEMO_CONTRACTOR_NAME = 'Hoosier Roofing Co.';

  test('Select This Contractor', async ({ page }) => {
    await forceDemoMode(page);
    await page.goto(PAGE, { waitUntil: 'load' });

    // Let the page's own demo-data init() populate #bidsGrid with real cards
    // (see loadDemoData()/render() in bids.html) before installing the spy --
    // window.selectContractor only needs to be replaced before the CLICK,
    // not before the page renders.
    await page.locator('#bidsGrid .bid-card', { hasText: DEMO_CONTRACTOR_NAME }).waitFor();

    await page.evaluate(() => {
      (window as any).__oqSpyCalls = [];
    });
    await installSpy(page, 'selectContractor');

    const card = page.locator('#bidsGrid .bid-card', { hasText: DEMO_CONTRACTOR_NAME });
    const loc = card.getByRole('button', { name: 'Select This Contractor' });
    await assertEntryPointReachable(page, loc, 'Select This Contractor', 'selectContractor', [DEMO_BID_ID]);
  });

  // gh-1730 (CTO wave-4 dispatch, #1730 comment 5572644362, priority #1):
  // "Select This Contractor" above only proves the modal OPENS --
  // window.selectContractor was itself replaced with a spy for that test,
  // so its real code (which builds #modalConfirmBtn's
  // onclick="confirmSelection()" markup) never ran. confirmSelection() is
  // the button that actually AWARDS THE CONTRACT once the homeowner
  // confirms; #1730's body: "a dead award button loses a signed contract
  // rather than a click." This test therefore does NOT spy
  // selectContractor -- it lets the real handler run so the modal (and
  // #modalConfirmBtn's real, unmodified onclick binding) exists, then
  // spies only confirmSelection before clicking "Yes, Continue".
  test('confirmSelection (Yes, Continue — awards the contract)', async ({ page }) => {
    await forceDemoMode(page);
    await page.goto(PAGE, { waitUntil: 'load' });
    await page.locator('#bidsGrid .bid-card', { hasText: DEMO_CONTRACTOR_NAME }).waitFor();

    // Real click through the REAL (unspied) selectContractor() to open the
    // confirm modal exactly as a homeowner would -- this is the only way
    // #modalConfirmBtn's onclick="confirmSelection()" markup gets wired,
    // since selectContractor() builds/restores that button (see its "Bug 5
    // fix" comment in bids.html).
    const card = page.locator('#bidsGrid .bid-card', { hasText: DEMO_CONTRACTOR_NAME });
    await card.getByRole('button', { name: 'Select This Contractor' }).click();
    await page.locator('#confirmModal.active').waitFor();

    await page.evaluate(() => {
      (window as any).__oqSpyCalls = [];
    });
    await installSpy(page, 'confirmSelection');

    // confirmSelection() takes no arguments -- it reads the module-scope
    // `pendingBidId` selectContractor() just set, not a click-time argument.
    const loc = page.locator('#modalConfirmBtn');
    await assertEntryPointReachable(page, loc, 'confirmSelection', 'confirmSelection', []);
  });
});

// ── contractor-bid-form.html ──────────────────────────────────────────────
// gh-1730 (CTO wave-4 dispatch, #1730 comment 5572644362, priority #2):
// D-215 Layer 1, the point at which a contractor accepts the platform fee
// before submitting a bid. NOT test.fixme because the controls are hard to
// find or the money path is unclear -- both are exactly where the dispatch
// says (#feeAcceptanceCheckbox / #submitBtn, wired around
// contractor-bid-form.html:4964-5053/5295) -- but because neither control's
// binding can be proven or disproven "bound" by this spec's existing
// techniques without a TIMING change to the spec's own instrumentation
// (installing a listener registry before these two addEventListener() calls
// run, not an HTML change to the controls themselves -- gh-1730 Part 2 DID
// edit contractor-bid-form.html, converting the unrelated STRICT_FILES call
// sites at 2752/4803/4837 to delegated data-oq-action listeners, but left
// #feeAcceptanceCheckbox/#submitBtn's own binding code untouched; see the PR
// body and this file's own header comment, "gh-1730" section, for the full
// reasoning on both):
//
//   #submitBtn   -- `<button type="submit" form="bidForm">`. Its behaviour
//                   lives on `bidForm.addEventListener('submit', async (e)
//                   => {...})` -- an anonymous inline arrow function, never
//                   assigned a name. installSpy() requires a bare
//                   identifier to reassign; there is no identifier here at
//                   all, named or otherwise, to install a spy on.
//
//   #feeAcceptanceCheckbox -- changes call `updateFeeCheckboxState`, which
//                   IS a named function declaration (installSpy() can
//                   locate and reassign the identifier without error) --
//                   but `_feeAcceptanceCheckbox.addEventListener('change',
//                   updateFeeCheckboxState)` already ran by the time this
//                   spec could install a spy, and addEventListener()
//                   captures the function BY VALUE at registration time.
//                   Reassigning the `updateFeeCheckboxState` identifier
//                   afterward does not change what that already-registered
//                   listener calls -- a real click would keep silently
//                   reaching the ORIGINAL function, and Assertion 3 would
//                   report a pass regardless of whether the real handler is
//                   alive or dead. Producing a green here would be exactly
//                   the false-confidence failure mode this whole spec
//                   exists to prevent (see PR #1720 comment 5560323618,
//                   quoted in installSpy()'s own comment above).
//
// Fixed by installing a listener registry (installListenerRegistry(), used
// below for contract-signing.html's #signContractBtn) BEFORE
// contractor-bid-form.html's script runs -- that observes the
// addEventListener() call itself rather than trying to intercept what it
// captured. That is a legitimate next step and does not require touching
// the button markup, only the timing of instrumentation; it is left as
// test.fixme rather than done here because implementing and proving it out
// is more than this build's remaining scope, not because it needs an HTML
// fix. Concrete next step, unblocked today: extend the
// installListenerRegistry()/assertListenerBound() pair below to also
// record 'submit'/'change' events (not just 'click'), then write these two
// tests the same shape as signContractBtn's.
test.describe('contractor-bid-form.html entry points', () => {
  test.fixme(
    'feeAcceptanceCheckbox (D-215 Layer 1 fee acceptance)',
    {
      annotation: {
        type: 'fixme',
        description:
          "gh-1730: updateFeeCheckboxState is captured BY VALUE when " +
          "_feeAcceptanceCheckbox.addEventListener('change', updateFeeCheckboxState) " +
          "registers -- installSpy()'s bare-identifier reassignment happens too late to " +
          'affect what that listener calls, so Assertion 3 cannot yet distinguish a live ' +
          "handler from a dead one for this control. Needs installListenerRegistry() " +
          "extended to 'change' events (see this file's contractor-bid-form.html header comment).",
      },
    },
    async () => {}
  );

  test.fixme(
    'submitBtn (Submit Bid)',
    {
      annotation: {
        type: 'fixme',
        description:
          "gh-1730: #submitBtn's behaviour is bidForm's anonymous inline " +
          "addEventListener('submit', async (e) => {...}) -- no named target function " +
          'exists for installSpy() to spy on. Needs installListenerRegistry() extended to ' +
          "'submit' events plus a different Assertion-3 technique (there is no target " +
          'function identifier to assert was called with expected arguments, only that ' +
          "the listener itself fired) -- see this file's contractor-bid-form.html header comment.",
      },
    },
    async () => {}
  );
});

// ── contract-signing.html ──────────────────────────────────────────────────
// gh-1730 (CTO wave-4 dispatch, #1730 comment 5572644362, priority #3):
// #signContractBtn is the signing ceremony's own Step-2 "Continue" button --
// disabled until DocuSign reports the signature complete, then advances to
// Step 3 (confirmation). Bound via `document.getElementById('signContractBtn')
// .addEventListener('click', () => { if (state.contractSigned) goToStep(3); })`
// inside setupEventListeners() -- a plain, non-delegated addEventListener()
// directly on the element, the THIRD binding kind this spec has needed (see
// installListenerRegistry() above). Unlike #feeAcceptanceCheckbox above,
// this IS provable: the arrow function calls `goToStep` by BARE IDENTIFIER
// from inside its own body, which JS resolves via a LIVE scope lookup at
// call time (not a captured value) -- installSpy()'s bare-identifier
// reassignment therefore does reach this call site, same as any inline
// onclick="fn()" markup, even though the outer listener itself is anonymous.
//
// This page has no CONFIG.DEMO_MODE data branch (unlike
// contractor-opportunities.html/bids.html): its DOMContentLoaded init()
// unconditionally queries Supabase for a real claim/contractor/bid and only
// calls setupEventListeners() after that succeeds. forceDemoMode() alone
// stops Auth.requireAuth() from redirecting away (same as every other test
// in this file) but cannot supply the claim data init() then tries to
// fetch — with no backend in this local run, init()'s own try block throws
// and lands in its catch (shows #pageError, per contract-signing.html's own
// error handling), which never reaches setupEventListeners(). Rather than
// mock every network call init() makes before that point, this test drives
// the page's own setupEventListeners()/goToStep() functions directly --
// the same "call the page's own exported functions with a synthetic state
// instead of running the real init() flow" approach this file's header
// comment describes for contractor-opportunities.html's render(), applied
// here for the same reason: init()'s failure (expected, not a defect) would
// otherwise leave the button never wired and #pageContent hidden.
test.describe('contract-signing.html entry points', () => {
  const PAGE = '/contract-signing.html?claim_id=reach-claim-signing&contractor_id=reach-contractor-signing';

  test('signContractBtn (Continue → Step 3 — the signing ceremony’s own entry point)', async ({ page }) => {
    // Must be installed before page.goto() -- see installListenerRegistry()'s
    // own comment on why this ordering is load-bearing, same requirement as
    // forceDemoMode()'s config.js patch immediately below.
    await installListenerRegistry(page);
    await forceDemoMode(page);
    await page.goto(PAGE, { waitUntil: 'load' });

    await page.evaluate(() => {
      // @ts-expect-error -- globals defined by contract-signing.html's own inline script
      document.getElementById('pageContent').style.display = 'block';
      // @ts-expect-error
      setupEventListeners();
      // @ts-expect-error
      goToStep(2);
      // Step 2's Continue button ships `disabled` until the real DocuSign
      // flow reports a signature; simulate "already signed" the same way
      // bids.html's upgrade-pay test simulates "panel already open with a
      // price loaded" (see that test's comment above) to exercise this
      // entry point on its own, without driving the DocuSign iframe.
      // @ts-expect-error
      document.getElementById('signContractBtn').disabled = false;
      // @ts-expect-error
      state.contractSigned = true;
    });

    const loc = page.locator('#signContractBtn');
    await assertExists(loc, 'signContractBtn');
    await assertListenerBound(page, 'signContractBtn', 'click', 'signContractBtn');

    await page.evaluate(() => {
      (window as any).__oqSpyCalls = [];
    });
    await installSpy(page, 'goToStep');
    await resetSpyLog(page);
    await assertClickReaches(page, loc, 'signContractBtn', 'goToStep', [3]);
  });
});

// ── admin-payouts.html ─────────────────────────────────────────────────
// Approve/Reject the release of a referral/recruit-bonus payout.

test.describe('admin-payouts.html entry points', () => {
  const PAGE = '/admin-payouts.html';

  const PAYOUT = {
    id: 'reach-payout-1',
    status: 'pending_approval',
    partner_name: 'Reach Partner',
    trigger_event: 'referral bonus — reach fixture',
    amount: 250,
    created_at: new Date().toISOString(),
    payout_type: 'commission_referral',
    _job_complete: true,
  };

  test.beforeEach(async ({ page }) => {
    await forceDemoMode(page);
    await page.goto(PAGE, { waitUntil: 'load' });

    await page.evaluate(() => {
      (window as any).__oqSpyCalls = [];
    });
    for (const name of ['handleApprove', 'showRejectForm']) {
      await installSpy(page, name);
    }

    await page.evaluate((payout) => {
      // @ts-expect-error -- globals defined by admin-payouts.html's own inline script
      allPayouts = [payout];
      // @ts-expect-error
      currentFilter = 'all';
      // @ts-expect-error
      renderTable();
    }, PAYOUT);
  });

  test('Approve', async ({ page }) => {
    const row = page.locator(`#row-${PAYOUT.id}`);
    const loc = row.getByRole('button', { name: 'Approve' });
    // handleApprove(approvalId, btn) -- the second arg is the clicked
    // button element itself, which Playwright's click() supplies via the
    // real DOM `this`; only the id argument is asserted here since the
    // element identity itself isn't meaningfully comparable via JSON.
    await assertExists(loc, 'Approve');
    await assertHandlerBound(loc, 'Approve');
    await resetSpyLog(page);
    await loc.click();
    const calls = await readSpyLog(page);
    const matched = calls.find((c) => Array.isArray(c) && c[0] === 'handleApprove' && c[1] === PAYOUT.id);
    expect(
      Boolean(matched),
      `[Approve] ASSERTION 3 (click reaches target) FAILED: a real click did not reach handleApprove("${PAYOUT.id}", <button>). Spy calls recorded: ${JSON.stringify(calls)}.\nElement: ${await outerHtmlOf(loc)}`
    ).toBe(true);
  });

  test('Reject', async ({ page }) => {
    const row = page.locator(`#row-${PAYOUT.id}`);
    const loc = row.getByRole('button', { name: 'Reject' });
    await assertExists(loc, 'Reject');
    await assertHandlerBound(loc, 'Reject');
    await resetSpyLog(page);
    await loc.click();
    const calls = await readSpyLog(page);
    const matched = calls.find((c) => Array.isArray(c) && c[0] === 'showRejectForm' && c[1] === PAYOUT.id);
    expect(
      Boolean(matched),
      `[Reject] ASSERTION 3 (click reaches target) FAILED: a real click did not reach showRejectForm("${PAYOUT.id}", <button>). Spy calls recorded: ${JSON.stringify(calls)}.\nElement: ${await outerHtmlOf(loc)}`
    ).toBe(true);
  });
});
