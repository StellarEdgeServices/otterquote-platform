// scripts/r177/predicate.mjs — the R-177 legal/money LABELLER predicate.
//
// R-177 (2026-09-07) retired R-120's human-signature gate. Constitution entry 6
// now requires, on a diff that touches legal wording, consent language, pricing
// or money movement: (a) a `LEGAL-READ: PASS|FAIL …` comment from a
// fresh-context refuter agent that is not the PR's author, and (b) an
// `R-177 SIGNED: pr=<n> sha=<40-hex head sha> — Ben, CEO` comment from the CEO
// over that same head sha. Dustin is never asked to read a diff.
//
// THIS MODULE IS A LABELLER, NOT A GATE. Its only consumer is
// .github/workflows/r177-legal-read.yml, the "R-177 legal-read labeller (informational, always green)" check,
// which ALWAYS exits 0: when the predicate fires it labels the PR
// `r177:legal-read` and posts one notice. The R-177 comment pair is enforced by
// the CTO's merge tooling, not by a required status check.
//
// The predicate below is R-120's, carried over unchanged in behaviour (gh-1650
// content detection + gh-1701 scope narrowing, measured on 15 open PRs). What
// was REMOVED with R-120: `verifySignedApproval`, `approvalMessage`,
// `APPROVAL_LINE_RE`, the base64url helpers, the ECDSA P-256 verification, the
// committed public key `.github/r120-review-pubkey.jwk`, the offline signing
// page `scripts/r120/sign.html`, `scripts/r120/sign.mjs`, and the
// `R-120 signed review` required status check on main.
//
// Node 20+, no dependencies.
//
// Exports:
//   detectLegalMoneyContent(diffText) -> { hit, lines: [{file, line, rule, side, text}], files }
//   classifyLine, scanModeFor, isNoiseLine, isCodeComment, nextHtmlBlockState
//   PREDICATE_FILES, COPY_GUARD_FILES

// ---------------------------------------------------------------------------
// Content detection
// ---------------------------------------------------------------------------

/**
 * Files whose mere presence in a diff is legal/money content: changing the
 * predicate, or the labeller that runs it, is itself a change to how legal and
 * money copy is watched, so it earns the R-177 pair. (Under R-120 this set also
 * held `.github/r120-review-pubkey.jwk`; that key is deleted — R-177 has no
 * signing key.)
 */
export const PREDICATE_FILES = new Set([
  '.github/workflows/r177-legal-read.yml',
  'scripts/r177/predicate.mjs',
]);

/** Files/dirs whose content is never scanned. (PREDICATE_FILES are reported once as a whole, not line by line.) */
const EXCLUDED_PATH_RES = [
  // gh-1701: `*.spec.*` is deliberately NOT listed here. Measured on origin/main
  // (`git ls-tree -r --name-only origin/main | grep '\.spec\.'`): 12 `*.spec.*`
  // files, 10 under tests/e2e/flows and 2 under tests/e2e/smoke, 0 anywhere else.
  // So HARNESS_PATH_RES (`^tests/`) already scopes every one of them to
  // `currency-only`, which is exactly what #1720 needed — all 19 of its hits were
  // `money-identifier` (an `acvPayout`-shaped fixture field) and go quiet — while a
  // literal `$500 platform fee` in a fixture still fires. Excluding `.spec.`
  // outright would instead make that price invisible to the gate.
  /(^|\/)[^/]*\.test\.[^/]+$/i,     // *.test.*
  /(^|\/)__tests__\//,               // __tests__/
  /(^|\/)package-lock\.json$/,
  /^\.github\/workflows\//,
  /^scripts\/r177\//,
  /^Docs\//,
  /^In Flight\//,
];

// gh-1701 (measured 2026-09-06 against the 15 open PRs): harness paths — test
// helpers, CI detectors, one-off utilities. Their strings are operator-facing
// CLI output and fixture data, not customer copy, and nothing here is the
// executable money path. Every false positive on the open queue that was not a
// SQL GRANT lived here: #1720 (19 hits, Playwright fixtures), #1735 (the rule's
// OWN text, quoted in a Python string), #1733 ("Netlify credit/billing" in a
// --help string), #1742 (detector filenames in a dict).
//
// These paths keep the CURRENCY rules — a hard-coded `$15` or `_CENTS =` does
// not stop being a price because it lives in a script — and lose the prose word
// rules and the identifier rule.
const HARNESS_PATH_RES = [
  /^tests\//,
  /^scripts\//,
  /^tools\//,
];

