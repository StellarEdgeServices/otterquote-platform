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
  /(^|\/)[^/]*\.test\.[^/]+$/i,     // *.test.*
  /(^|\/)__tests__\//,               // __tests__/
  /(^|\/)package-lock\.json$/,
  /^\.github\/workflows\//,
  /^scripts\/r120\//,
  /^Docs\//,
  /^In Flight\//,
];

// Money-path IDENTIFIERS (code, not prose). \b treats `_` as a word char, so the
// prose money-word rule never sees `has_payment_method` or `accept_bid` — measured
// 2026-09-05 on PR #1670 (a BEFORE UPDATE trigger + accept_bid rewrite on the
// money path) which the prose rules passed as "no R-120 content".
const MONEY_IDENT_RE = /(payment|payout|stripe|refund|charge|invoice|price|pricing|fee_|_fee|cents|amount|award|accept_bid|is_test|live_charge|balance|commission|rebate|credit)/i;

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

function isExcludedPath(file) {
  if (GATE_FILES.has(file)) return true; // reported as a single 'gate-file' hit instead
  return EXCLUDED_PATH_RES.some((re) => re.test(file));
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

export function classifyLine(text, file) {
  if (isNoiseLine(text)) return null;
  const comment = isCodeComment(text, file);
  for (const { rule, re } of RULES) {
    if (rule !== 'currency-amount') continue;
    if (comment && !/_CENTS\s*=/.test(text)) continue; // "$25" in a comment is prose
    if (re.test(text)) return rule;
  }
  if (!comment && file && CODE_FILE_RE.test(file) && MONEY_IDENT_RE.test(text)) return 'money-identifier';
  if (comment) return null;
  for (const { rule, re } of RULES) {
    if (rule === 'currency-amount') continue;
    if (re.test(text)) return rule;
  }
  return null;
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
  let file = null;
  let excluded = true;
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
      excluded = file ? isExcludedPath(file) : true;
      if (file && GATE_FILES.has(file) && !seenGate.has(file)) {
        seenGate.add(file);
        out.push({ file, line: 0, rule: 'gate-file', side: '+', text: `(any change to ${file} requires a signed approval under the pubkey currently on main)` });
      }
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = stripDiffPath(raw.slice(4));
      if (p) { file = p; excluded = isExcludedPath(file); }
      continue;
    }
    if (raw.startsWith('--- ')) {
      if (!inHunk) {
        const p = stripDiffPath(raw.slice(4));
        if (p && !file) { file = p; excluded = isExcludedPath(file); }
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
      if (!excluded && file) { const rule = classifyLine(text, file); if (rule) out.push({ file, line: newLine, rule, side: '+', text: text.trim().slice(0, 200) }); }
      newLine++;
    } else if (side === '-') {
      if (!excluded && file) { const rule = classifyLine(text, file); if (rule) out.push({ file, line: oldLine, rule, side: '-', text: text.trim().slice(0, 200) }); }
      oldLine++;
    } else {
      // context line (' ') or anything else
      oldLine++; newLine++;
    }
  }

  return { hit: out.length > 0, lines: out, files };
}

export default { detectR120Content, verifySignedApproval, approvalMessage, APPROVAL_LINE_RE, GATE_FILES };
