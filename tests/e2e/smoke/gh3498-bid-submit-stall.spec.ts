/**
 * gh-3498 (REVIEW 6675274132 on PR #3491): a stalled bid_can_submit or quote insert must end with a message and an unlocked
 * form, and a retry after a timed-out insert must not file a second bid.
 *
 * Loads the REAL contractor-bid-form.html in Chromium. Only the Supabase client, Auth and ipify are replaced. The fake
 * database behaves like production for the cases under test: a request that is aborted rejects (as fetch does); an insert
 * can land and then never answer; a second insert with the same idempotency_key fails 23505 on quotes_idempotency_key_uidx.
 * Time is driven with page.clock, so a 20 s limit does not take 20 s.
 */
import { test, expect, type Page } from '@playwright/test';

const PAGE = '/contractor-bid-form.html?claim_id=claim-1';

const FAKE_SUPABASE = `
(() => {
  const t = (window.__t = { gateMode: 'ok', insertMode: 'ok', rows: [], inserts: [], keyed: [], calls: [], aborted: 0, readbacks: 0,
    hang: [], hung: 0, changeMode: /__change=1/.test(location.search),
    // gh-3498 (REVIEW 6740720167): lookups by (claim_id, contractor_id); hideFromLookup = a landed row the lookup does not see
    // yet (the insert lands after it); noColumn = the idempotency_key column does not exist yet (migration not applied)
    lookups: 0, hideFromLookup: false, noColumn: false });
  // gh-3498 (widened closes-on): t.hang names calls that never answer ('table:op' or 'fn:name'); t.changeMode loads an existing bid.
  const existing = { id: 'q-1', claim_id: 'claim-1', contractor_id: 'c-1', total_price: 18000, bid_status: /__cancelled=1/.test(location.search) ? 'cancelled' : 'active', platform_fee_pct: 5, scope_summary: '{}', trade_type: 'roofing' };
  const claim = { id: 'claim-1', trades: ['roofing'], selected_trades: ['roofing'], job_type: 'retail', funding_type: 'retail',
    damage_type: 'hail', material_category: 'shingle', is_test: true, rcv_amount: null, parsed_line_items: null, state: 'IN' };
  const contractor = { id: 'c-1', user_id: 'u-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z',
    coi_file_url: 'x', coi_expires_at: '2099-01-01', cpa_version: 'v1-2026-04', needs_cpa_reattestation: false,
    company_name: 'Acme Roofing', phone: '5551234567', trades: ['roofing'], service_area_description: 'IN', address_state: 'IN', is_test: true };
  const hang = (s) => new Promise((_, rej) => { if (s.signal) s.signal.addEventListener('abort', () => { t.aborted++; rej(s.signal.reason); }); });
  async function run(s) {
    if (t.hang.includes(s.table + ':' + s.op)) { t.hung++; return hang(s); }
    if (s.op === 'update') {
      t.inserts.push({ table: s.table, op: 'update', payload: JSON.parse(JSON.stringify(s.payload)) });
      return { data: [{ id: s.table === 'quotes' ? 'q-1' : s.table + '-1' }], error: null };
    }
    if (s.op === 'insert') {
      t.inserts.push({ table: s.table, op: 'insert', payload: JSON.parse(JSON.stringify(s.payload)) });
      if (s.table === 'quotes') {
        const key = s.payload.idempotency_key;
        if (key) t.keyed.push(key);
        if ((t.insertMode === 'nocolumn' || t.noColumn) && key) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'idempotency_key' column of 'quotes' in the schema cache" } };
        if (key && t.rows.some((r) => r.idempotency_key === key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "quotes_idempotency_key_uidx"', details: 'Key (idempotency_key)=(' + key + ') already exists.' } };
        }
        const row = Object.assign({ id: 'quote-' + (t.rows.length + 1) }, s.payload);
        if (t.insertMode === 'hang') return hang(s);
        t.rows.push(row);                       // the insert lands...
        if (t.insertMode === 'land_then_hang') return hang(s); // ...and the answer never arrives
        return { data: s.single ? row : [row], error: null };
      }
      return { data: s.single ? { id: s.table + '-1' } : [{ id: s.table + '-1' }], error: null };
    }
    if (s.table === 'quotes' && (s.eqs || []).some((e) => e[0] === 'idempotency_key')) {
      t.readbacks++;
      const k = s.eqs.find((e) => e[0] === 'idempotency_key')[1];
      return { data: t.rows.find((r) => r.idempotency_key === k) || null, error: null };
    }
    if (s.table === 'quotes' && s.op === 'select' && t.changeMode) return { data: Object.assign({}, existing, { bid_status: t.quoteStatus || existing.bid_status }), error: null }; // quoteStatus: the server's bid_status once renew_quote has run
    if (s.table === 'quotes' && s.op === 'select' && (s.eqs || []).some((e) => e[0] === 'claim_id')) {
      t.lookups++;
      if (t.hideFromLookup) return { data: null, error: null };
      const cid = s.eqs.find((e) => e[0] === 'claim_id')[1];
      const ctr = (s.eqs.find((e) => e[0] === 'contractor_id') || [])[1];
      return { data: t.rows.find((r) => r.claim_id === cid && r.contractor_id === ctr) || null, error: null };
    }
    if (s.table === 'platform_fee_config') return { data: [{ fee_pct: '5.00' }], error: null };
    if (s.table === 'bidder_claim_summary') return { data: claim, error: null };
    if (s.table === 'contractors') return { data: contractor, error: null };
    return { data: s.single ? null : [], error: null };
  }
  function builder(table) {
    const s = { table, op: 'select', payload: null, single: false, eqs: [], signal: null };
    const b = new Proxy({}, { get(_, prop) {
      if (prop === 'then') return (res, rej) => run(s).then(res, rej);
      if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') return (p) => { s.op = prop; s.payload = p; return b; };
      if (prop === 'single' || prop === 'maybeSingle') return () => { s.single = true; return b; };
      if (prop === 'eq') return (c, v) => { s.eqs.push([c, v]); return b; };
      if (prop === 'abortSignal') return (sig) => { s.signal = sig; return b; };
      return () => b;
    } });
    return b;
  }
  function rpc(name) {
    t.calls.push(name);
    const s = { signal: null };
    if (name === 'renew_quote') {
      // Like the real RPC: it refuses a bid that is already live (55000), and a hung call can still complete server-side (t.renewLands).
      t.renewCalls = (t.renewCalls || 0) + 1;
      const hung = t.hang.includes('rpc:renew_quote');
      return { abortSignal(sig) { s.signal = sig; return this; }, then(res, rej) {
        if (hung) { t.hung++; if (t.renewLands) t.quoteStatus = 'active'; return hang(s).then(res, rej); }
        if (t.quoteStatus === 'active' || (!t.quoteStatus && !/__cancelled=1/.test(location.search))) return Promise.resolve({ data: null, error: { code: '55000', message: 'renew_quote: mode reopen needs a cancelled bid' } }).then(res, rej);
        t.quoteStatus = 'active';
        return Promise.resolve({ data: null, error: null }).then(res, rej);
      } };
    }
    if (t.hang.includes('rpc:' + name)) { t.hung++; return { abortSignal(sig) { s.signal = sig; return this; }, then(res, rej) { return hang(s).then(res, rej); } }; }
    const p = {
      abortSignal(sig) { s.signal = sig; return p; },
      then(res, rej) {
        const out = (t.gateMode === 'hang') ? hang(s) : Promise.resolve({ data: { can_submit: true }, error: null });
        return out.then(res, rej);
      },
    };
    return p;
  }
  const user = { id: 'u-1', email: 'c@example.test' };
  const client = {
    from: builder, rpc,
    functions: { invoke: async (name, o) => {
      t.calls.push('fn:' + name);
      if (t.hang.includes('fn:' + name)) { t.hung++; return hang({ signal: o && o.signal }); }
      return { data: {}, error: null };
    } },
    auth: { getUser: async () => ({ data: { user }, error: null }), getSession: async () => ({ data: { session: { user } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }), createSignedUrl: async () => ({ data: null, error: null }) }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
  };
  window.supabase = { createClient: () => client };
})();
`;

