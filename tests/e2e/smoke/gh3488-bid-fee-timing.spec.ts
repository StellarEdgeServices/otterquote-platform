/**
 * gh-3488 / D-267 (REVIEW 6674426561): two timing paths on contractor-bid-form.html that let a contractor be
 * charged a fee that differs from the one on screen or on record.
 *
 *   1. A bid edited while submit is running recorded one fee and stored/charged another (submit read the bid
 *      once for the accepted fee and again for the stored price, with awaits and editable inputs in between).
 *   2. A click while the fee lookup is in flight recorded a figure that was not on the disclosure.
 *
 * This spec loads the REAL page in Chromium. Only the Supabase client, Auth and ipify are replaced (by route
 * fulfilment and an init script); every function exercised is the page's own. "Charge" below is the shared
 * platformFeeCents applied to the stored total_price, exactly what docusign-webhook does.
 */
import { test, expect, type Page } from '@playwright/test';

const PAGE = '/contractor-bid-form.html?claim_id=claim-1';

const FAKE_SUPABASE = `
(() => {
  const t = (window.__t = { calls: [], inserts: [], feeCalls: 0, feeWaiters: [], feeMode: 'immediate', feePct: '5.00', feeByState: {}, feeQueries: [] });
  const claim = { id: 'claim-1', trades: ['roofing'], selected_trades: ['roofing'], job_type: 'retail', funding_type: 'retail',
    damage_type: 'hail', material_category: 'shingle', is_test: true, rcv_amount: null, parsed_line_items: null, state: 'IN' };
  const contractor = { id: 'c-1', user_id: 'u-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z',
    coi_file_url: 'x', coi_expires_at: '2099-01-01', cpa_version: 'v1-2026-04', needs_cpa_reattestation: false,
    company_name: 'Acme Roofing', phone: '5551234567', trades: ['roofing'], service_area_description: 'IN', address_state: 'IN', is_test: true };
  const existing = { id: 'q-1', claim_id: 'claim-1', contractor_id: 'c-1', total_price: 18000, bid_status: 'active', platform_fee_pct: 5, scope_summary: '{}', trade_type: 'roofing' };
  async function run(s) {
    // gh-3491: a call named in __t.hang never answers (armed by the test once the form is filled)
    if (t.hang && t.hang.includes(s.table + ':' + s.op)) { t.hung = (t.hung || 0) + 1; await new Promise(() => {}); }
    if (s.table === 'quotes' && s.op === 'select' && t.changeMode) return { data: existing, error: null };
    if (s.op === 'insert' || s.op === 'update' || s.op === 'upsert') {
      t.inserts.push({ table: s.table, op: s.op, payload: JSON.parse(JSON.stringify(s.payload)) });
      const row = Object.assign({ id: s.table + '-1' }, s.payload && !Array.isArray(s.payload) ? s.payload : {});
      return { data: s.single ? row : [row], error: null };
    }
    if (s.table === 'platform_fee_config') {
      t.feeCalls++;
      const i = t.feeCalls - 1;
      t.feeQueries.push((s.ors || []).join(' | '));
      if (t.feeMode === 'hang') await new Promise(() => {});
      if (t.feeMode === 'deferred') await new Promise((res) => { t.feeWaiters[i] = (pct) => res(pct); }).then((pct) => { t.feePct = pct; });
      const st = ((s.ors || [])[0] || '').match(/state\.eq\.([A-Za-z]*)/);
      const stateKey = st ? st[1].toUpperCase() : '';
      return { data: [{ fee_pct: t.feeByState[stateKey] !== undefined ? t.feeByState[stateKey] : t.feePct }], error: null };
    }
    if (s.table === 'bidder_claim_summary') return { data: claim, error: null };
    if (s.table === 'contractors') return { data: contractor, error: null };
    return { data: s.single ? null : [], error: null };
  }
  function builder(table) {
    const s = { table, op: 'select', payload: null, single: false };
    const b = new Proxy({}, { get(_, prop) {
      if (prop === 'then') return (res, rej) => run(s).then(res, rej);
      if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') return (p) => { s.op = prop; s.payload = p; return b; };
      if (prop === 'single' || prop === 'maybeSingle') return () => { s.single = true; return b; };
      if (prop === 'or') return (arg) => { (s.ors = s.ors || []).push(arg); return b; };
      return () => b;
    } });
    return b;
  }
  const user = { id: 'u-1', email: 'c@example.test' };
  const client = {
    from: builder,
    rpc: async (name) => { t.calls.push(name); return { data: name === 'bid_can_submit' ? { can_submit: true } : null, error: null }; },
    functions: { invoke: async (name, o) => { t.calls.push('fn:' + name); (t.fnBodies = t.fnBodies || {})[name] = o && o.body; return { data: {}, error: null }; } },
    auth: { getUser: async () => ({ data: { user }, error: null }), getSession: async () => ({ data: { session: { user } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }), createSignedUrl: async () => ({ data: null, error: null }) }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
  };
  window.supabase = { createClient: () => client };
  window.__releaseFee = (i, pct) => t.feeWaiters[i] && t.feeWaiters[i](pct);
})();
`;

