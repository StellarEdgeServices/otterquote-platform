/**
 * gh-3848 (follow-up to gh-3498): a RELOAD retry carries a new idempotency key, so only the database index quotes_manual_bid_uidx can refuse the second bid.
 * The fake database emulates that index (23505 naming it) and the form must read it as 'already filed', not as an error.
 * Harness copied from gh3498-bid-submit-stall.spec.ts.
 *
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
        // gh-3848: quotes_manual_bid_uidx (claim_id, contractor_id, trade_type) WHERE is_auto_bid IS NOT TRUE AND renewed_from_quote_id IS NULL
        // AND bid_status IN ('active','expired'). t.indexOff = the index does not exist (production today); t.indexNoStatus = mutant without the bid_status term.
        if (!t.indexOff && t.rows.some((r) => r.claim_id === s.payload.claim_id && r.contractor_id === s.payload.contractor_id && r.trade_type === s.payload.trade_type
            && r.is_auto_bid !== true && !r.renewed_from_quote_id && (t.indexNoStatus || ['active', 'expired'].includes(r.bid_status || 'active')))) {
          t.manualRejected = (t.manualRejected || 0) + 1;
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "quotes_manual_bid_uidx"', details: 'Key (claim_id, contractor_id, trade_type)=(...) already exists.' } };
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
    // gh-3497: the rate is read through rpc('quotes_platform_fee_for') (platform_fee_config is admin-only under RLS).
    if (name === 'quotes_platform_fee_for') return Promise.resolve({ data: [{ fee_pct: 5, fee_basis: 'bid_amount' }], error: null });
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


// A bid filed by an earlier page load (another idempotency key) that this page's own lookup did not see: seeded after the page opened.
const feeAccCount = (t: any) => t.inserts.filter((i: any) => i.table === 'fee_acceptances').length;
const seedEarlierBid = (page: Page, over: Record<string, unknown> = {}) => page.evaluate((o) => {
  (window as any).__t.rows.push(Object.assign({ id: 'earlier-1', claim_id: 'claim-1', contractor_id: 'c-1', trade_type: 'roofing', total_price: 17000,
    bid_status: 'active', is_auto_bid: false, platform_fee_pct: 5, scope_summary: '{}', idempotency_key: 'key-from-the-earlier-page-load' }, o));
}, over);

test.describe('gh-3848 reload retry cannot file a second manual bid (real page, Chromium)', () => {
  test('reload retry: the index refuses the insert, no second bid, the existing message shows, the form becomes Change Bid', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await openForm(page);
    await seedEarlierBid(page);
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(() => dialogs.length).toBeGreaterThan(0);
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.manualRejected).toBe(1);
    expect(t.rows.length).toBe(1);                       // still only the earlier bid
    expect(dialogs[0]).toContain('Your bid was already filed on an earlier try, so no second bid was sent.');
    expect(feeAccCount(t)).toBe(0);                      // no acceptance record or email written by this attempt
    expect(await page.evaluate('changeBidMode')).toBe(true);
    expect((await state(page)).success).toBe(false);
  });

  test('re-bid after a rescind: the cancelled bid is outside the index, the new bid files and succeeds', async ({ page }) => {
    await openForm(page);
    await seedEarlierBid(page, { bid_status: 'cancelled' });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    const t = await page.evaluate(() => (window as any).__t);
    expect(t.manualRejected || 0).toBe(0);
    expect(t.rows.length).toBe(2);
  });

  test('mutant: an index without the bid_status term wrongly blocks the re-bid after a rescind', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.indexNoStatus = true; });
    await seedEarlierBid(page, { bid_status: 'cancelled' });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await page.evaluate(() => (window as any).__t.manualRejected)) || 0).toBe(1);
    expect((await page.evaluate(() => (window as any).__t.rows.length))).toBe(1); // the legitimate re-bid was refused
  });

  test('negative control: without the index (production today) the reload retry files a second bid', async ({ page }) => {
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.indexOff = true; });
    await seedEarlierBid(page);
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).success).toBe(true);
    expect((await page.evaluate(() => (window as any).__t.rows.length))).toBe(2);
  });
});