const FAKE_AUTH = `
window.Auth = new Proxy({ requireAuth: async () => ({ id: 'u-1', email: 'c@example.test' }) },
  { get: (t, k) => (k in t ? t[k] : async () => null) });
`;

async function openForm(page: Page, opts: { changeMode?: boolean; cancelled?: boolean } = {}) {
  await page.clock.install();
  // gh-3498 (REVIEW 6740533205): ipify can answer its headers and then stall the body. window.__ipBodyStall makes the fake
  // ipify response do that; its json() settles only when the request signal aborts, as a real fetch body does.
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input && input.url;
      if (u && u.includes('api.ipify.org') && (window as any).__ipBodyStall) {
        const sig = init && init.signal;
        return Promise.resolve({ ok: true, json: () => new Promise((_, rej) => { if (sig) sig.addEventListener('abort', () => rej(sig.reason)); }) } as any);
      }
      return real(input, init);
    };
  });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1')) {
      if (url.includes('/js/auth.js')) return route.fulfill({ contentType: 'text/javascript', body: FAKE_AUTH });
      if (url.includes('/contractor-bid-form.html')) {
        const res = await route.fetch();
        const body = (await res.text()).replace(/(<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^>]*?)\s+integrity="[^"]*"/, '$1');
        return route.fulfill({ response: res, body });
      }
      return route.continue();
    }
    if (url.includes('supabase-js') || url.includes('supabase.js')) return route.fulfill({ contentType: 'text/javascript', body: FAKE_SUPABASE });
    if (url.includes('api.ipify.org')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ip: '203.0.113.9' }) });
    return route.abort();
  });
  await page.goto(opts.changeMode ? PAGE + '&__change=1' + (opts.cancelled ? '&__cancelled=1' : '') : PAGE);
  await page.waitForFunction(() => (window as any).__t && document.getElementById('retailBidPrice'));
  await page.waitForFunction(() => (window as any).isRetailJob === true || (document.getElementById('retailBidPrice') as HTMLElement).offsetParent !== null);
}