const FAKE_AUTH = `
window.Auth = new Proxy({ requireAuth: async () => ({ id: 'u-1', email: 'c@example.test' }) },
  { get: (t, k) => (k in t ? t[k] : async () => null) });
`;

async function openForm(page: Page, opts: { ipifyGate?: boolean; ipifyHang?: boolean; changeMode?: boolean } = {}) {
  const waiting: Array<() => void> = [];
  const gate: { release: () => void } = { release: () => { waiting.forEach((r) => r()); waiting.length = 0; } };
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1')) {
      if (url.includes('/js/auth.js')) return route.fulfill({ contentType: 'text/javascript', body: FAKE_AUTH });
      if (url.includes('/contractor-bid-form.html')) {
        // the CDN script is replaced below, so its SRI hash can no longer match: drop the attribute for this test only
        const res = await route.fetch();
        const body = (await res.text()).replace(/(<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^>]*?)\s+integrity="[^"]*"/, '$1');
        return route.fulfill({ response: res, body });
      }
      return route.continue();
    }
    if (url.includes('supabase-js') || url.includes('supabase.js')) {
      return route.fulfill({ contentType: 'text/javascript', body: opts.changeMode ? FAKE_SUPABASE.replace("feeMode: 'immediate'", "feeMode: 'immediate', changeMode: true") : FAKE_SUPABASE });
    }
    if (url.includes('api.ipify.org')) {
      if (opts.ipifyHang) await new Promise<void>(() => {});
      if (opts.ipifyGate) await new Promise<void>((res) => { waiting.push(res); });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ip: '203.0.113.9' }) });
    }
    return route.abort();
  });
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as any).__t && document.getElementById('retailBidPrice'));
  await page.waitForFunction(() => (window as any).isRetailJob === true || (document.getElementById('retailBidPrice') as HTMLElement).offsetParent !== null);
  return gate;
}

async function fillRequired(page: Page) {
  // Satisfy HTML validity and the Section 2 value-add declarations (gh-1377) for the retail path, with real values.
  await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    (VALUE_ADD_DECLARATION_ROWS as any[]).forEach((r) => {
      const radio = document.querySelector<HTMLInputElement>('input[name="' + r.radioName + '"]');
      if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    document.querySelectorAll<HTMLInputElement>('#bidForm input[required], #bidForm select[required], #bidForm textarea[required]').forEach((el) => {
      if (el.type === 'checkbox' || el.type === 'radio') { el.checked = true; return; }
      if (el.tagName === 'SELECT') { const o = Array.from((el as unknown as HTMLSelectElement).options).find((x) => x.value); if (o) (el as unknown as HTMLSelectElement).value = o.value; return; }
      if (!el.value) el.value = el.type === 'number' ? '100' : 'x';
    });
  });
}

const disclosure = (page: Page) =>
  page.evaluate(() => ({
    pct: document.getElementById('feePercentDisplay')!.textContent,
    disclosure: document.getElementById('feeDollarDisplay')!.textContent,
    checkbox: document.getElementById('feeDollarCheckbox')!.textContent,
  }));
const breakdown = (page: Page) =>
  page.evaluate(() => ({
    signing: document.getElementById('feeContractSigning')!.textContent,
    total: document.getElementById('totalFeeAmount')!.textContent,
    net: document.getElementById('yourNet')!.textContent,
    netInline: document.getElementById('netToContractorBidRow')!.textContent,
  }));
const inserted = (page: Page, table: string) =>
  page.evaluate((tb) => ((window as any).__t.inserts as any[]).filter((i) => i.table === tb), table);

