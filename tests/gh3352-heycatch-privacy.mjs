// gh-3352 items 1 and 2: HeyCatch referrer/URL scrub and toolbar-trigger removal.
// No browser needed. Checks that
//   (a) js/heycatch-privacy.js (marketing) and react-app/app/lib/heycatch-privacy.ts (app) give the SAME answer on
//       the same cases, so the two copies cannot drift;
//   (b) the boot loads the SDK only AFTER the triggers are removed (a static import would evaluate the SDK first,
//       and the SDK reads location.hash when it is evaluated);
//   (c) the vendored SDK is the audited 0.8.3 file, so an SDK bump forces a re-read of maybeLoadToolbar and of the
//       URL properties it sends;
//   (d) negative controls: the checks fail on the pre-fix shapes.
// Needs Node 22.18+ (runs .ts directly). Run: node tests/gh3352-heycatch-privacy.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('ok   ' + name);
  else { failed++; console.log('FAIL ' + name + (detail ? '\n     ' + detail : '')); }
}

const js = await import(pathToFileURL(path.join(root, 'js/heycatch-privacy.js')).href);
const ts = await import(pathToFileURL(path.join(root, 'react-app/app/lib/heycatch-privacy.ts')).href);

const CLAIM_IN_PATH = 'https://app.otterquote.com/contractor/bid/CLAIMPATH777?x=1#y';
const SIGNED_IN = 'https://app.otterquote.com/bids?claim_id=CLAIMREF999&email=pat%40example.com#sec';
const event = () => ({
  uuid: 'u1', event: '$autocapture',
  properties: {
    $current_url: 'https://otterquote.com/faq?utm_source=meta&utm_medium=paid&utm_campaign=hail&claim_id=C1&email=a%40b.com&gclid=<masked>#frag=1',
    $pathname: '/faq', $host: 'otterquote.com',
    $referrer: SIGNED_IN, $referring_domain: 'app.otterquote.com', $session_entry_referrer: SIGNED_IN,
    $session_entry_url: 'https://otterquote.com/faq?utm_source=meta&code=ABC123',
    $elements: [{ tag_name: 'a', attr__href: '/contract-signing?claim_id=C1&bid=9#x' }],
    $elements_chain: 'a:attr__href="/contract-signing?claim_id=C1&bid=9#x"href="/contract-signing?claim_id=C1&bid=9#x"nth-child="1"',
    $external_click_url: 'https://example.com/p?email=a%40b.com',
    $set: { $current_url: 'https://otterquote.com/faq?email=a%40b.com' },
  },
  $set_once: { $initial_referrer: SIGNED_IN, $initial_current_url: 'https://otterquote.com/faq?utm_source=meta&claim_id=C1' },
});

