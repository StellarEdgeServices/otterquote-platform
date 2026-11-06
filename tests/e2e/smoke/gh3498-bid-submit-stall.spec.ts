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
  const t = (window.__t = { gateMode: 'ok', insertMode: 'ok', rows: [], inserts: [], keyed: [], calls: [], aborted: 0, readbacks: 0 });
  const claim = { id: 'claim-1', trades: ['roofing'], selected_trades: ['roofing'], job_type: 'retail', funding_type: 'retail',
    damage_type: 'hail', material_category: 'shingle', is_test: true, rcv_amount: null, parsed_line_items: null, state: 'IN' };
  const contractor = { id: 'c-1', user_id: 'u-1', status: 'active', attestation_accepted_at: '2026-01-01T00:00:00Z',
    coi_file_url: 'x', coi_expires_at: '2099-01-01', cpa_version: 'v1-2026-04', needs_cpa_reattestation: false,
    company_name: 'Acme Roofing', phone: '5551234567', trades: ['roofing'], service_area_description: 'IN', address_state: 'IN', is_test: true };
  const hang = (s) => new Promise((_, rej) => { if (s.signal) s.signal.addEventListener('abort', () => { t.aborted++; rej(s.signal.reason); }); });
  async function run(s) {
    if (s.op === 'insert') {
      t.inserts.push({ table: s.table, payload: JSON.parse(JSON.stringify(s.payload)) });
      if (s.table === 'quotes') {
        const key = s.payload.idempotency_key;
        if (key) t.keyed.push(key);
        if (t.insertMode === 'nocolumn' && key) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'idempotency_key' column of 'quotes' in the schema cache" } };
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
    functions: { invoke: async (name) => { t.calls.push('fn:' + name); return { data: {}, error: null }; } },
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

async function openForm(page: Page) {
  await page.clock.install();
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
  await page.goto(PAGE);
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

  test('a bid_can_submit that never answers ends with a message and an unlocked form', async ({ page }) => {
    await openForm(page);
    await page.evaluate(() => { (window as any).__t.gateMode = 'hang'; });
    await fillAndAccept(page);
    await clickSubmit(page);
    await expect.poll(async () => (await state(page)).btn).toContain('Submitting');
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
    expect(t.keyed.length).toBe(2);
    expect(t.keyed[0]).toBe(t.keyed[1]); // the retry carried the same key
    expect(t.readbacks).toBe(1);
    expect(dialogs.length).toBe(1);
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
});
