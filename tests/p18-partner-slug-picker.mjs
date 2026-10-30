/**
 * P18 (#3218): partner vanity slug picker -- js/partner-slug.js and the "your short link" card on partner-profile.html.
 * Technique (same as tests/gh2154-p5-invite-page.mjs): load the REAL source into a Node `vm` sandbox; no hand-retyped copies.
 * Run: node tests/p18-partner-slug-picker.mjs   Exit 0 = all passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperSrc = fs.readFileSync(path.join(root, 'js/partner-slug.js'), 'utf8');
const pageSrc = fs.readFileSync(path.join(root, 'partner-profile.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

function loadHelper(extra = '') {
  const ctx = { window: {} }; vm.createContext(ctx);
  vm.runInContext(helperSrc + extra, ctx);
  return ctx.window.PartnerSlug;
}
const PS = loadHelper();

// (1) client validation mirrors the server rules (same words as set_partner_slug)
for (const [input, good, why] of [
  ['jane-doe', true, 'plain slug'], ['Jane-Doe', true, 'upper case is folded'], ['  jane  ', true, 'trimmed'], ['a1b', true, '3 chars'],
  ['x'.repeat(30), true, '30 chars'],
  ['ab', false, 'N5 too short'], ['a--b', false, 'N6 double hyphen'], ['-ab', false, 'leading hyphen'], ['ab-', false, 'trailing hyphen'],
  ['123456', false, 'all digits'], ['a_b', false, 'underscore'], ['a b', false, 'space inside'], ['x'.repeat(31), false, '31 chars'], ['', false, 'empty'], [null, false, 'null'],
]) ok(PS.validate(input).ok === good, `(1) validate(${JSON.stringify(input)}) ${good ? 'accepted' : 'refused'}: ${why}`);
ok(PS.validate('Jane-Doe').slug === 'jane-doe', '(1b) validate returns the lower-cased slug');
// negative control: a validator that accepted everything would fail the refusal rows above
ok(PS.validate('a--b').message === 'Hyphens cannot start or end the link or appear twice in a row.', '(1c) refusal carries the server wording');

// (2) urls
ok(PS.shortUrl('https://otterquote.com/', 'jane-doe') === 'https://otterquote.com/jane-doe', '(2) shortUrl joins without a double slash');
ok(PS.displayUrl('https://otterquote.com', 'jane-doe') === 'otterquote.com/jane-doe', '(2b) displayUrl drops the scheme');

// (3) error mapping: server wording shown for validation codes, generic otherwise
ok(PS.messageForError({ code: '22023', message: 'That short link is not available. Please try another.' }) === 'That short link is not available. Please try another.', '(3) 22023 shows the server sentence');
ok(PS.messageForError({ code: '42501', message: 'Please sign in to choose a short link.' }) === 'Please sign in to choose a short link.', '(3b) 42501 shows the server sentence');
ok(PS.messageForError({ code: '57014', message: 'canceling statement due to statement timeout' }) === PS.GENERIC_ERROR, '(3c) other codes never leak raw database text');
ok(PS.messageForError(null) === PS.GENERIC_ERROR, '(3d) null error -> generic');

// (4) save(): validates first (no RPC for a bad slug), calls set_partner_slug with { p }, shows RPC errors
{
  const calls = [];
  const sb = (resp) => ({ rpc: async (fn, args) => { calls.push([fn, args]); return resp; } });
  let r = await PS.save(sb({}), 'ab');
  ok(r.ok === false && calls.length === 0, '(4) a client-invalid slug never reaches the RPC');
  r = await PS.save(sb({ data: { slug: 'jane-doe', changed: true }, error: null }), 'Jane-Doe');
  ok(r.ok && r.slug === 'jane-doe' && calls.length === 1 && calls[0][0] === 'set_partner_slug' && calls[0][1].p === 'jane-doe', '(4b) valid slug -> rpc("set_partner_slug", { p: "jane-doe" })');
  r = await PS.save(sb({ data: null, error: { code: '22023', message: 'That short link is not available. Please try another.' } }), 'admin');
  ok(!r.ok && r.message === 'That short link is not available. Please try another.', '(4c) a refused slug (reserved/taken) shows the server error');
  r = await PS.save({ rpc: async () => { throw new Error('network'); } }, 'jane-doe');
  ok(!r.ok && r.message === PS.GENERIC_ERROR, '(4d) a thrown network error is caught and shown generically');
  r = await PS.save(sb({ data: null, error: null }), 'jane-doe');
  ok(!r.ok, '(4e) an empty RPC answer is not reported as success');
}

// (5) page: static wiring
ok(/<script src="js\/partner-slug\.js"><\/script>/.test(pageSrc), '(5) partner-profile.html loads js/partner-slug.js');
ok(pageSrc.indexOf('js/partner-slug.js') > pageSrc.indexOf('js/supabase-client.js'), '(5b) helper loads after supabase-client.js');
ok(/PartnerSlug\.save\(sb, input\.value\)/.test(pageSrc), '(5c) the form submit calls PartnerSlug.save (the set_partner_slug RPC), not a table update');
ok(!/\.from\('referral_agents'\)\s*\.update/.test(pageSrc) && !/vanity_slug\s*:/.test(pageSrc.replace(/\s+/g, ' ').replace(/mine\.vanity_slug/g, '')),
  '(5d) NEGATIVE CONTROL: the page never writes referral_agents.vanity_slug directly');
ok(/PartnerSlug\.ROUTING_LIVE/.test(pageSrc) && PS.ROUTING_LIVE === false, '(5e) short link is not presented as working while routing is not live (flag false)');

// (6) page behaviour in a vm with a tiny DOM: card for the owner only
function makeDom() {
  const byId = {}; const created = [];
  const mk = (id) => { const el = { id, innerHTML: '', textContent: '', value: '', className: '', disabled: false, handlers: {},
    classList: { add() {}, remove() {} }, addEventListener(t, f) { el.handlers[t] = f; }, appendChild(c) { created.push(c); reg(c); }, preventDefault() {} }; return el; };
  const reg = (el) => { const ids = [...String(el.innerHTML).matchAll(/id="([^"]+)"/g)].map(m => m[1]); for (const i of ids) if (!byId[i]) byId[i] = mk(i); };
  const doc = { getElementById: (i) => byId[i] || null, createElement: () => { const el = mk(''); return el; }, addEventListener() {} };
  byId.profileCard = mk('profileCard');
  return { doc, byId, created };
}
async function runPage({ user, mine, code }) {
  const { doc, byId, created } = makeDom();
  const script = pageSrc.split(/<script>/).pop().split('</script>')[0].replace("document.addEventListener('DOMContentLoaded', init);", '');
  const rpcCalls = [];
  const sb = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mine }) }) }) }),
    rpc: async (fn, args) => { rpcCalls.push([fn, args]); return { data: { slug: args.p, changed: true }, error: null }; },
  };
  const ctx = { document: doc, CONFIG: { SITE_URL: 'https://otterquote.com' }, sb, console,
    Auth: { getUser: async () => user }, AgentTypes: { PARTNER_DISPLAY_LABELS: {} }, URLSearchParams, navigator: {} };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(helperSrc, ctx);
  vm.runInContext(script + '\n;this.__t = { maybeRenderSlugCard };', ctx);
  await ctx.__t.maybeRenderSlugCard(code);
  return { created, byId, rpcCalls, doc, ctx };
}
{
  const owner = await runPage({ user: { id: 'u1' }, mine: { unique_code: 'JFY5GZOD', vanity_slug: null, status: 'active' }, code: 'JFY5GZOD' });
  ok(owner.created.length === 1 && /id="slugForm"/.test(owner.created[0].innerHTML), '(6) the owner of the profile gets the picker card');
  ok(/placeholder="jane-doe"/.test(owner.created[0].innerHTML) && /maxlength="30"/.test(owner.created[0].innerHTML), '(6b) the card has the slug field (maxlength 30)');
  ok(/Once short links launch, visitors who use it will be credited to you, the same as your regular link\./.test(owner.created[0].innerHTML), '(6k) ROUTING_LIVE false: the crediting sentence is future tense, exactly as specified');
  ok(!/visitors who use it are credited/i.test(owner.created[0].innerHTML), '(6l) NEGATIVE CONTROL: no present-tense crediting promise while routing is not live');
  ok(/\$\{PartnerSlug\.ROUTING_LIVE \?/.test(pageSrc) && /Visitors who use it are credited to you/.test(pageSrc), '(6m) the present-tense sentence exists only on the ROUTING_LIVE branch');
  owner.byId.slugInput.value = 'Jane-Doe';
  await owner.byId.slugForm.handlers.submit({ preventDefault() {} });
  ok(owner.rpcCalls.length === 1 && owner.rpcCalls[0][0] === 'set_partner_slug' && owner.rpcCalls[0][1].p === 'jane-doe', '(6c) submitting calls set_partner_slug("jane-doe")');
  ok(owner.byId.slugMsg.textContent === 'Saved.', '(6d) success message shown');
  ok(/otterquote\.com\/jane-doe/.test(owner.byId.slugCurrent.innerHTML) && /start working when short links launch/.test(owner.byId.slugCurrent.innerHTML) && !/slugCopy/.test(owner.byId.slugCurrent.innerHTML),
    '(6e) while routing is not live: link shown as saved, no copy button');

  owner.byId.slugInput.value = 'ab';
  await owner.byId.slugForm.handlers.submit({ preventDefault() {} });
  ok(owner.byId.slugMsg.textContent === 'Use at least 3 characters.' && owner.byId.slugMsg.className === 'form-error' && owner.rpcCalls.length === 1, '(6f) a bad slug shows its error and makes no second RPC call');

  const other = await runPage({ user: { id: 'u2' }, mine: { unique_code: 'ZN73R8GY', vanity_slug: null, status: 'active' }, code: 'JFY5GZOD' });
  ok(other.created.length === 0, '(6g) NEGATIVE CONTROL: a partner viewing someone else\'s profile gets no picker');
  const anon = await runPage({ user: null, mine: null, code: 'JFY5GZOD' });
  ok(anon.created.length === 0, '(6h) NEGATIVE CONTROL: a signed-out visitor gets no picker');
  const pending = await runPage({ user: { id: 'u1' }, mine: { unique_code: 'JFY5GZOD', vanity_slug: null, status: 'pending' }, code: 'JFY5GZOD' });
  ok(pending.created.length === 0, '(6i) NEGATIVE CONTROL: a not-yet-active partner gets no picker');

  ok(/escapeHtml\(mine\.vanity_slug/.test(pageSrc), '(6j) the stored slug is HTML-escaped before it is written into the card');
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
