// scripts/r120/verify.mjs — R-120 signed-review gate: content detection +
// ECDSA P-256 approval verification. Node 20+, no dependencies (WebCrypto).
//
// gh-1650: constitution entry 6 requires a human read before merging any diff
// that touches legal wording, consent, pricing or money. The old gate
// (.github/workflows/r120-review-gate.yml) authenticated the reviewer by a
// GitHub login that every agent session shares, matched filenames instead of
// content, and was advisory. This module is the base-branch half of the
// replacement: an approval is only valid if it carries an ECDSA P-256
// signature that verifies under the public key committed on main. An agent
// session does not hold the private key, so it structurally cannot produce
// one. See Docs/r120-signed-review.md.
//
// Exports:
//   detectR120Content(diffText)                        -> { hit, lines: [{file, line, rule, side, text}] }
//   verifySignedApproval({owner, repo, pr, headSha, comments, pubJwk})
//                                                      -> { ok, reason, matched }
//   approvalMessage({owner, repo, pr, headSha})        -> the exact string that is signed
//   APPROVAL_LINE_RE, base64urlToBytes, bytesToBase64url

const subtle = globalThis.crypto?.subtle;
if (!subtle) {
  throw new Error('scripts/r120/verify.mjs needs WebCrypto (globalThis.crypto.subtle) — Node 20+ required');
}

// ---------------------------------------------------------------------------
// Approval line format + signing message
// ---------------------------------------------------------------------------

/** One line of a PR comment: `R-120 SIGNED: pr=<n> sha=<40hex> sig=<base64url>` */
export const APPROVAL_LINE_RE = /^R-120 SIGNED:\s+pr=(\d+)\s+sha=([0-9a-fA-F]{40})\s+sig=([A-Za-z0-9_-]+={0,2})\s*$/;

/** The exact UTF-8 string that is signed. Any change here breaks every existing signature. */
export function approvalMessage({ owner, repo, pr, headSha }) {
  return `R-120 ${owner}/${repo}#${Number(pr)} ${String(headSha).toLowerCase()}`;
}

export function base64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return new Uint8Array(Buffer.from(b64 + pad, 'base64'));
}

export function bytesToBase64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isP256PublicJwk(jwk) {
  return (
    jwk && typeof jwk === 'object' && jwk.kty === 'EC' && jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' && typeof jwk.y === 'string' && !('d' in jwk)
  );
}