for (const [label, m] of [['js', js], ['ts', ts]]) {
  const out = m.scrubEvent(event());
  const text = JSON.stringify(out);
  check(`${label}: no claim id, email, code or fragment survives`, !/CLAIMREF999|claim_id|pat%40|a%40b|code=ABC|frag=1|bid=9|gclid/.test(text), text);
  check(`${label}: referrer properties are origin only`, out.properties.$referrer === 'https://app.otterquote.com' && out.properties.$session_entry_referrer === 'https://app.otterquote.com' && out.$set_once.$initial_referrer === 'https://app.otterquote.com');
  const pathEv = { event: '$pageview', properties: { $referrer: CLAIM_IN_PATH, $session_entry_referrer: CLAIM_IN_PATH, $initial_referrer: '$direct', $bad_referrer: 'nonsense' }, $set_once: { $initial_referrer: CLAIM_IN_PATH } };
  const pe = m.scrubEvent(pathEv);
  check(`${label}: no signed-in path or claim id in the path survives (/contractor/bid/CLAIMPATH777)`, !/CLAIMPATH777|\/contractor|\/bids/.test(JSON.stringify(pe)), JSON.stringify(pe));
  check(`${label}: $direct kept, unparseable referrer dropped`, pe.properties.$initial_referrer === '$direct' && !('$bad_referrer' in pe.properties));
  check(`${label}: current URL keeps UTMs only`, out.properties.$current_url === 'https://otterquote.com/faq?utm_source=meta&utm_medium=paid&utm_campaign=hail' && out.$set_once.$initial_current_url === 'https://otterquote.com/faq?utm_source=meta');
  check(`${label}: paths and hosts untouched`, out.properties.$pathname === '/faq' && out.properties.$host === 'otterquote.com' && out.properties.$referring_domain === 'app.otterquote.com');
  check(`${label}: never throws`, m.makeBeforeSend()(undefined) === null && m.makeBeforeSend(() => { throw new Error('x'); })(event()) === null);
}
for (const u of [SIGNED_IN, CLAIM_IN_PATH, '$direct', 'nonsense', '/rel/path', 'android-app://x/', 'http://127.0.0.1:3000/a?b']) check(`js and ts agree on scrubReferrer(${u.slice(0, 40)})`, js.scrubReferrer(u) === ts.scrubReferrer(u));
for (const [label, m] of [['js', js], ['ts', ts]]) {
  check(`${label}: encoded "@" in a UTM value is dropped from the URL`, m.scrubUrl('https://a.test/p?utm_source=x%2540plantd.com&utm_medium=paid', true) === 'https://a.test/p?utm_medium=paid');
  const c = m.scrubEvent({ event: 'e', properties: { utm_term: 'plant2@example.com', $session_entry_utm_term: 'a@b.com', $initial_utm_term: 'ok', utm_source: 'meta', mc_cid: '1', gad_source: '1', ph_keyword: 'q' }, $set_once: { utm_term: 'a@b.com', $initial_utm_campaign: 'hail', $initial_mc_cid: '9' } });
  check(`${label}: standalone campaign properties follow the value rule, other campaign keys dropped`, JSON.stringify(c) === JSON.stringify({ event: 'e', properties: { $initial_utm_term: 'ok', utm_source: 'meta' }, $set_once: { $initial_utm_campaign: 'hail' } }), JSON.stringify(c));
}
check('js and ts agree on every case', JSON.stringify(js.scrubEvent(event())) === JSON.stringify(ts.scrubEvent(event())));
for (const u of ['https://a.test/p?claim_id=1&utm_source=meta#f', '/p?utm_term=a%40b.com', 'mailto:a@b.com?x=1', '$direct', 'https://a.test/p?utm_source=%E0%A4%A', 'https://a.test/p?utm_content=' + 'x'.repeat(101)]) {
  for (const keep of [true, false]) check(`js and ts agree on scrubUrl(${u.slice(0, 40)}, ${keep})`, js.scrubUrl(u, keep) === ts.scrubUrl(u, keep));
}

// gh-3357: heatmap events never reach HeyCatch, whatever its config says
for (const [label, m] of [['js', js], ['ts', ts]]) {
  const hm = { event: '$$heatmap', properties: { $heatmap_data: { 'https://otterquote.com/faq?claim_id=C1': [{ x: 1, y: 2, target_fixed: true, type: 'click' }] }, $pathname: '/faq' } };
  check(`${label}: a $$heatmap event is dropped`, m.scrubEvent(hm) === null && m.makeBeforeSend()(hm) === null);
  const stray = m.scrubEvent({ event: '$pageview', properties: { $heatmap_data: { a: 1 }, $pathname: '/faq' }, $set_once: { $heatmap_data: 1 } });
  check(`${label}: $heatmap_data is removed from any other event`, !JSON.stringify(stray).includes('heatmap') && stray.properties.$pathname === '/faq', JSON.stringify(stray));
}

