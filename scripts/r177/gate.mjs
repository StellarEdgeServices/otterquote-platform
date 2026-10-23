// R-177 pair gate (gh-2965). Pure decision logic for the required-status candidate
// "R-177 pair gate" (.github/workflows/r177-pair-gate.yml). No network, no
// dependencies: every GitHub read goes through the injected `api` object, so
// scripts/r177/gate.test.mjs can drive it with fakes.
//
// Rule (constitution entry 6 / R-177): a PR flagged `r177:legal-read` (or whose
// title carries [R-120]/[R-177]) passes only if BOTH of these were posted by a
// TRUSTED HUMAN (OWNER/MEMBER/COLLABORATOR or the company login; never a bot) and name the PR's EXACT current head sha (STRICT_HEAD; no main-merge
// ancestor walk):
//   - a comment starting `LEGAL-READ: PASS` containing the sha, and
//   - a comment starting `R-177 SIGNED: pr=<n> sha=<sha>`, or the CEO template:
//     first line starts `R-177 SIGNED:` and a `Head: <40-hex sha>` line within
//     the next five lines.
// This mirrors r177_ok() in In Flight/bin/pr-merge-serial-device.py, including
// STRICT_HEAD=True (reconciled in gh-2965 strict-head: REVIEW 6323696495 item 4).

export const LABEL = 'r177:legal-read';
export const TITLE_RE = /\[R-1(20|77)\]/;
export const MAX_CHAIN = 10;
// DECIDED 2026-10-21 (#2912 comment 6323562999, Tier A): the pair must name the EXACT head sha
// being merged. A "Merge branch 'main'" commit can carry conflict-resolution edits to the PR's own
// files, so the main-merge ancestor walk is disabled. Matches STRICT_HEAD=True in
// In Flight/bin/pr-merge-serial-device.py. mainMergeChain is kept (tested) but unused while true.
export const STRICT_HEAD = true;
// The commit endpoint returns at most 100 files per page and the workflow asks
// for one page, so a list of 100+ entries may be TRUNCATED and cannot be audited.
// Treat >= 100 (or a missing list) as unauditable and stop the walk: fail closed.
// (REVIEW 6323696495 defect 1.) Chosen over paginating because it needs no extra
// API calls and cannot be defeated by a page-size change; the cost is that a very
// large main-merge needs a fresh pair, which is the safe direction.
export const MAX_MERGE_FILES = 100;

export function isFlagged({ labels = [], title = '' }) {
  const names = labels.map((l) => (typeof l === 'string' ? l : l.name));
  return names.includes(LABEL) || TITLE_RE.test(title || '');
}

// Who may count toward the pair (R-134, REVIEW 6324652357 finding 1; Ben FYI 6324747555).
// The repo is PUBLIC, so any GitHub account can comment. A comment counts only when GitHub says
// the author is OWNER, MEMBER or COLLABORATOR, or the login is the company identity. Bots never
// count: github-actions[bot] interpolates the exact `R-177 SIGNED: pr=<n> sha=<head>` text into
// its notice comment (ceo38, R-077). Accepted limit: every agent role posts as the same identity,
// so this proves the strings exist and who may post them, not which role read or signed.
export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
export const COMPANY_LOGIN = 'dustinstohler1-dotcom';
export function isHumanComment(c) {
  const u = (c && c.user) || {};
  const login = String(u.login || '');
  if (u.type === 'Bot' || login.endsWith('[bot]')) return false;
  return TRUSTED_ASSOCIATIONS.includes(c && c.author_association) || login === COMPANY_LOGIN;
}

// A sha counts only as a whole token: not a prefix, suffix or middle of a longer hex run.
const HEX = '0-9a-fA-F';
export function hasShaToken(text, sha) {
  const esc = String(sha).replace(/[^0-9a-zA-Z]/g, '');
  return new RegExp(`(?<![${HEX}])${esc}(?![${HEX}])`).test(text);
}

