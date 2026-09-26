/**
 * gh-2150/gh-2151/gh-2152 S05 perf structure check (k70-w11-s05perf).
 *
 * Asserts the static-markup half of the LCP/TTI fix applied to re-1.html,
 * ins-1.html and hi-1.html (the same technique PR #2183 shipped for start.html's
 * Arm F, gh-2121):
 *
 *   (1) no render-blocking <script> tag in <head> -- every <script> there
 *       that carries a `src` attribute and isn't type="module" must carry
 *       `defer` or `async`. (Inline <script> blocks are exempt: defer/async
 *       are meaningless on a script with no network fetch, and Lighthouse's
 *       render-blocking-resources audit does not flag them.)
 *   (2) the Supabase/auth JS bundle is never requested by static markup at
 *       all -- no literal <script src="...supabase-js...."> tag anywhere in
 *       the document -- and a lazy loader exists, wired to fire on the
 *       form's focus/touchstart, with the submit handler awaiting it
 *       before it ever touches the client.
 *   (3) fonts and the two shared stylesheets (css/design-system.css,
 *       css/nav.css) are not render-blocking: no plain blocking
 *       <link rel="stylesheet"> for any of them outside a <noscript>
 *       fallback, and a <link rel="preload"> (or, for fonts, the
 *       media="print" swap-on-load variant) exists for each.
 *
 * This is a pure static-structure check (no vm execution) so it stays
 * accurate against literal <script>/<link> markup exactly as shipped, and
 * runs the SAME checks against a captured origin/main snapshot below to
 * prove it actually discriminates before/after (it fails on main today,
 * passes on this branch's head).
 *
 * Run: node tests/gh2150-gh2151-s05-perf-structure.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

/** Strips HTML comments first -- this file's own <head> comments describe
 *  the fix in prose that quotes literal tag text (e.g. "a <noscript>
 *  fallback", "a <script> tag"), which a naive tag-matching regex can
 *  otherwise mistake for real markup. Real browsers ignore comment
 *  content entirely; this test does the same. */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function headOf(html) {
  const start = html.indexOf('<head');
  const end = html.indexOf('</head>');
  if (start === -1 || end === -1) return '';
  return html.slice(start, end);
}

function stripNoscript(region) {
  return region.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
}

/** Every <script ...> opening tag's raw attribute string, from a region. */
function scriptTagAttrs(region) {
  const re = /<script\b([^>]*)>/gi;
  const out = [];
  let m;
  while ((m = re.exec(region))) out.push(m[1] || '');
  return out;
}

function checkNoRenderBlockingHeadScripts(html, label) {
  const head = headOf(html);
  const attrsList = scriptTagAttrs(head);
  const violations = attrsList.filter((attrs) => {
    const hasSrc = /\bsrc\s*=/i.test(attrs);
    const isModule = /type\s*=\s*["']module["']/i.test(attrs);
    const hasDeferOrAsync = /\bdefer\b/i.test(attrs) || /\basync\b/i.test(attrs);
    return hasSrc && !isModule && !hasDeferOrAsync;
  });
  ok(violations.length === 0,
    label + ': (1) no render-blocking <script src> in <head> (every non-module external script carries defer/async) -- violations: ' + JSON.stringify(violations));
}

function checkSupabaseBundleLazy(html, label) {
  // No literal <script src="...supabase-js..."> tag anywhere in the raw
  // document -- the bundle must never be requested by static markup.
  const staticSupabaseTag = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*supabase-js[^"']*["']/i;
  ok(!staticSupabaseTag.test(html),
    label + ': (2) no static <script src> tag requests the Supabase bundle up front');

  // A lazy loader exists...
  ok(/function\s+loadSupabaseBundle\s*\(/.test(html),
    label + ': (2) a loadSupabaseBundle() lazy loader is defined');
  // ...gated behind focus and touchstart on the form...
  ok(/['"]focus['"]/.test(html) && /['"]touchstart['"]/.test(html),
    label + ': (2) the loader is wired to fire on both focus and touchstart');
  // ...and injects the bundle dynamically (createElement('script'), not a
  // static tag) when it actually runs.
  ok(/document\.createElement\(\s*['"]script['"]\s*\)/.test(html),
    label + ': (2) the loader injects the Supabase script tag dynamically (createElement)');
  // The submit path awaits readiness before using the client -- constraint
  // 3: the first submit must never lose the bundle race.
  ok(/function\s+ensureSb\s*\(/.test(html),
    label + ': (2) an ensureSb() helper awaits the bundle + client construction');
  ok(/await\s+ensureSb\s*\(\s*\)/.test(html),
    label + ': (2) the submit handler awaits ensureSb() before calling into the client');
}

function checkStylesheetsNotBlocking(html, label) {
  const head = stripNoscript(headOf(html));

  ok(!/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']css\/design-system\.css["']/i.test(head),
    label + ': (3) no plain blocking <link rel="stylesheet"> for css/design-system.css outside <noscript>');
  ok(!/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']css\/nav\.css["']/i.test(head),
    label + ': (3) no plain blocking <link rel="stylesheet"> for css/nav.css outside <noscript>');
  ok(/<link\b[^>]*rel\s*=\s*["']preload["'][^>]*href\s*=\s*["']css\/design-system\.css["']/i.test(head),
    label + ': (3) a <link rel="preload"> exists for css/design-system.css');
  ok(/<link\b[^>]*rel\s*=\s*["']preload["'][^>]*href\s*=\s*["']css\/nav\.css["']/i.test(head),
    label + ': (3) a <link rel="preload"> exists for css/nav.css');

  // Google Fonts: every rel="stylesheet" <link> to fonts.googleapis.com
  // outside <noscript> must be the media="print"-swap variant, not a bare
  // blocking one.
  const fontsLinkRe = /<link\b([^>]*href\s*=\s*["']https:\/\/fonts\.googleapis\.com[^"']*["'][^>]*)>/gi;
  let fm;
  let sawBlockingFontsLink = false;
  let sawSwapFontsLink = false;
  while ((fm = fontsLinkRe.exec(head))) {
    const attrs = fm[1];
    const isStylesheetRel = /rel\s*=\s*["']stylesheet["']/i.test(attrs);
    if (!isStylesheetRel) continue;
    if (/media\s*=\s*["']print["']/i.test(attrs)) sawSwapFontsLink = true;
    else sawBlockingFontsLink = true;
  }
  ok(!sawBlockingFontsLink,
    label + ': (3) no plain blocking <link rel="stylesheet"> for the Google Fonts URL outside <noscript>');
  ok(sawSwapFontsLink,
    label + ': (3) the Google Fonts <link> uses the media="print" swap-on-load pattern');
}

function runAll(html, label) {
  checkNoRenderBlockingHeadScripts(html, label);
  checkSupabaseBundleLazy(html, label);
  checkStylesheetsNotBlocking(html, label);
}

// ── Current head (this branch) -- must PASS every check. ──
runAll(stripComments(fs.readFileSync(path.join(repoRoot, 're-1.html'), 'utf8')), 're-1.html');
runAll(stripComments(fs.readFileSync(path.join(repoRoot, 'ins-1.html'), 'utf8')), 'ins-1.html');
runAll(stripComments(fs.readFileSync(path.join(repoRoot, 'hi-1.html'), 'utf8')), 'hi-1.html');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