// gh-3357 item 1: a path property must not name a page HeyCatch does not load on. In the app the SDK keeps
// running across client-side moves (history_change), so after /get-started -> /contractor/bid/<claimId> ->
// /get-started the next pageview carries $prev_pageview_pathname "/contractor/bid/<claimId>" (seen with the real
// 0.8.3 SDK in tests/gh3357-heycatch-browser.mjs). The app passes its route allowlist as pathAllowed.
const appAllowed = (p) => typeof p === 'string' && (p === '/get-started' || p.startsWith('/get-started/'));
const spaEvent = () => ({ event: '$pageview', properties: {
  $pathname: '/get-started', $prev_pageview_pathname: '/contractor/bid/CLAIMPATH777', $prev_pageview_id: 'p1',
  $session_entry_pathname: '/dashboard', $session_entry_url: 'https://app.otterquote.com/contractor/sign/CLAIMSIGN555',
  $current_url: 'https://app.otterquote.com/get-started?utm_source=meta' },
  $set_once: { $initial_pathname: '/bids', $initial_current_url: 'https://app.otterquote.com/bids?claim_id=Q' } });
for (const [label, m] of [['js', js], ['ts', ts]]) {
  const out = m.makeBeforeSend(() => true, appAllowed)(spaEvent());
  const text = JSON.stringify(out);
  check(`${label}: gh3357 no denied route survives in a path property (pathAllowed)`, out !== null && !/CLAIMPATH777|CLAIMSIGN555|\/contractor|\/dashboard|\/bids/.test(text), text);
  check(`${label}: gh3357 allowed paths and other properties are kept (a denied page's $prev_pageview_* is not)`, out && out.properties.$pathname === '/get-started' && !('$prev_pageview_id' in out.properties) && out.properties.$current_url === 'https://app.otterquote.com/get-started?utm_source=meta', text);
  const ok2 = m.makeBeforeSend(() => true, appAllowed)({ event: '$pageview', properties: { $pathname: '/get-started', $prev_pageview_pathname: '/get-started/step-2' } });
  check(`${label}: gh3357 an allowed previous path is kept`, ok2 && ok2.properties.$prev_pageview_pathname === '/get-started/step-2', JSON.stringify(ok2));
  const prevAll = { $prev_pageview_duration: 1861.31, $prev_pageview_last_scroll: 0, $prev_pageview_max_scroll_percentage: 1, $prev_pageview_last_content: 720, $prev_pageview_max_content_percentage: 1, $prev_pageview_id: 'p9' };
  const den = m.makeBeforeSend(() => true, appAllowed)({ event: '$pageview', properties: { $pathname: '/get-started', $prev_pageview_pathname: '/contractor/bid/CLAIMROT123', ...prevAll } });
  check(`${label}: gh3357 a denied $prev_pageview_pathname takes every other $prev_pageview_* key with it`, den && den.properties.$pathname === '/get-started' && !Object.keys(den.properties).some((k) => k.startsWith('$prev_pageview_')), JSON.stringify(den));
  const alw = m.makeBeforeSend(() => true, appAllowed)({ event: '$pageview', properties: { $pathname: '/get-started', $prev_pageview_pathname: '/get-started/step-2', ...prevAll } });
  check(`${label}: gh3357 an allowed $prev_pageview_pathname keeps the other $prev_pageview_* keys`, alw && alw.properties.$prev_pageview_duration === 1861.31 && alw.properties.$prev_pageview_id === 'p9', JSON.stringify(alw));
  check(`${label}: gh3357 a pathAllowed that throws drops the event`, m.makeBeforeSend(() => true, () => { throw new Error('x'); })(spaEvent()) === null);
  const site = m.scrubEvent({ event: '$pageview', properties: { $pathname: '/faq', $prev_pageview_pathname: '/contract-signing' } });
  check(`${label}: gh3357 without pathAllowed, a $prev_pageview_pathname that is not the page itself is dropped`, site && !('$prev_pageview_pathname' in site.properties) && site.properties.$pathname === '/faq', JSON.stringify(site));
  const same = m.scrubEvent({ event: '$pageleave', properties: { $pathname: '/faq', $prev_pageview_pathname: '/faq' } });
  check(`${label}: gh3357 without pathAllowed, $prev_pageview_pathname equal to $pathname is kept`, same && same.properties.$prev_pageview_pathname === '/faq');
}
check('js and ts agree on the gh3357 path cases', JSON.stringify(js.makeBeforeSend(() => true, appAllowed)(spaEvent())) === JSON.stringify(ts.makeBeforeSend(() => true, appAllowed)(spaEvent())));
check('app passes its route allowlist as pathAllowed (gh3357)', /beforeSend:\s*makeBeforeSend\(\s*\(\)\s*=>\s*isHeyCatchAllowedPath\(window\.location\.pathname\),\s*isHeyCatchAllowedPath\s*\)/.test(read('react-app/app/lib/heycatch.ts')));
check('negative control (gh3357): the unguarded event really carries the claim path', JSON.stringify(spaEvent()).includes('CLAIMPATH777') && JSON.stringify(js.makeBeforeSend(() => true)(spaEvent())).includes('/contractor/sign'));