async function importPublicKey(pubJwk) {
  if (!isP256PublicJwk(pubJwk)) {
    throw new Error('pubJwk is not an EC P-256 public JWK (kty=EC, crv=P-256, x, y, no d)');
  }
  // Only the public coordinates are imported; anything else in the file is ignored.
  const { kty, crv, x, y } = pubJwk;
  return subtle.importKey('jwk', { kty, crv, x, y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/**
 * Scan PR comments for a valid signed approval of the CURRENT head sha.
 *
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {number|string} args.pr          PR number
 * @param {string} args.headSha            current head sha (40 hex)
 * @param {Array<{body?: string, id?: number|string, user?: {login?: string}}>} args.comments
 * @param {object} args.pubJwk             EC P-256 public JWK from the base branch
 * @returns {Promise<{ok: boolean, reason: string, matched: null | {commentId, login, line, pr, sha}}>}
 */
export async function verifySignedApproval({ owner, repo, pr, headSha, comments, pubJwk }) {
  const prNum = Number(pr);
  const sha = String(headSha || '').toLowerCase();
  if (!Number.isInteger(prNum) || prNum <= 0) return { ok: false, reason: `invalid pr number: ${pr}`, matched: null };
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, reason: `invalid head sha: ${headSha}`, matched: null };

  let key;
  try {
    key = await importPublicKey(pubJwk);
  } catch (e) {
    return { ok: false, reason: `public key unusable: ${e.message}`, matched: null };
  }

  const message = new TextEncoder().encode(approvalMessage({ owner, repo, pr: prNum, headSha: sha }));

  const candidates = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = typeof c?.body === 'string' ? c.body : '';
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      const m = APPROVAL_LINE_RE.exec(line);
      if (!m) continue;
      candidates.push({ commentId: c.id ?? null, login: c.user?.login ?? null, line, pr: Number(m[1]), sha: m[2].toLowerCase(), sig: m[3] });
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: 'no `R-120 SIGNED:` line found in any PR comment (REVIEW: PASS / R-120 READ: comments are not signatures)', matched: null };
  }

  // Walk newest-last so the most recent valid approval is the one reported.
  const reasons = [];
  let matched = null;
  for (const cand of candidates) {
    if (cand.pr !== prNum) { reasons.push(`comment ${cand.commentId ?? '?'}: signed for pr=${cand.pr}, this is pr=${prNum}`); continue; }
    if (cand.sha !== sha) { reasons.push(`comment ${cand.commentId ?? '?'}: signed for sha=${cand.sha.slice(0, 12)}, current head is ${sha.slice(0, 12)} (new commits invalidate approval)`); continue; }
    let sigBytes;
    try { sigBytes = base64urlToBytes(cand.sig); } catch { reasons.push(`comment ${cand.commentId ?? '?'}: sig is not base64url`); continue; }
    if (sigBytes.length !== 64) { reasons.push(`comment ${cand.commentId ?? '?'}: sig length ${sigBytes.length} != 64 (raw r||s P-256)`); continue; }
    let valid = false;
    try { valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes, message); } catch { valid = false; }
    if (!valid) { reasons.push(`comment ${cand.commentId ?? '?'}: signature does not verify under the pubkey on main`); continue; }
    matched = { commentId: cand.commentId, login: cand.login, line: cand.line, pr: cand.pr, sha: cand.sha };
  }

  if (matched) {
    return { ok: true, reason: `valid R-120 signature for pr=${prNum} sha=${sha} (comment ${matched.commentId ?? '?'})`, matched };
  }
  return { ok: false, reason: reasons.join('; '), matched: null };
}

// ---------------------------------------------------------------------------
// Content detection
// ---------------------------------------------------------------------------

/** Files whose mere presence in a diff is R-120 content (gate integrity). */
export const GATE_FILES = new Set([
  '.github/r120-review-pubkey.jwk',
  '.github/workflows/r120-signed-review.yml',
  'scripts/r120/verify.mjs',
]);

/** Files/dirs whose content is never scanned. (GATE_FILES are reported once as a whole, not line by line.) */
const EXCLUDED_PATH_RES = [
  // gh-1701: `.spec.` is the sibling of `.test.` and is what Playwright uses.
  // #1720 produced 19 hits, every one a fixture in a `*.spec.ts`, because only
  // `*.test.*` was listed here.
  /(^|\/)[^/]*\.(test|spec)\.[^/]+$/i, // *.test.* and *.spec.*
  /(^|\/)__tests__\//,               // __tests__/
  /(^|\/)package-lock\.json$/,
  /^\.github\/workflows\//,
  /^scripts\/r120\//,
  /^Docs\//,
  /^In Flight\//,
];

// gh-1701 (measured 2026-09-06 against the 15 open PRs): harness paths — test
// helpers, CI detectors, one-off utilities. Their strings are operator-facing
// CLI output and fixture data, not customer copy, and nothing here is the
// executable money path. Every false positive on the open queue that was not a
// SQL GRANT lived here: #1720 (19 hits, Playwright fixtures), #1735 (R-120's
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
// money/legal COPY. Weakening one of these is precisely the diff R-120 exists to
// put in front of a human — #1646 both removes "licensed, insured" sitewide AND
// adds the guard that keeps it removed — so they are scanned in full.
//
// Listing a file here only ever makes the gate scan MORE, so over-inclusion is
// safe by construction. The list is kept honest by
// `COPY_GUARD_FILES covers every copy-holding file under scripts/ and tools/`
// in scripts/r120/verify.scope.test.mjs, which walks the tree and FAILS if a file
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
// money path) which the prose rules passed as "no R-120 content".
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
// dedicated permissions-ratchet check exists (gh-1767) R-120 is the only place
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
];