export function pairFor(comments, prNumber, chain) {
  const bodies = comments.filter(isHumanComment).map((c) => c.body || '');
  // `PASS` must end at a word boundary ("PASSING ... NOT" no longer counts).
  const readOk = bodies.some(
    (x) => /^LEGAL-READ: PASS(?![A-Za-z0-9_])/.test(x.trimStart()) && chain.some((h) => hasShaToken(x, h)),
  );
  let signOk = bodies.some((x) =>
    chain.some((h) => {
      const t = x.trimStart();
      const lead = `R-177 SIGNED: pr=${prNumber} sha=${h}`;
      return t.startsWith(lead) && !new RegExp(`^[${HEX}]`).test(t.slice(lead.length));
    }),
  );
  if (!signOk) {
    signOk = bodies.some((x) => {
      const ls = x.trimStart().split(/\r?\n/);
      return (
        ls[0].startsWith('R-177 SIGNED:') &&
        chain.some((h) => h.length === 40 && ls.slice(1, 6).some((l) => {
          const t = l.trim();
          return t.startsWith('Head: ' + h) && !new RegExp(`^[${HEX}]`).test(t.slice(6 + h.length));
        }))
      );
    });
  }
  return { readOk, signOk };
}

// Walk first parents from the PR head. A step is accepted only if the commit is
// a two-parent merge whose SECOND parent is already on main AND whose own diff
// against its first parent adds nothing main does not already contain: every
// file it touches has, in the merge, exactly the second parent's blob (or is
// absent in both). A merge that carries a PR-side change (a conflict
// resolution, an auto-merged file both sides touched, an evil merge) stops the
// walk, so a pair signed before it no longer matches. Fails closed.
export async function mainMergeChain(api, headSha) {
  const chain = [headSha];
  let cur = headSha;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const commit = await api.getCommit(cur);
    const parents = (commit.parents || []).map((p) => p.sha);
    if (parents.length !== 2) break;
    const [p1, p2] = parents;
    if (!['behind', 'identical'].includes(await api.compareStatus('main', p2))) break;
    if (!Array.isArray(commit.files) || commit.files.length >= MAX_MERGE_FILES) break;
    const files = commit.files;
    let clean = true;
    for (const f of files) {
      const mine = f.status === 'removed' ? null : f.sha;
      if ((await api.getBlobSha(p2, f.filename)) !== mine) { clean = false; break; }
      if (f.status === 'renamed' && f.previous_filename &&
          (await api.getBlobSha(p2, f.previous_filename)) !== null) { clean = false; break; }
    }
    if (!clean) break;
    chain.push(p1);
    cur = p1;
  }
  return chain;
}

export async function evaluate(api, prNumber) {
  const pr = await api.getPull(prNumber);
  const headSha = pr.head.sha;
  let flagged = isFlagged({ labels: pr.labels || [], title: pr.title });
  // gh-2965 label race: the labeller (pull_request_target, GITHUB_TOKEN) adds the label seconds
  // after this job reads the PR, and a label added with GITHUB_TOKEN does not trigger a new run, so
  // an unlabeled read can stay green (observed live: PR #3043, gate success 14:40:44Z, label
  // 14:40:41Z). When the label/title say "not flagged", ask the same predicate the labeller uses
  // (api.predicateHit, supplied by run.cjs). A hit flags the PR. Unlabelling cannot unflag it.
  let predicateFlagged = false;
  if (!flagged && typeof api.predicateHit === 'function') {
    predicateFlagged = Boolean(await api.predicateHit(prNumber));
    flagged = predicateFlagged;
  }
  if (!flagged) {
    return { ok: true, flagged, headSha, readOk: null, signOk: null, chain: [headSha],
      message: `PR #${prNumber} is not flagged ${LABEL}; gate not applicable.` };
  }
  const comments = await api.listComments(prNumber);
  const chain = STRICT_HEAD ? [headSha] : await mainMergeChain(api, headSha);
  const { readOk, signOk } = pairFor(comments, prNumber, chain);
  const ok = readOk && signOk;
  const missing = [!readOk && 'LEGAL-READ: PASS', !signOk && 'R-177 SIGNED'].filter(Boolean);
  return { ok, flagged, predicateFlagged, headSha, readOk, signOk, chain,
    message: ok
      ? `PR #${prNumber}: LEGAL-READ: PASS and R-177 SIGNED both name head ${headSha} (chain length ${chain.length}).`
      : `PR #${prNumber} is flagged ${predicateFlagged ? `by the legal/money predicate (label ${LABEL} not applied yet)` : LABEL} and is missing a human ${missing.join(' and ')} naming head ${headSha} ` +
        `(exact head match required). Post the pair over this exact sha, then re-run this check.` };
}

// merge_group head_ref looks like refs/heads/gh-readonly-queue/main/pr-2964-<sha>
export function prNumberFromMergeGroupRef(ref) {
  const m = /gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]{7,40}$/.exec(ref || '');
  return m ? Number(m[1]) : null;
}