// (b) boot order
const boot = read('js/heycatch-boot.js');
const code = boot.replace(/^\s*\/\/.*$/gm, '');
check('boot has no static import of the SDK', !/^\s*import\s[^;]*vendor\/heycatch-sdk/m.test(code));
check('boot imports the SDK dynamically, after hideToolbarTrigger()', /hideToolbarTrigger\(\)[\s\S]*import\('\/js\/vendor\/heycatch-sdk-0\.8\.3\.js'\)/.test(code));
check('boot passes beforeSend to init', /beforeSend:\s*makeBeforeSend\(\)/.test(code));
const app = read('react-app/app/lib/heycatch.ts');
check('app hides the triggers before import("@heycatch/sdk")', /hideToolbarTrigger\(\)[\s\S]*import\("@heycatch\/sdk"\)/.test(app));
check('app passes the scrubbing beforeSend to init', /beforeSend:\s*makeBeforeSend\(/.test(app));
check('no other file imports the SDK', !/@heycatch\/sdk['"]/.test(read('react-app/app/components/HeyCatchGate.tsx') + read('react-app/app/get-started/page.tsx')));

// (c) the audited SDK
const sdk = readFileSync(path.join(root, 'js/vendor/heycatch-sdk-0.8.3.js'));
check('vendored SDK is byte-identical to npm @heycatch/sdk 0.8.3 dist/index.js',
  createHash('sha256').update(sdk).digest('hex') === 'e7e53ba6fd70379c30c8ca52f70398521a360ac6119221fec2d7b303070a6353');
const sdkText = sdk.toString('utf8');
check('SDK still reads the toolbar hash at module evaluation (why the import is dynamic)', /Td=_!=null&&_\.location\?\$n\(_\.location\.hash,"__posthog"\)\|\|\$n\(location\.hash,"state"\)/.test(sdkText));
check('SDK toolbar still keyed on _postHogToolbarParams', sdkText.includes('eu="_postHogToolbarParams"'));

// (d) negative controls
const staticBoot = "import { analytics } from '/js/vendor/heycatch-sdk-0.8.3.js';\nimport { hideToolbarTrigger } from '/js/heycatch-privacy.js';\nhideToolbarTrigger();";
check('negative control: a static SDK import is detected', /^\s*import\s[^;]*vendor\/heycatch-sdk/m.test(staticBoot));
const unscrubbed = { event: 'x', properties: { $referrer: CLAIM_IN_PATH.replace('/contractor/bid/CLAIMPATH777','/CLAIMREF999') } };
check('negative control: an unscrubbed event would carry the claim id', JSON.stringify(unscrubbed).includes('CLAIMREF999') && !JSON.stringify(js.scrubEvent(unscrubbed)).includes('CLAIMREF999'));

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall gh3352 HeyCatch privacy checks passed');
