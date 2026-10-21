// R-177 pair gate (gh-2965). Pure decision logic for the required-status candidate
// "R-177 pair gate" (.github/workflows/r177-pair-gate.yml). No network, no
// dependencies: every GitHub read goes through the injected `api` object, so
// scripts/r177/gate.test.mjs can drive it with fakes.
//
// Rule (constitution entry 6 / R-177): a PR flagged `r177:legal-read` (or whose
// title carries [R-120]/[R-177]) passes only if BOTH of these were posted by a
// HUMAN (never a bot) and name the PR's current head sha, or a sha reachable
// from the head through main-merge-only commits:
//   - a comment starting `LEGAL-READ: PASS` containing the sha, and
//   - a comment starting `R-177 SIGNED: pr=<n> sha=<sha>`, or the CEO template:
//     first line starts `R-177 SIGNED:` and a `Head: <40-hex sha>` line within
//     the next five lines.
// This mirrors r177_ok() in In Flight/bin/pr-merge-serial-device.py, with one
// deliberate tightening (note: the local tool sets STRICT_HEAD=True, cto76, #2912,
// which disables the main-merge walk entirely; this CI gate is looser than that tool
// and the two should be reconciled -- REVIEW 6323696495 item 4): a "main-merge" is verified structurally, not by its
// commit message (see mainMergeChain).

export const LABEL = 'r177:legal-read';
export const TITLE_RE = /\[R-1(20|77)\]/;
export const MAX_CHAIN = 10;
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

// github-actions[bot] interpolates the exact `R-177 SIGNED: pr=<n> sha=<head>`
// text into its notice comment; bot comments must never count (ceo38, R-077).
export function isHumanComment(c) {
  const u = (c && c.user) || {};
  return u.type !== 'Bot' && !String(u.login || '').endsWith('[bot]');
}

export function pairFor(comments, prNumber, chain) {
  const bodies = comments.filter(isHumanComment).map((c) => c.body || '');
  const readOk = bodies.some(
    (x) => x.trimStart().startsWith('LEGAL-READ: PASS') && chain.some((h) => x.includes(h)),
  );
  let signOk = bodies.some((x) =>
    chain.some((h) => x.trimStart().startsWith(`R-177 SIGNED: pr=${prNumber} sha=${h}`)),
  );
  if (!signOk) {
    signOk = bodies.some((x) => {
      const ls = x.trimStart().split(/\r?\n/);
      return (
        ls[0].startsWith('R-177 SIGNED:') &&
        chain.some((h) => h.length === 40 && ls.slice(1, 6).some((l) => l.trim().startsWith('Head: ' + h)))
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
  const flagged = isFlagged({ labels: pr.labels || [], title: pr.title });
  if (!flagged) {
    return { ok: true, flagged, headSha, readOk: null, signOk: null, chain: [headSha],
      message: `PR #${prNumber} is not flagged ${LABEL}; gate not applicable.` };
  }
  const comments = await api.listComments(prNumber);
  const chain = await mainMergeChain(api, headSha);
  const { readOk, signOk } = pairFor(comments, prNumber, chain);
  const ok = readOk && signOk;
  const missing = [!readOk && 'LEGAL-READ: PASS', !signOk && 'R-177 SIGNED'].filter(Boolean);
  return { ok, flagged, headSha, readOk, signOk, chain,
    message: ok
      ? `PR #${prNumber}: LEGAL-READ: PASS and R-177 SIGNED both name head ${headSha} (chain length ${chain.length}).`
      : `PR #${prNumber} is flagged ${LABEL} and is missing a human ${missing.join(' and ')} naming head ${headSha} ` +
        `(or a main-merge-only ancestor). Post the pair over this exact sha, then re-run this check.` };
}

// merge_group head_ref looks like refs/heads/gh-readonly-queue/main/pr-2964-<sha>
export function prNumberFromMergeGroupRef(ref) {
  const m = /gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]{7,40}$/.exec(ref || '');
  return m ? Number(m[1]) : null;
}