// The exception: files under those paths that hold, quote or emit customer
// money/legal COPY. Weakening one of these is precisely the diff R-177 exists to
// put in front of a second reader — #1646 both removes the D-104 credential-claim
// phrasing sitewide AND adds the guard that keeps it removed — so they are scanned
// in full. (The removed phrase is deliberately NOT quoted here: this file is inside
// COPY_GUARD_FILES, and check-credential-claims.py scans it, so quoting the claim in
// a comment makes the guard fail on the guard — gh-1617.)
//
// Listing a file here only ever makes the gate scan MORE, so over-inclusion is
// safe by construction. The list is kept honest by
// `COPY_GUARD_FILES covers every copy-holding file under scripts/ and tools/`
// in scripts/r177/predicate.scope.test.mjs, which walks the tree and FAILS if a file
// carrying customer copy vocabulary is missing from it. Entries that do not
// exist yet are allowed on purpose: check-credential-claims.py is added by
// #1646 and could not otherwise have been covered on its own PR.
export const COPY_GUARD_FILES = new Set([
  'scripts/check-10k-floor-phrasing.py',
  'scripts/check-credential-claims.py',
  'scripts/check-email-parts.py',
  'scripts/check-legal-surface-links.py',
  'scripts/check-partner-consent-link.py',
  'scripts/check-payout-timing-copy-drift.py',
  'scripts/credential-sweep.py',
  'scripts/find-legal-surface-links.py',
  'scripts/smoke-test.sh',
  'tools/generate_contractor_pages.py',
  'tools/generate_location_pages.py',
  'tools/generate_partner_pages.py',
  'tools/live_charge_guard_parity_check.py',
  'tools/partner_parity_check.py',
]);

// Money-path IDENTIFIERS (code, not prose). \b treats `_` as a word char, so the
// prose money-word rule never sees `has_payment_method` or `accept_bid` — measured
// 2026-09-05 on PR #1670 (a BEFORE UPDATE trigger + accept_bid rewrite on the
// money path) which the prose rules passed as "no legal/money content".
// gh-1701: `is_test` removed 2026-09-06 — a generic environment flag, not a
// money identifier. It fired on `is_test boolean NOT NULL` in an unrelated DDL
// trace (#1683). Test-vs-live CHARGE state is still covered by `live_charge`.
const MONEY_IDENT_RE = /(payment|payout|stripe|refund|charge|invoice|price|pricing|fee_|_fee|cents|amount|award|accept_bid|live_charge|balance|commission|rebate|credit)/i;

// gh-1701: SQL permission statements and database docstrings. In
// `REVOKE EXECUTE ON FUNCTION public.get_platform_fee_percentage() FROM anon;`
// the money words are the OPERAND'S NAME, not wording anyone reads; #1634
// produced 20 identical rows this way.
//
// This deliberately does NOT stop the gate firing. An authorisation change on a
// money-path function is exactly the thing a human should see, and until a
// dedicated permissions-ratchet check exists (gh-1767) this predicate is the only place
// that would catch one. It collapses the file to ONE `money-permission` hit so
// the verdict comment stays readable instead of 20 identical rows. `COMMENT ON`
// is a database docstring and is treated like a code comment.
const SQL_PERMISSION_RE = /^\s*(REVOKE|GRANT)\b/i;
const SQL_COMMENT_ON_RE = /^\s*COMMENT\s+ON\b/i;