// Lines that are obviously not user-facing content.
const IMPORT_RE = /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|(const|let|var)\s+[\w$_{}\s,:]+=\s*(await\s+)?(require|import)\s*\(|from\s+\S+\s+import\b|#include\b|using\s+\w+;?$)/;
const URL_ONLY_RE = /^\s*[\-*'"`,(\[]*\s*(https?:\/\/\S+|\/[\w./-]+)\s*[\]),;'"`]*\s*$/i;
// gh-1622 false positive: analytics/script-tag lines (gtag/GTM/ga-gate.js) are never legal or money copy.
const ANALYTICS_RE = /(googletagmanager|\bgtag\b|ga-gate\.js)/i;

/**
 * How much of a file's diff to scan.
 *   'none'          — not scanned (GATE_FILES are reported as one 'gate-file' hit instead)
 *   'currency-only' — literal currency amounts only (harness paths, see HARNESS_PATH_RES)
 *   'full'          — every rule
 */
export function scanModeFor(file) {
  if (!file) return 'none';
  if (GATE_FILES.has(file)) return 'none'; // reported as a single 'gate-file' hit instead
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
// are not code, so their lines are never treated as comments.
const CODE_FILE_RE = /\.(m?[jt]sx?|py|sql|toml|ya?ml|sh|go|rs|java|kt|swift|c|cc|cpp|h)$/i;
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|#(?!\{)|--|<!--)/;

export function isCodeComment(text, file) {
  return !!file && CODE_FILE_RE.test(file) && COMMENT_LINE_RE.test(text);
}

export function classifyLine(text, file, mode = 'full') {
  if (mode === 'none') return null;
  if (isNoiseLine(text)) return null;
  const comment = isCodeComment(text, file);
  for (const { rule, re } of RULES) {
    if (rule !== 'currency-amount') continue;
    if (comment && !/_CENTS\s*=/.test(text)) continue; // "$25" in a comment is prose
    if (re.test(text)) return rule;
  }
  // Harness paths stop here: a literal price in a script is still a price, but a
  // fixture's `acvPayout` and a --help string's "credit" are not money wording.
  if (mode === 'currency-only') return null;
  if (!comment && file && CODE_FILE_RE.test(file) && MONEY_IDENT_RE.test(text)) {
    if (SQL_COMMENT_ON_RE.test(text)) return null;          // database docstring, not money logic
    if (SQL_PERMISSION_RE.test(text)) return 'money-permission';
    return 'money-identifier';
  }
  if (comment) return null;
  for (const { rule, re } of RULES) {
    if (rule === 'currency-amount') continue;
    if (re.test(text)) return rule;
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
export function detectR120Content(diffText) {
  const out = [];
  const files = [];
  const seenGate = new Set();
  const seenPermission = new Set(); // gh-1701: one 'money-permission' hit per file
  let file = null;
  let mode = 'none';
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
      if (file && GATE_FILES.has(file) && !seenGate.has(file)) {
        seenGate.add(file);
        out.push({ file, line: 0, rule: 'gate-file', side: '+', text: `(any change to ${file} requires a signed approval under the pubkey currently on main)` });
      }
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = stripDiffPath(raw.slice(4));
      if (p) { file = p; mode = scanModeFor(file); }
      continue;
    }
    if (raw.startsWith('--- ')) {
      if (!inHunk) {
        const p = stripDiffPath(raw.slice(4));
        if (p && !file) { file = p; mode = scanModeFor(file); }
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
    if (side === '+') {
      if (file && mode !== 'none') pushHit(out, seenPermission, file, newLine, classifyLine(text, file, mode), '+', text);
      newLine++;
    } else if (side === '-') {
      if (file && mode !== 'none') pushHit(out, seenPermission, file, oldLine, classifyLine(text, file, mode), '-', text);
      oldLine++;
    } else {
      // context line (' ') or anything else
      oldLine++; newLine++;
    }
  }

  return { hit: out.length > 0, lines: out, files };
}

export default { detectR120Content, verifySignedApproval, approvalMessage, APPROVAL_LINE_RE, GATE_FILES, COPY_GUARD_FILES, scanModeFor };