async function fillAndAccept(page: Page) {
  await page.locator('#retailBidPrice').fill('18500');
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
  await page.evaluate(() => {
    const cb = document.getElementById('feeAcceptanceCheckbox') as HTMLInputElement;
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const clickSubmit = (page: Page) => page.evaluate(() => (document.getElementById('submitBtn') as HTMLButtonElement).click());
const state = (page: Page) => page.evaluate(() => {
  const price = document.getElementById('retailBidPrice') as HTMLInputElement;
  const btn = document.getElementById('submitBtn') as HTMLButtonElement;
  const t = (window as any).__t;
  return {
    btn: btn.textContent, btnDisabled: btn.disabled, priceLocked: price.readOnly || price.disabled,
    banner: Array.from(document.querySelectorAll('[role="alert"]')).map((e) => e.textContent || '').join(' | '),
    success: document.getElementById('successState')?.classList.contains('show') ?? false,
    quotesFiled: t.rows.length, aborted: t.aborted,
  };
});

test.describe('gh-3498 contractor-bid-form.html stalled submit (real page, Chromium)', () => {
  test('control: nothing hung, one bid is filed and the success screen shows', async ({ page }) => {
    await openForm(page);
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    const s = await state(page);
    expect(s.quotesFiled).toBe(1);
  });

  test('an ipify response whose body stalls does not hold the form: the bid files with IP unknown', async ({ page }) => {
    await openForm(page);
    await page.evaluate(() => { (window as any).__ipBodyStall = true; });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).btn).toContain('Submitting');
    await page.clock.fastForward(125_000);
    await expect.poll(async () => { const s = await state(page); return s.success || s.btn !== 'Submitting…'; }).toBe(true);
    const s = await state(page);
    expect(s.quotesFiled).toBe(1);
    expect(s.success).toBe(true);
  });

  test('a bid_can_submit that never answers ends with a message and an unlocked form', async ({ page }) => {
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.gateMode = 'hang'; });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).btn).toContain('Submitting');
    // the gate call has been made (its 10 s limit is running) before the clock moves; on a loaded host it can come later
    await expect.poll(() => page.evaluate(() => (window as any).__t.calls.includes('bid_can_submit'))).toBe(true);
    await page.clock.fastForward(11_000);
    await expect.poll(async () => (await state(page)).banner).toContain('Network error verifying contract template. Please retry.');
    const s = await state(page);
    expect(s.priceLocked).toBe(false);
    expect(s.btn).toBe('Submit Bid');
    expect(s.btnDisabled).toBe(false);
    expect(s.quotesFiled).toBe(0);
    expect(s.aborted).toBe(1); // the request itself was aborted, not just abandoned
  });

  test('a quote insert that never answers ends with the existing error message and an unlocked form', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.insertMode = 'hang'; });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).btn).toContain('Submitting');
    await page.clock.fastForward(21_000);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatch(/^Error submitting bid: /);
    const s = await state(page);
    expect(s.priceLocked).toBe(false);
    expect(s.btn).toBe('Submit Bid');
    expect(s.btnDisabled).toBe(false);
    expect(s.aborted).toBe(1);
  });

  test('a retry after an insert that landed but timed out files no second bid and reads the first back as success', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.insertMode = 'land_then_hang'; });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).btn).toContain('Submitting');
    await page.clock.fastForward(21_000);
    await expect.poll(() => dialogs.length).toBe(1);
    expect((await state(page)).quotesFiled).toBe(1); // the first insert did land
    await expect.poll(async () => (await state(page)).btnDisabled).toBe(false);

    await page.evaluate(() => { (window as any).__t.insertMode = 'ok'; });
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    const s = await state(page);
    expect(s.quotesFiled).toBe(1); // still one bid
    const t = await page.evaluate(() => (window as any).__t);
    // gh-3498 (REVIEW 6740720167): the retry finds the landed bid by (claim, contractor) before inserting; no second insert is sent
    expect(t.lookups).toBe(2); // one at page load (no bid yet), one before the retry
    expect(t.keyed.length).toBe(1);
    expect(t.inserts.filter((i: any) => i.table === 'fee_acceptances').length).toBe(1);
    expect(dialogs.length).toBe(1);
  });

  // -- REVIEW 6740720167 finding 2: a retry after a landed-but-timed-out insert never files a second bid and never shows success
  // over terms other than the ones on file; a retry with other content gets the filed bid back as Change Bid. --
  async function landThenTimeOut(page: Page, dialogs: string[]) {
    await page.evaluate(() => { (window as any).__t.insertMode = 'land_then_hang'; });
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).quotesFiled).toBe(1); // landed; its 20 s limit is running
    await page.clock.fastForward(21_000);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatch(/^Error submitting bid: /);
    expect((await state(page)).quotesFiled).toBe(1);
    await expect.poll(async () => (await state(page)).btnDisabled).toBe(false);
    await page.evaluate(() => { (window as any).__t.insertMode = 'ok'; });
  }
  const reTick = (page: Page) => page.evaluate(() => {
    const cb = document.getElementById('feeAcceptanceCheckbox') as HTMLInputElement;
    if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  const ALREADY_FILED = 'Your bid was already filed on an earlier try, so no second bid was sent.';
  const heading = (page: Page) => page.evaluate(() => document.getElementById('pageHeading')?.textContent || '');

  test('finding 2: a price changed after an insert landed and timed out files NO second bid; the filed bid comes back as Change Bid', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await fillAndAccept(page);
    await landThenTimeOut(page, dialogs);
    await page.locator('#retailBidPrice').fill('19000');
    await page.clock.fastForward(6_000);
    await reTick(page);
    await clickSubmit(page);
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[1]).toContain(ALREADY_FILED);
    const s = await state(page);
    expect(s.quotesFiled).toBe(1);
    expect(s.success).toBe(false);
    expect(s.priceLocked).toBe(false);
    expect(s.btn).toBe('Update Bid');
    expect(await heading(page)).toBe('Change Your Bid');
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.rows[0].total_price).toBe(18500);
    expect(t.inserts.filter((i: any) => i.table === 'fee_acceptances').length).toBe(0);
  });

  test('finding 2: another field changed after an insert landed and timed out shows no success over the old terms', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await fillAndAccept(page);
    await landThenTimeOut(page, dialogs);
    await page.evaluate(() => { (document.getElementById('homeownerMessage') as HTMLTextAreaElement).value = 'Different message on the retry'; });
    await reTick(page);
    await clickSubmit(page);
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[1]).toContain(ALREADY_FILED);
    const s = await state(page);
    expect(s.quotesFiled).toBe(1);
    expect(s.success).toBe(false);
    expect(s.btn).toBe('Update Bid');
  });

  test('finding 2: a different-price retry whose first insert lands only after the lookup is refused by the same key', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await fillAndAccept(page);
    await landThenTimeOut(page, dialogs);
    await page.evaluate(() => { (window as any).__t.hideFromLookup = true; });
    await page.locator('#retailBidPrice').fill('19000');
    await page.clock.fastForward(6_000);
    await reTick(page);
    await clickSubmit(page);
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[1]).toContain(ALREADY_FILED);
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.keyed.length).toBe(2);
    expect(t.keyed[0]).toBe(t.keyed[1]); // the key no longer changes with the price
    expect(t.readbacks).toBe(1);
    expect(t.rows.length).toBe(1);
    expect((await state(page)).success).toBe(false);
  });

  test('a same-content retry whose first insert lands only after the lookup reads the filed row back as success', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await fillAndAccept(page);
    await landThenTimeOut(page, dialogs);
    await page.evaluate(() => { (window as any).__t.hideFromLookup = true; });
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.keyed[0]).toBe(t.keyed[1]);
    expect(t.readbacks).toBe(1);
    expect(t.rows.length).toBe(1);
    expect(dialogs.length).toBe(1);
  });

  test('finding 3: without the key column, a retry after an insert that landed and timed out still files no second bid', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.noColumn = true; });
    await fillAndAccept(page);
    await landThenTimeOut(page, dialogs);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.rows.length).toBe(1);
    expect(t.rows[0].idempotency_key).toBeUndefined();
  });

  // -- REVIEW 6743281622 finding 1: an error after a confirmed insert (a missing gtag, or anything else thrown there) must not
  // let an edited retry show success over the old terms, write a second acceptance or email, or file a second row. --
  const feeAccCount = (t: any) => t.inserts.filter((i: any) => i.table === 'fee_acceptances').length;
  const emailCount = (t: any) => t.calls.filter((c: string) => c === 'fn:send-bid-confirmation').length;
  for (const noColumn of [false, true]) {
    test(`finding 1 (6743281622): a missing gtag does not turn a filed bid into an error (noColumn=${noColumn})`, async ({ page }) => {
      const dialogs: string[] = [];
      page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
      await openForm(page);
      await page.evaluate((nc) => { (window as any).__t.noColumn = nc; delete (window as any).gtag; }, noColumn);
      await fillAndAccept(page);
      await clickSubmit(page);
      await expect.poll(async () => { const s = await state(page); return s.success || dialogs.length > 0; }).toBe(true);
      const s = await state(page);
      const t = await page.evaluate(() => (window as any).__t);
      expect(dialogs).toEqual([]);
      expect(s.success).toBe(true);
      expect(t.rows.length).toBe(1);
      expect(feeAccCount(t)).toBe(1);
      expect(emailCount(t)).toBe(1);
    });

    test(`finding 1 (6743281622): an error thrown after a confirmed insert, then an edited retry: no success, nothing written twice (noColumn=${noColumn})`, async ({ page }) => {
      const dialogs: string[] = [];
      page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
      await openForm(page);
      await page.evaluate((nc) => {
        (window as any).__t.noColumn = nc;
        // stands in for anything that throws after the insert is confirmed (the unguarded gtag was the reviewer's case)
        const thrower = () => { throw new Error('post-insert failure'); };
        (window as any).trackBidEvent = thrower; (window as any).gtag = thrower;
      }, noColumn);
      await fillAndAccept(page);
      await clickSubmit(page);
      await expect.poll(() => dialogs.length).toBe(1);
      expect(dialogs[0]).toMatch(/^Error submitting bid: /);
      await expect.poll(async () => (await state(page)).btnDisabled).toBe(false);
      await page.evaluate(() => { (window as any).trackBidEvent = () => {}; (window as any).gtag = () => {}; });
      await page.locator('#retailBidPrice').fill('19000');
      await page.clock.fastForward(6_000);
      await reTick(page);
      await clickSubmit(page);
      await page.clock.fastForward(30_000);
      await expect.poll(() => dialogs.length).toBe(2);
      expect(dialogs[1]).toContain(ALREADY_FILED);
      const s = await state(page);
      const t = await page.evaluate(() => (window as any).__t);
      expect(s.success).toBe(false);
      expect(s.btn).toBe('Update Bid');
      expect(t.rows.map((r: any) => r.total_price)).toEqual([18500]);
      expect(feeAccCount(t)).toBe(1);
      expect(emailCount(t)).toBe(1);
    });
  }

  test('finding 1 (6743281622): an error thrown after a confirmed insert, then an identical retry: success, acceptance and email not repeated', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await page.evaluate(() => { const thrower = () => { throw new Error('post-insert failure'); }; (window as any).trackBidEvent = thrower; (window as any).gtag = thrower; });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(() => dialogs.length).toBe(1);
    await expect.poll(async () => (await state(page)).btnDisabled).toBe(false);
    await page.evaluate(() => { (window as any).trackBidEvent = () => {}; (window as any).gtag = () => {}; });
    await reTick(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.rows.length).toBe(1);
    expect(feeAccCount(t)).toBe(1);
    expect(emailCount(t)).toBe(1);
    expect(dialogs.length).toBe(1);
  });

  // -- REVIEW 6744510442 finding 2: a throw from Sentry (or anything else) after the acceptance write must not lead to a second
  // fee_acceptances row or a second confirmation email when an identical retry follows. --
  for (const noColumn of [false, true]) {
    test(`finding 2 (6744510442): Sentry throwing after the insert, then an identical retry if needed: 1 row, 1 acceptance, 1 email (noColumn=${noColumn})`, async ({ page }) => {
      const dialogs: string[] = [];
      page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
      await openForm(page);
      await page.evaluate((nc) => {
        (window as any).__t.noColumn = nc;
        (window as any).__t.hang = ['fn:send-bid-confirmation']; // the email fails, so its catch reports to Sentry
        (window as any).Sentry = { captureException() { throw new Error('sentry down'); }, captureMessage() { throw new Error('sentry down'); } };
      }, noColumn);
      await fillAndAccept(page);
      await clickSubmit(page);
      await expect.poll(() => page.evaluate(() => (window as any).__t.calls.filter((c: string) => c === 'fn:send-bid-confirmation').length)).toBe(1);
      await page.clock.fastForward(10_000);
      await expect.poll(async () => { const s = await state(page); return s.success || (dialogs.length > 0 && !s.btnDisabled); }).toBe(true);
      if (!(await state(page)).success) { // the first submit errored: retry it unchanged
        await page.evaluate(() => { (window as any).__t.hang = []; delete (window as any).Sentry; });
        await reTick(page);
        await clickSubmit(page);
        await page.clock.fastForward(30_000);
        await expect.poll(async () => { const s = await state(page); return s.success || dialogs.length > 1; }).toBe(true);
      }
      const s = await state(page);
      const t = await page.evaluate(() => (window as any).__t);
      expect(s.success).toBe(true);
      expect(t.rows.length).toBe(1);
      expect(feeAccCount(t)).toBe(1);
      expect(emailCount(t)).toBe(1);
      expect(dialogs).toEqual([]);
    });
  }

  test('finding 2 (6744510442): an error thrown after the acceptance write, then an identical retry: acceptance and email not written again', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await page.evaluate(() => {
      (window as any).__t.hang = ['fn:send-bid-confirmation'];
      // the email step's failure log throws once: stands in for anything thrown after the acceptance write
      const realErr = console.error.bind(console); let thrown = false;
      console.error = (...a: any[]) => { if (!thrown && String(a[0]).startsWith('[D-215 Layer 2]')) { thrown = true; throw new Error('post-insert failure'); } realErr(...a); };
    });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(() => page.evaluate(() => (window as any).__t.calls.filter((c: string) => c === 'fn:send-bid-confirmation').length)).toBe(1);
    await page.clock.fastForward(10_000);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toBe('Error submitting bid: post-insert failure');
    await expect.poll(async () => (await state(page)).btnDisabled).toBe(false);
    await page.evaluate(() => { (window as any).__t.hang = []; });
    await reTick(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.rows.length).toBe(1);
    expect(feeAccCount(t)).toBe(1);
    expect(emailCount(t)).toBe(1); // the first attempt's (hung) call only
  });

  // -- REVIEW 6743281622 finding 2: attempt A never lands, the contractor edits to B, B lands but times out, B is retried
  // unchanged: the bid on file IS what was sent, so it finishes on the success screen with its acceptance and email. --
  test('finding 2 (6743281622): A unlanded, edit to B, B landed but timed out, identical retry of B ends on success', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page);
    await fillAndAccept(page);
    await page.evaluate(() => { (window as any).__t.insertMode = 'hang'; });
    await clickSubmit(page);
    await expect.poll(() => page.evaluate(() => (window as any).__t.inserts.filter((i: any) => i.table === 'quotes').length)).toBe(1);
    await page.clock.fastForward(21_000);
    await expect.poll(() => dialogs.length).toBe(1);
    await expect.poll(async () => (await state(page)).btnDisabled).toBe(false);
    expect((await state(page)).quotesFiled).toBe(0);
    await page.locator('#retailBidPrice').fill('19000');
    await page.clock.fastForward(6_000);
    await reTick(page);
    await page.evaluate(() => { (window as any).__t.insertMode = 'land_then_hang'; });
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).quotesFiled).toBe(1); // B's insert has landed; its 20 s limit is running
    await page.clock.fastForward(21_000);
    await expect.poll(() => dialogs.length).toBe(2);
    await expect.poll(async () => (await state(page)).btnDisabled).toBe(false);
    await page.evaluate(() => { (window as any).__t.insertMode = 'ok'; });
    await reTick(page);
    await clickSubmit(page);
    await page.clock.fastForward(30_000);
    await expect.poll(async () => { const s = await state(page); return s.success || dialogs.length > 2; }).toBe(true);
    const s = await state(page);
    const t = await page.evaluate(() => (window as any).__t);
    expect(dialogs.length).toBe(2);
    expect(s.success).toBe(true);
    expect(t.rows.map((r: any) => r.total_price)).toEqual([19000]);
    expect(feeAccCount(t)).toBe(1);
    expect(emailCount(t)).toBe(1);
  });

  test('a database without the column yet: the bid is filed as before, without a key', async ({ page }) => {
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.insertMode = 'nocolumn'; });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.rows.length).toBe(1);
    expect(t.rows[0].idempotency_key).toBeUndefined();
  });
  // ── Widened closes-on (Marty, REVIEW 6688103147): every await between the submit lock and its finally ──
  // After the bid has landed (new-bid insert or Change Bid UPDATE) a timed-out call is non-fatal: the submit ends on the success screen.
  const hungCount = (page: Page) => page.evaluate(() => (window as any).__t.hung as number);
  for (const call of ['fee_acceptances:insert', 'fn:send-bid-confirmation']) {
    test('new bid: ' + call + ' that never answers ends on the success screen (the bid is already filed), once', async ({ page }) => {
      const dialogs: string[] = [];
      page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
      await openForm(page);
      await fillAndAccept(page);
      await page.evaluate((c) => { (window as any).__t.hang = [c]; }, call);
      await clickSubmit(page);
      await expect.poll(() => hungCount(page)).toBeGreaterThan(0);
      await page.clock.fastForward(9_000);
      await expect.poll(async () => (await state(page)).success).toBe(true);
      const s = await state(page);
      expect(s.quotesFiled).toBe(1);
      expect(s.aborted).toBe(1);
      expect(dialogs.length).toBe(0);
    });
  }

  // gh-3498 (closes-on 6688126384, CLOSE-REVIEW 6808620469): the renew_quote RPC (gh-3560) runs inside the submit lock before the UPDATE.
  test('change bid on a withdrawn bid: a renew_quote RPC that never answers ends with a message and an unlocked form', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page, { changeMode: true, cancelled: true });
    await fillAndAccept(page);
    await page.evaluate(() => { (window as any).__t.hang = ['rpc:renew_quote']; });
    await clickSubmit(page);
    await expect.poll(() => hungCount(page)).toBeGreaterThan(0);
    await page.clock.fastForward(16_000);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatch(/^Error submitting bid: /);
    const s = await state(page);
    expect(s.priceLocked).toBe(false);
    expect(s.btnDisabled).toBe(false);
    await page.evaluate(() => { (window as any).__t.hang = []; });
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
  });

  // gh-3498 (REVIEW 6809644127 F1): renew_quote times out in the browser but the server completes it. The page still holds the old
  // bid status, so a retry used to send the same mode and the RPC refused it (55000) until a reload. The retry reads the status first.
  test('renew_quote completes server-side after the browser timed out: the retry updates once and does not call renew_quote again', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page, { changeMode: true, cancelled: true });
    await fillAndAccept(page);
    await page.evaluate(() => { (window as any).__t.hang = ['rpc:renew_quote']; (window as any).__t.renewLands = true; });
    await clickSubmit(page);
    await expect.poll(() => hungCount(page)).toBeGreaterThan(0);
    await page.clock.fastForward(16_000);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatch(/^Error submitting bid: /);
    expect((await page.evaluate(() => (window as any).__t.quoteStatus))).toBe('active');
    await page.evaluate(() => { (window as any).__t.hang = []; });
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    expect(dialogs.length).toBe(1); // no second error dialog (no 55000 refusal)
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.renewCalls).toBe(1);
    expect(t.inserts.filter((i: any) => i.table === 'quotes' && i.op === 'update').length).toBe(1);
  });

  // gh-3498 (REVIEW F-A): renew_quote answers, then the field UPDATE times out. The retry must not call renew_quote again (55000); it updates once.
  test('renew_quote succeeded and the following UPDATE timed out: the retry skips renew_quote and updates once', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page, { changeMode: true, cancelled: true });
    await fillAndAccept(page);
    await page.evaluate(() => { (window as any).__t.hang = ['quotes:update']; });
    await clickSubmit(page);
    await expect.poll(() => hungCount(page)).toBeGreaterThan(0);
    await page.clock.fastForward(16_000);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatch(/^Error submitting bid: /);
    expect((await page.evaluate(() => (window as any).__t.renewCalls))).toBe(1);
    await page.evaluate(() => { (window as any).__t.hang = []; });
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    expect(dialogs.length).toBe(1); // no second error dialog (no 55000 refusal)
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.renewCalls).toBe(1);
    expect(t.inserts.filter((i: any) => i.table === 'quotes' && i.op === 'update').length).toBe(1);
  });

  test('change bid: the quotes UPDATE that never answers ends with a message and an unlocked form, and a retry updates once', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await openForm(page, { changeMode: true });
    await fillAndAccept(page);
    await page.evaluate(() => { (window as any).__t.hang = ['quotes:update']; });
    await clickSubmit(page);
    await expect.poll(() => hungCount(page)).toBeGreaterThan(0);
    await page.clock.fastForward(16_000);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatch(/^Error submitting bid: /);
    const s = await state(page);
    expect(s.priceLocked).toBe(false);
    expect(s.btn).toBe('Update Bid');
    expect(s.btnDisabled).toBe(false);
    await page.evaluate(() => { (window as any).__t.hang = []; });
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.inserts.filter((i: any) => i.table === 'quotes' && i.op === 'update').length).toBe(1);
  });

  for (const call of ['notifications:insert', 'activity_log:insert', 'fn:notify-contractors']) {
    test('change bid: ' + call + ' that never answers ends on the success screen (the update is already saved)', async ({ page }) => {
      const dialogs: string[] = [];
      page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
      await openForm(page, { changeMode: true });
      await fillAndAccept(page);
      await page.evaluate((c) => { (window as any).__t.hang = [c]; }, call);
      await clickSubmit(page);
      await expect.poll(() => hungCount(page)).toBeGreaterThan(0);
      await page.clock.fastForward(9_000);
      await expect.poll(async () => (await state(page)).success).toBe(true);
      const t = await page.evaluate(() => (window as any).__t);
      expect(t.aborted).toBe(1);
      expect(t.inserts.filter((i: any) => i.table === 'quotes' && i.op === 'update').length).toBe(1);
      expect(dialogs.length).toBe(0);
    });
  }
});