const RULES = [
  { rule: 'currency-amount', re: /\$\s?\d/ },
  { rule: 'currency-amount', re: /\b\d+(\.\d+)?\s?(USD|dollars)\b/i },
  { rule: 'currency-amount', re: /_CENTS\s*=/ },
  { rule: 'money-word', re: /\b(price|pricing|fee|fees|refund|charge|charges|rebate|credit|payout|commission|discount|invoice)\b/i },
  { rule: 'legal-consent-word', re: /\b(licens(e|ed|ing)|insured|bonded|vetted|certified|guarantee[ds]?|warrant(y|ies|ed)|consent|agree(ment|s)?|(?<![/\w-])terms|on behalf of|public adjuster|arbitration|disclaimer|liab(le|ility))\b/i },
  // gh-1899 conjunct (2): privacy / data-rights / CAN-SPAM vocabulary. Before this rule the
  // predicate had NO privacy term at all -- a diff could rewrite CCPA/CPRA sale-and-sharing
  // opt-out language, or set the CAN-SPAM postal address, and the labeller stayed silent, so
  // the ABSENCE of `r177:legal-read` was no evidence a diff was legally clean. Measured on
  // the real diffs: #1870 (privacy.html CCPA rights) 0 -> 6 lines, #1862 (CAN-SPAM postal
  // address constant) 0 -> 4, #1839 (Meta Pixel privacy change, already a LEGAL-READ FAIL)
  // 0 -> 1. `POSTAL_ADDRESS` is spelled separately from `postal[_\s]address` because \b does
  // not split on `_`, so the SCREAMING_CASE constant name is not reached by the prose form.
  { rule: 'privacy-data-rights-word', re: /\b(personal (information|data)|CCPA|CPRA|GDPR|CalOPPA|VCDPA|CAN-?SPAM|do not sell|sale or sharing|opt[-\s]?out|unsubscribe|postal[_\s]address|POSTAL_ADDRESS|data subject|data protection|privacy policy|right to (delete|know|correct)|sell (your|my) personal)\b/i },
];

