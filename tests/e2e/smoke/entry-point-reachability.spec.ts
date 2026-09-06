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
 *
 * The six #1693-regression entry points are the first six rows above --
 * those are the ones the gh-1697 closing criterion's negative control
 * (commit 0aa1d61) must show failing. Submit Bid/Renew Bid/Select This
 * Contractor/Approve/Reject were never broken by that bug (they don't use
 * the JSON.stringify-inside-onclick pattern); they're included here because
 * gh-1697 names them as money/critical-control surfaces this mechanism must
 * also cover going forward.
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
    await page.evaluate(() => {
      (window as any).__oqSpyCalls = [];
      const spy = (name: string) => (...args: unknown[]) => {
        (window as any).__oqSpyCalls.push([name, ...args]);
      };
      (window as any).openEstimatePdf = spy('openEstimatePdf');
      (window as any).openMeasurementsPdf = spy('openMeasurementsPdf');
      (window as any).openHoverPdf = spy('openHoverPdf');
      (window as any).openUpgradePanel = spy('openUpgradePanel');
      (window as any).confirmUpgradePayment = spy('confirmUpgradePayment');
      (window as any).cancelUpgradePanel = spy('cancelUpgradePanel');
    });

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
      (window as any).selectContractor = (...args: unknown[]) => {
        (window as any).__oqSpyCalls.push(['selectContractor', ...args]);
      };
    });

    const card = page.locator('#bidsGrid .bid-card', { hasText: DEMO_CONTRACTOR_NAME });
    const loc = card.getByRole('button', { name: 'Select This Contractor' });
    await assertEntryPointReachable(page, loc, 'Select This Contractor', 'selectContractor', [DEMO_BID_ID]);
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
      const spy = (name: string) => (...args: unknown[]) => {
        (window as any).__oqSpyCalls.push([name, ...args]);
      };
      (window as any).handleApprove = spy('handleApprove');
      (window as any).showRejectForm = spy('showRejectForm');
    });

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