async function typeBid(page: Page, v: string) {
  await page.locator('#retailBidPrice').fill(v);
}
async function acceptFee(page: Page) {
  await page.evaluate(() => {
    const cb = document.getElementById('feeAcceptanceCheckbox') as HTMLInputElement;
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function clickSubmit(page: Page) {
  await page.evaluate(() => (document.getElementById('submitBtn') as HTMLButtonElement).click());
}

test.describe('gh-3488 contractor-bid-form.html fee timing (real page, Chromium)', () => {
  test('(1) control: no edit during submit records, stores and charges one figure', async ({ page }) => {
    const gate = await openForm(page, { ipifyGate: true });
    await typeBid(page, '18500');
    await fillRequired(page);
    await acceptFee(page);
    await clickSubmit(page);
    await expect.poll(() => page.evaluate(() => document.getElementById('submitBtn')!.textContent)).toContain('Submitting');
    gate.release();
    await expect.poll(async () => (await inserted(page, 'quotes')).length).toBe(1);
    const q = (await inserted(page, 'quotes'))[0].payload;
    expect(q.total_price).toBe(18500);
    await expect.poll(async () => (await inserted(page, 'fee_acceptances')).length).toBe(1);
    const fa = (await inserted(page, 'fee_acceptances'))[0].payload;
    expect(fa.fee_amount).toBe(925);
    expect(fa.fee_text_displayed).toContain('$925.00');
  });

  test('(1) a bid edited while submit is running cannot change what is recorded, stored or charged', async ({ page }) => {
    const gate = await openForm(page, { ipifyGate: true });
    await typeBid(page, '18500');
    await fillRequired(page);
    await acceptFee(page);
    await clickSubmit(page);
    await expect.poll(() => page.evaluate(() => document.getElementById('submitBtn')!.textContent)).toContain('Submitting');

    // The price input is locked while submit runs (fails on 93833044: disabled=false, readOnly=false).
    const locked = await page.evaluate(() => {
      const el = document.getElementById('retailBidPrice') as HTMLInputElement;
      return el.readOnly || el.disabled;
    });
    expect(locked).toBe(true);
    // A real edit attempt does not take...
    await page.locator('#retailBidPrice').fill('25000', { timeout: 1000 }).catch(() => {});
    // ...and even a programmatic sync of the hidden price (what the page's own scripts do) cannot move the record.
    await page.evaluate(() => {
      (document.getElementById('retailBidPrice') as HTMLInputElement).value = '25000';
      (document.getElementById('totalPrice') as HTMLInputElement).value = '25000';
    });
    gate.release();

    await expect.poll(async () => (await inserted(page, 'quotes')).length).toBe(1);
    const q = (await inserted(page, 'quotes'))[0].payload;
    await expect.poll(async () => (await inserted(page, 'fee_acceptances')).length).toBe(1);
    const fa = (await inserted(page, 'fee_acceptances'))[0].payload;
    const chargeCents = await page.evaluate((tp) => (window as any).platformFeeCents(tp, 5), q.total_price);
    // stored price, accepted fee and charge are one figure: $18,500 -> $925.00 -> 92500 cents
    expect(q.total_price).toBe(18500);
    expect(fa.fee_amount).toBe(925);
    expect(chargeCents).toBe(Math.round(fa.fee_amount * 100));
    // and the inputs are unlocked again once submit has finished
    await expect.poll(() => page.evaluate(() => {
      const el = document.getElementById('retailBidPrice') as HTMLInputElement;
      return el.readOnly || el.disabled;
    })).toBe(false);
  });

  test('(2) the disclosure and checkbox figures never lag the bid, even while the rate lookup is in flight', async ({ page }) => {
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.feeMode = 'deferred'; });
    await typeBid(page, '18500');
    await page.waitForTimeout(100);
    await typeBid(page, '25000');
    // the lookup for $25,000 has not returned; the figures on screen must already be for $25,000
    const d = await disclosure(page);
    expect(d.disclosure).toBe('$1,250.00');
    expect(d.checkbox).toBe('$1,250.00');
  });

  test('(2) a click while the lookup is in flight, where the rate then changes, shows the new disclosure and needs a fresh acceptance', async ({ page }) => {
    await openForm(page);
    await fillRequired(page);
    await typeBid(page, '25000');
    await expect.poll(async () => (await disclosure(page)).disclosure).toBe('$1,250.00');
    await page.evaluate(() => { (window as any).__t.feeMode = 'deferred'; });
    await typeBid(page, '25001');                      // starts a lookup that stays in flight
    await acceptFee(page);                             // the contractor ticks the box reading $1,250.05
    await clickSubmit(page);                           // clicks while the lookup is still in flight
    await page.waitForTimeout(150);
    expect((await inserted(page, 'quotes')).length).toBe(0);   // submit waits for the lookup (93833044: already inserted)
    const lookups = await page.evaluate(() => (window as any).__t.feeCalls);
    await page.evaluate(() => { (window as any).__t.feeMode = 'immediate'; });   // the fresh lookup at submit answers at once
    await page.evaluate((i) => (window as any).__releaseFee(i, '7.50'), lookups - 1);   // the configured rate is now 7.50
    await expect.poll(() => page.evaluate(() => document.getElementById('feePercentDisplay')!.textContent)).toBe('7.50');
    const d = await disclosure(page);
    expect(d.disclosure).toBe('$1,875.08');            // 7.5% of 25001.00, half-up
    // LEGAL-READ 6674806511: the breakdown and both net lines carry the SAME rate's figures as the disclosure
    expect(await breakdown(page)).toEqual({ signing: '$1,875.08', total: '$1,875.08', net: '$23,125.92', netInline: 'Net to you: $23,125.92' });
    expect(await page.evaluate(() => (document.getElementById('feeAcceptanceCheckbox') as HTMLInputElement).checked)).toBe(false);
    expect((await inserted(page, 'quotes')).length).toBe(0);
    expect((await inserted(page, 'fee_acceptances')).length).toBe(0);
    // the contractor accepts the NEW disclosure and submits; what is recorded is what was on screen
    await acceptFee(page);
    await clickSubmit(page);
    await expect.poll(async () => (await inserted(page, 'fee_acceptances')).length).toBe(1);
    const fa = (await inserted(page, 'fee_acceptances'))[0].payload;
    expect(fa.fee_amount).toBe(1875.08);
    expect(fa.fee_text_displayed).toContain('$1,875.08 (7.50% of your bid)');
  });

  test('(2) a click while the lookup is in flight, where the figure does not change, goes through after the wait', async ({ page }) => {
    await openForm(page);
    await fillRequired(page);
    await typeBid(page, '25000');
    await expect.poll(async () => (await disclosure(page)).disclosure).toBe('$1,250.00');
    await page.evaluate(() => { (window as any).__t.feeMode = 'deferred'; });
    await typeBid(page, '18500');
    await acceptFee(page);
    await clickSubmit(page);
    await page.waitForTimeout(150);
    expect((await inserted(page, 'quotes')).length).toBe(0);
    const lookups = await page.evaluate(() => (window as any).__t.feeCalls);
    await page.evaluate(() => { (window as any).__t.feeMode = 'immediate'; });
    await page.evaluate((i) => (window as any).__releaseFee(i, '5.00'), lookups - 1);
    await expect.poll(async () => (await inserted(page, 'fee_acceptances')).length).toBe(1);
    const fa = (await inserted(page, 'fee_acceptances'))[0].payload;
    expect(fa.fee_amount).toBe(925);
    expect(fa.fee_text_displayed).toContain('$925.00 (5.00% of your bid)');
  });

  // ── REVIEW 6674889982 / LEGAL-READ 6674806511 (head 3fc20d19) ──────────────────────────────────────────────

  test('(LEGAL) a rate returned by a lookup after the price is typed updates the breakdown and net lines too', async ({ page }) => {
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.feeMode = 'deferred'; });
    await typeBid(page, '25000');
    const lookups = await page.evaluate(() => (window as any).__t.feeCalls);
    await page.evaluate(() => { (window as any).__t.feeMode = 'immediate'; });
    await page.evaluate((i) => (window as any).__releaseFee(i, '7.50'), lookups - 1);
    await expect.poll(() => page.evaluate(() => document.getElementById('feePercentDisplay')!.textContent)).toBe('7.50');
    expect((await disclosure(page)).disclosure).toBe('$1,875.00');
    expect(await breakdown(page)).toEqual({ signing: '$1,875.00', total: '$1,875.00', net: '$23,125.00', netInline: 'Net to you: $23,125.00' });
  });

  test('(LEGAL) a rate that moved since the last lookup, with nothing in flight, is caught at submit and needs re-acceptance', async ({ page }) => {
    await openForm(page);
    await fillRequired(page);
    await typeBid(page, '25000');
    await expect.poll(async () => (await disclosure(page)).disclosure).toBe('$1,250.00');
    await acceptFee(page);
    await page.evaluate(() => { (window as any).__t.feePct = '7.50'; });     // the server's rate moves; the page has not looked
    await clickSubmit(page);
    await expect.poll(() => page.evaluate(() => document.getElementById('feePercentDisplay')!.textContent)).toBe('7.50');
    await page.waitForTimeout(300);
    expect((await inserted(page, 'quotes')).length).toBe(0);                  // 3fc20d19: inserted with fee_pct 5, charged at 7.5
    expect((await inserted(page, 'fee_acceptances')).length).toBe(0);
    expect((await disclosure(page)).disclosure).toBe('$1,875.00');
    expect(await page.evaluate(() => (document.getElementById('feeAcceptanceCheckbox') as HTMLInputElement).checked)).toBe(false);
    await acceptFee(page);
    await clickSubmit(page);
    await expect.poll(async () => (await inserted(page, 'fee_acceptances')).length).toBe(1);
    expect((await inserted(page, 'fee_acceptances'))[0].payload.fee_amount).toBe(1875);
  });

  test('(LEGAL) the fee lookup uses the contractor\'s address_state, the column the server reads', async ({ page }) => {
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.feeByState = { IN: '7.50' }; });   // a state-specific row for IN
    await typeBid(page, '25000');
    await expect.poll(() => page.evaluate(() => document.getElementById('feePercentDisplay')!.textContent)).toBe('7.50');
    const queries: string[] = await page.evaluate(() => (window as any).__t.feeQueries);
    expect(queries.some((q) => q.includes('state.eq.IN'))).toBe(true);        // 3fc20d19: state.eq. (blank)
  });

  test('(LEGAL) a tick is cleared when the bid changes', async ({ page }) => {
    await openForm(page);
    await typeBid(page, '18500');
    await acceptFee(page);
    expect(await page.evaluate(() => (document.getElementById('feeAcceptanceCheckbox') as HTMLInputElement).checked)).toBe(true);
    await typeBid(page, '19000');
    expect(await page.evaluate(() => (document.getElementById('feeAcceptanceCheckbox') as HTMLInputElement).checked)).toBe(false);
    expect(await page.evaluate(() => (document.getElementById('submitBtn') as HTMLButtonElement).disabled)).toBe(true);
  });

  test('(REVIEW) a fee lookup that never returns times out and the bid still files, with no stuck form', async ({ page }) => {
    test.setTimeout(40000);
    await openForm(page);
    await fillRequired(page);
    await page.evaluate(() => { (window as any).__t.feeMode = 'hang'; });   // every lookup from here on never returns
    await typeBid(page, '18500');                                  // a lookup is open (and stays open)
    expect((await disclosure(page)).disclosure).toBe('$925.00');   // the figure on screen is already right
    await acceptFee(page);
    await clickSubmit(page);
    await expect.poll(async () => (await inserted(page, 'quotes')).length, { timeout: 20000 }).toBe(1);   // 3fc20d19: stuck on "Submitting…"
    expect((await inserted(page, 'quotes'))[0].payload.total_price).toBe(18500);
    await expect.poll(async () => (await inserted(page, 'fee_acceptances')).length, { timeout: 10000 }).toBe(1);
    expect((await inserted(page, 'fee_acceptances'))[0].payload.fee_amount).toBe(925);
  });

  test('(REVIEW) an ipify call that never returns times out and records no IP (null, never the string unknown: fee_acceptances.ip_address is inet)', async ({ page }) => {
    test.setTimeout(40000);
    await openForm(page, { ipifyHang: true });
    await fillRequired(page);
    await typeBid(page, '18500');
    await acceptFee(page);
    await clickSubmit(page);
    await expect.poll(async () => (await inserted(page, 'fee_acceptances')).length, { timeout: 20000 }).toBe(1);
    const fa = (await inserted(page, 'fee_acceptances'))[0].payload;
    expect(fa.ip_address).toBeNull();   // gh-3409: 'unknown' is not an inet value
  });

  test('(REVIEW) a real double click files one bid, also when a lookup returns between the two clicks', async ({ page }) => {
    const gate = await openForm(page, { ipifyGate: true });
    await fillRequired(page);
    await typeBid(page, '25000');
    await expect.poll(async () => (await disclosure(page)).disclosure).toBe('$1,250.00');
    await page.evaluate(() => { (window as any).__t.feeMode = 'deferred'; });
    await typeBid(page, '18500');                                  // a lookup is open
    await acceptFee(page);
    await page.locator('#submitBtn').scrollIntoViewIfNeeded();
    const box = (await page.locator('#submitBtn').boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.click(x, y);                                  // real click 1
    const lookups = await page.evaluate(() => (window as any).__t.feeCalls);
    await page.evaluate(() => { (window as any).__t.feeMode = 'immediate'; });
    await page.evaluate((i) => (window as any).__releaseFee(i, '5.00'), lookups - 1);   // the lookup returns during the submit
    await page.waitForTimeout(250);
    await page.mouse.click(x, y);                                  // real click 2, 3fc20d19: the button is live again
    await page.mouse.click(x, y, { clickCount: 2, delay: 20 });    // and a real double click
    gate.release();
    await expect.poll(async () => (await inserted(page, 'fee_acceptances')).length).toBeGreaterThan(0);
    await page.waitForTimeout(600);
    expect((await inserted(page, 'quotes')).length).toBe(1);
    expect((await inserted(page, 'fee_acceptances')).length).toBe(1);
  });

  test('(REVIEW) a lookup returning mid-submit, or a tick toggle, cannot re-enable the button; the success screen stays disabled', async ({ page }) => {
    const gate = await openForm(page, { ipifyGate: true });
    await fillRequired(page);
    await typeBid(page, '25000');
    await expect.poll(async () => (await disclosure(page)).disclosure).toBe('$1,250.00');
    await page.evaluate(() => { (window as any).__t.feeMode = 'deferred'; });
    await typeBid(page, '18500');                                  // a lookup is now open
    await acceptFee(page);
    await page.locator('#submitBtn').click();                      // real click while the lookup is open
    const lookups = await page.evaluate(() => (window as any).__t.feeCalls);
    await page.evaluate(() => { (window as any).__t.feeMode = 'immediate'; });
    await page.evaluate((i) => (window as any).__releaseFee(i, '5.00'), lookups - 1);   // the lookup returns during the submit
    await page.waitForTimeout(300);
    const mid = await page.evaluate(() => ({
      btnDisabled: (document.getElementById('submitBtn') as HTMLButtonElement).disabled,
      boxDisabled: (document.getElementById('feeAcceptanceCheckbox') as HTMLInputElement).disabled,
    }));
    expect(mid.btnDisabled).toBe(true);                            // 3fc20d19: false
    expect(mid.boxDisabled).toBe(true);                            // 3fc20d19: false (the box was not locked)
    await page.locator('#submitBtn').click({ force: true }).catch(() => {});
    gate.release();
    await expect.poll(() => page.evaluate(() => document.getElementById('successState')?.classList.contains('show'))).toBe(true);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (document.getElementById('submitBtn') as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('#submitBtn').click({ force: true }).catch(() => {});   // the click on the success screen
    await page.waitForTimeout(500);
    expect((await inserted(page, 'quotes')).length).toBe(1);
    expect((await inserted(page, 'fee_acceptances')).length).toBe(1);
  });

  // gh-3491 (REVIEW 6688103147): the Change Bid UPDATE is the one await the submit lock made un-escapable.
  test('(REVIEW) a Change Bid UPDATE that never answers ends with a message and an unlocked form, and a retry files once', async ({ page }) => {
    test.setTimeout(60000);
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
    await openForm(page, { changeMode: true });
    await fillRequired(page);
    await typeBid(page, '18500');
    await acceptFee(page);
    await page.evaluate(() => { (window as any).__t.hang = ['quotes:update']; });
    await clickSubmit(page);
    // the UPDATE is held open; once its bound passes the form must be usable again
    await expect.poll(() => dialogs.length, { timeout: 30000 }).toBe(1);
    expect(dialogs[0]).toContain('Error submitting bid');
    const st = await page.evaluate(() => {
      const b = document.getElementById('submitBtn') as HTMLButtonElement; const p = document.getElementById('retailBidPrice') as HTMLInputElement;
      return { btn: b.textContent!.trim(), disabled: b.disabled, priceLocked: p.readOnly || p.disabled, updates: ((window as any).__t.inserts as any[]).filter((i) => i.table === 'quotes').length };
    });
    expect(st).toEqual({ btn: 'Update Bid', disabled: false, priceLocked: false, updates: 0 });   // bab62017: Submitting…, disabled, locked, no message
    // retry with the connection back: one UPDATE, success screen
    await page.evaluate(() => { (window as any).__t.hang = []; });
    await clickSubmit(page);
    await expect.poll(async () => (await inserted(page, 'quotes')).length, { timeout: 10000 }).toBe(1);
    expect((await inserted(page, 'quotes'))[0].op).toBe('update');
    expect((await inserted(page, 'quotes'))[0].payload.total_price).toBe(18500);
  });
});