// Lines that are obviously not user-facing content.
const IMPORT_RE = /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|(const|let|var)\s+[\w$_{}\s,:]+=\s*(await\s+)?(require|import)\s*\(|from\s+\S+\s+import\b|#include\b|using\s+\w+;?$)/;
const URL_ONLY_RE = /^\s*[\-*'"`,(\[]*\s*(https?:\/\/\S+|\/[\w./-]+)\s*[\]),;'"`]*\s*$/i;
// gh-1622 false positive: analytics/script-tag lines (gtag/GTM/ga-gate.js) are never legal or money copy.
const ANALYTICS_RE = /(googletagmanager|\bgtag\b|ga-gate\.js)/i;

/**
 * How much of a file's diff to scan.
 *   'none'          — not scanned (PREDICATE_FILES are reported as one 'predicate-file' hit instead)
 *   'currency-only' — literal currency amounts only (harness paths, see HARNESS_PATH_RES)
 *   'full'          — every rule
 */
export function scanModeFor(file) {
  if (!file) return 'none';
  if (PREDICATE_FILES.has(file)) return 'none'; // reported as a single 'predicate-file' hit instead
  if (EXCLUDED_PATH_RES.some((re) => re.test(file))) return 'none';
  if (COPY_GUARD_FILES.has(file)) return 'full';
  if (HARNESS_PATH_RES.some((re) => re.test(file))) return 'currency-only';
  return 'full';
}

export function isNoiseLine(text) {
  const t = text.trim();
  if (t === '') return true;
  if (IMPORT_RE.test(t)) return true;
  if (URL_ONLY_RE.test(t)) return true;
  if (ANALYTICS_RE.test(t)) return true;
  return false;
}

// Code comments are neither customer-visible copy nor executable money logic.
// Measured 2026-09-05: a ZIP-code parser (#1673) and an analytics bucketing
// change (#1674) were blocked on the words "Agreement" / "guarantee" / "/terms"
// inside comments. A comment line is skipped for the WORD rules; currency amounts
// and money identifiers on real code lines still fire. HTML/Markdown/prose files
// are not code, so their lines are never treated as comments -- EXCEPT the
// `<script>`/`<style>` blocks inside an `.html` file (gh-1701 instance 1, below):
// most of our JS lives inline in those blocks, and a `//`/`/* */` comment there
// is exactly as much "not customer copy" as the same comment in a `.js` file.
// HTML TEXT NODES and attribute copy are NOT script/style content and keep
// scanning exactly as before -- this only narrows what happens INSIDE the two
// block types.
const CODE_FILE_RE = /\.(m?[jt]sx?|py|sql|toml|ya?ml|sh|go|rs|java|kt|swift|c|cc|cpp|h)$/i;
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|#(?!\{)|--|<!--)/;

// gh-1701 instance 1: track whether a given `.html` diff line sits inside a
// `<script>` or `<style>` block. Diff-only, best-effort like every other rule
// in this file -- it only ever sees the diff text, never the whole file, so a
// block whose opening tag falls outside the visible hunk context is not
// detected. `nextHtmlBlockState` is called for EVERY visible line (context
// lines included), in order, so the state carries forward correctly whether
// the open/close tag is itself part of the hunk's change or just context.
const HTML_FILE_RE = /\.html?$/i;
const SCRIPT_OPEN_RE = /<script(?:\s[^>]*)?>/i;
const SCRIPT_CLOSE_RE = /<\/script\s*>/i;
const STYLE_OPEN_RE = /<style(?:\s[^>]*)?>/i;
const STYLE_CLOSE_RE = /<\/style\s*>/i;

export function nextHtmlBlockState(state, text) {
  if (state === 'script') return SCRIPT_CLOSE_RE.test(text) ? 'text' : 'script';
  if (state === 'style') return STYLE_CLOSE_RE.test(text) ? 'text' : 'style';
  const scriptOpen = SCRIPT_OPEN_RE.exec(text);
  if (scriptOpen && !SCRIPT_CLOSE_RE.test(text.slice(scriptOpen.index))) return 'script';
  const styleOpen = STYLE_OPEN_RE.exec(text);
  if (styleOpen && !STYLE_CLOSE_RE.test(text.slice(styleOpen.index))) return 'style';
  return 'text';
}

export function isCodeComment(text, file, htmlBlock = 'text') {
  if (!file) return false;
  if (CODE_FILE_RE.test(file)) return COMMENT_LINE_RE.test(text);
  if (HTML_FILE_RE.test(file) && (htmlBlock === 'script' || htmlBlock === 'style')) {
    return COMMENT_LINE_RE.test(text);
  }
  return false;
}

// gh-1899: a legal/money WORD that occurs only inside a URL path segment is a slug, not
// wording anyone reads. Without this, widening the vocabulary widens the false positives too:
// #1889 is a pure routing diff whose only three hits are `warranty` x2 and `prices` x1 inside
// `/blog/...` slugs in `_redirects` and an edge function's route table. Stripping URL path
// tokens before the WORD rules and the money-IDENTIFIER rule takes #1889 from 3 hits to 0.
//
// Deliberately NOT applied to the currency rules: a literal `$1500` in a path is still a price,
// and `_CENTS =` is not URL-shaped. Measured across 32 PRs: 11 hits gained, 3 lost, and all 3
// losses are URL slugs -- no prose hit is lost anywhere.
const URL_PATH_TOKEN_RE = /(?:https?:\/\/\S+)|(?:\/[A-Za-z0-9._~-]+)+/g;
function deslug(text) { return text.replace(URL_PATH_TOKEN_RE, ' '); }

export function classifyLine(text, file, mode = 'full', htmlBlock = 'text') {
  if (mode === 'none') return null;
  if (isNoiseLine(text)) return null;
  const comment = isCodeComment(text, file, htmlBlock);
  for (const { rule, re } of RULES) {
    if (rule !== 'currency-amount') continue;
    if (comment && !/_CENTS\s*=/.test(text)) continue; // "$25" in a comment is prose
    if (re.test(text)) return rule;
  }
  // Harness paths stop here: a literal price in a script is still a price, but a
  // fixture's `acvPayout` and a --help string's "credit" are not money wording.
  if (mode === 'currency-only') return null;
  // gh-1899: the WORD rules and the identifier rule read the line with URL path tokens
  // stripped; the currency rules above deliberately read the raw line.
  const prose = deslug(text);
  if (!comment && file && CODE_FILE_RE.test(file) && MONEY_IDENT_RE.test(prose)) {
    if (SQL_COMMENT_ON_RE.test(text)) return null;          // database docstring, not money logic
    if (SQL_PERMISSION_RE.test(text)) return 'money-permission';
    return 'money-identifier';
  }
  if (comment) return null;
  for (const { rule, re } of RULES) {
    if (rule === 'currency-amount') continue;
    if (re.test(prose)) return rule;
  }
  return null;
}

// gh-1701: a GRANT/REVOKE migration names the same money-path function on every
// line; 20 identical rows train the reader to scroll past the verdict instead of
// reading it, so the file is reported once. The gate still fires.
function pushHit(out, seenPermission, file, line, rule, side, text) {
  if (!rule) return;
  if (rule === 'money-permission') {
    if (seenPermission.has(file)) return;
    seenPermission.add(file);
    out.push({ file, line, rule, side, text: `GRANT/REVOKE on a money-path function — an authorisation change, read it: ${text.trim().slice(0, 140)}` });
    return;
  }
  out.push({ file, line, rule, side, text: text.trim().slice(0, 200) });
}

function stripDiffPath(p) {
  // `a/foo/bar` or `b/foo/bar`; also handles quoted paths and `/dev/null`.
  let s = p.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s === '/dev/null') return null;
  return s.replace(/^[ab]\//, '');
}

/**
 * Scan a unified diff (as returned by GitHub with Accept: application/vnd.github.v3.diff).
 * Only ADDED and REMOVED hunk lines are inspected — never filenames or context lines.
 *
 * @param {string} diffText
 * @returns {{hit: boolean, lines: Array<{file: string, line: number, rule: string, side: '+'|'-', text: string}>, files: string[]}}
 */
export function detectLegalMoneyContent(diffText) {
  const out = [];
  const files = [];
  const seenGate = new Set();
  const seenPermission = new Set(); // gh-1701: one 'money-permission' hit per file
  let file = null;
  let mode = 'none';
  let htmlBlock = 'text'; // gh-1701: 'text' | 'script' | 'style', reset per file
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const lines = String(diffText || '').split(/\r?\n/);
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
      // `diff --git a/<path> b/<path>` — take the b side (new path); the a side for deletions.
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      file = m ? m[2] : null;
      if (file) files.push(file);
      mode = scanModeFor(file);
      htmlBlock = 'text';
      if (file && PREDICATE_FILES.has(file) && !seenGate.has(file)) {
        seenGate.add(file);
        out.push({ file, line: 0, rule: 'predicate-file', side: '+', text: `(any change to ${file} requires a signed approval under the pubkey currently on main)` });
      }
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = stripDiffPath(raw.slice(4));
      if (p) { file = p; mode = scanModeFor(file); htmlBlock = 'text'; }
      continue;
    }
    if (raw.startsWith('--- ')) {
      if (!inHunk) {
        const p = stripDiffPath(raw.slice(4));
        if (p && !file) { file = p; mode = scanModeFor(file); htmlBlock = 'text'; }
      }
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) { oldLine = Number(m[1]); newLine = Number(m[2]); inHunk = true; }
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"

    const side = raw[0];
    const text = raw.slice(1);
    // gh-1701: advance the <script>/<style> tracker on EVERY visible line
    // (context included) before classifying, so a comment inside the block is
    // recognised even when the block's own open/close tag is only context.
    const lineHtmlBlock = htmlBlock;
    if (file && HTML_FILE_RE.test(file)) htmlBlock = nextHtmlBlockState(htmlBlock, text);
    if (side === '+') {
      if (file && mode !== 'none') pushHit(out, seenPermission, file, newLine, classifyLine(text, file, mode, lineHtmlBlock), '+', text);
      newLine++;
    } else if (side === '-') {
      if (file && mode !== 'none') pushHit(out, seenPermission, file, oldLine, classifyLine(text, file, mode, lineHtmlBlock), '-', text);
      oldLine++;
    } else {
      // context line (' ') or anything else
      oldLine++; newLine++;
    }
  }

  return { hit: out.length > 0, lines: out, files };
}

export default { detectLegalMoneyContent, PREDICATE_FILES, COPY_GUARD_FILES, scanModeFor, classifyLine, isNoiseLine, isCodeComment, nextHtmlBlockState };
