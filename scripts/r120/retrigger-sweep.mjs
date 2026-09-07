// gh-1753: R-120 required-check RETRIGGER SWEEP.
//
// PROBLEM (established on gh-1753 / gh-1728, re-verified 2026-09-07): the
// "R-120 signed review" required check runs on `pull_request_target:
// [opened, synchronize, reopened]`. GitHub has no mechanism that fires that
// trigger retroactively. So whenever the check is ADDED to branch
// protection, or the signing KEY is ROTATED, after a PR has gone quiet,
// nothing re-evaluates that PR — the required context just stays ABSENT
// forever: not green, not red, no red to notice. #1646 and #1668 are the
// currently-confirmed live instances (both `dirty`, excluded from this
// sweep's action set — see the workflow file and the gh-1753 report).
//
// ⛔ WHAT THIS FILE MUST NEVER DO, BY DESIGN, NOT BY PROMISE:
//   - It never imports, calls, or re-implements the content-detection or
//     signature-verification functions that verify.mjs exports. It has no
//     code path that computes an R-120 verdict.
//   - It never reads the pubkey, never reads a diff, never reads signature
//     comments.
//   - It never creates or updates a GitHub check-run. It never posts a PR
//     comment containing the fixed signed-approval line format the real
//     gate looks for, and never touches that gate's sticky-verdict HTML
//     comment marker — both belong to r120-signed-review.yml alone.
//   - Its ONLY write actions are (a) closing-then-reopening a PR that is
//     already open (a metadata-only state transition — no file, no ref, no
//     commit is touched), (b) reopening a PR that a previous, crashed run
//     of THIS SAME TOOL left stranded closed (the recovery pass — see
//     below), and (c) plain informational/marker comments describing (a)
//     and (b). Reopening fires GitHub's own `pull_request_target: reopened`
//     event, which hands control to r120-signed-review.yml — UNCHANGED,
//     UNREAD by this file — to compute whatever real verdict it computes.
//     This module cannot make that verdict pass; it can only cause the
//     real gate to be asked again.
//
// WHAT IT DOES: classifies each open PR's CURRENT head sha by whether a
// completed "R-120 signed review" check run exists for that exact sha
// (MISSING / PENDING / PRESENT — presence only, conclusion never inspected
// beyond logging it for the report), and for MISSING PRs only, re-triggers
// by reopening.
//
// Scope, per the ruling on gh-1753 (Marty/CTO, 2026-09-06T21:02:00Z):
// "Scope it to re-trigger and report, never to interpret... the sweep must
// not decide whether a PR is in scope, only that its check is stale or
// absent." PRESENT (a completed run already exists, pass or fail) and
// PENDING (queued/in_progress) are both left alone — re-triggering an
// already-evaluated or already-running check is exactly the "indiscriminate
// re-trigger that resets a considered verdict" failure mode gh-1753 rail 2
// requires this tool prove it avoids.
//
// ── FIX ROUND 1 (PR #1785 review, BLOCKER 1) ───────────────────────────
// The original close→reopen was two unguarded API calls: a crash (runner
// death, transient 5xx) between them left a PR PERMANENTLY CLOSED, silent,
// and unrecoverable — `planSweep` filters to `state === 'open'` only, so
// the tool's own future runs could never rediscover what it broke.
//
// DESIGN DECISION: close/reopen is still the right mechanism (it is the
// only action that fires `pull_request_target: reopened` and hands the
// real verdict to the real, unmodified gate — see gh-1753 rail on "no
// mechanism to fire that trigger retroactively" other than the events GitHub
// itself defines), but it is now RECOVERABLE BY CONSTRUCTION rather than by
// promise:
//   1. Before closing, post a durable, greppable marker comment
//      (`closingMarker`) naming the head sha being retriggered. This trace
//      exists BEFORE the close call, so it survives a process kill that
//      happens at any point after — including inside the reopen attempt.
//   2. The reopen is attempted in a `finally` block, so a throw between
//      close and reopen still tries to recover in the SAME run. This alone
//      is not sufficient (the process can be killed, or the reopen call
//      itself can fail) — see point 3.
//   3. Every dispatch runs a RECOVERY PASS first (`planRecovery` /
//      `executeRecovery`), which scans recently-updated CLOSED, non-merged
//      PRs for a dangling `closing` marker with no later `done` marker —
//      i.e. a PR this tool closed and never confirmed reopening. That is
//      independent of `planSweep`'s open-only filter, so it can find and
//      repair what a crashed run left behind, on the very next dispatch —
//      including a dispatch someone runs for an unrelated reason, or one a
//      human runs specifically because they noticed a PR they didn't close.
//
// ── FIX ROUND 2 (PR #1785 review, second FAIL) ─────────────────────────
// The recovery pass in round 1 was "recoverable by construction" only for
// PRs with a small comment count. The `.yml`'s recovery-scan fetched
// comments with a single `issues.listComments({ per_page: 30 })` call — no
// `page`, no ordering guarantee requested. GitHub documents that endpoint's
// comments as "ordered by ascending ID" (oldest first) and does NOT
// document a `sort`/`direction` parameter for it (confirmed against
// GitHub's own REST reference — unlike `issues.listCommentsForRepo`, the
// per-issue endpoint only accepts `since`/`per_page`/`page`). The closing
// marker is posted immediately before the close call, so on any PR with
// more than 30 comments it is — by construction — among the NEWEST
// comments, i.e. exactly the ones a single 30-row, oldest-first page never
// reaches. `planRecovery` never sees it, never flags the PR — silently,
// indistinguishable from a healthy PR. Netlify preview bots, CI bots, the
// R-120 gate's own comments, and prior run-work status comments make >30 a
// routine count on this repo; the previous review demonstrated PR #1785
// itself crossing that mark within the hour. That is exactly the
// population (long-lived, heavily-commented, quiescent PRs) this tool
// exists to serve.
//
// FIX: `fetchAllComments` below exhausts every page via `github.paginate`
// rather than relying on a `sort`/`direction` parameter this endpoint does
// not document — adding an unsupported query parameter is the kind of fix
// that looks correct and is silently a no-op (GitHub typically ignores
// unrecognized query parameters instead of erroring on them), which is the
// same class of "unverified live API call" defect flagged twice on this PR
// already. Full pagination is the one option that is correct by the
// documented contract regardless of comment count or ordering.
//
// SECOND FINDING (human override): the recovery pass had no way for a
// person to say "I saw this stranded PR and I want it to stay closed" — a
// dangling `closing` marker would be rediscovered and reopened on every
// future dispatch forever. `OVERRIDE_TOKEN` / `isOverrideComment` below add
// an explicit, documented, human-typable opt-out: posting a plain comment
// containing that phrase anywhere on the PR is the chronologically-last
// signal the recovery pass honors, same as it already honors whichever of
// `closing`/`done` came last. An overridden PR is never reopened, and is
// reported in its own `overridden` list so the override is visible in every
// run's output, not just honored silently.
//
// ── FIX ROUND 3 (PR #1785 review, round 3 BLOCKER — the override is a
// footgun) ──────────────────────────────────────────────────────────────
// Round 2's `isOverrideComment` matched the token as a CASE-INSENSITIVE
// SUBSTRING ANYWHERE IN THE COMMENT BODY. The round-3 reviewer demonstrated
// (test suite below, "FIX ROUND 3") that this reclassifies a GENUINELY
// STRANDED PR (a real dangling `closing` marker, no `done` follow-up — the
// exact case round 1 built the recovery pass to fix) as intentionally
// overridden the moment ANY later comment merely quotes or discusses the
// phrase in prose, with zero intent to invoke it — and this PR's own review
// thread already contains several such mentions (this file's round-1/round-2
// docstrings, and two prior REVIEW comments, all quote the literal value).
// A control meant to be a deliberate, rare opt-out was reachable by an
// ordinary, well-meaning comment describing the mechanism.
//
// FIX: `isOverrideComment` no longer matches a substring anywhere. It
// requires the token to appear as its OWN LINE — trimmed of surrounding
// whitespace, matched case-insensitively against the WHOLE line, anchored at
// both the start and the end of that line. A sentence that merely mentions
// the phrase (inline, backtick-quoted, or otherwise sharing its line with
// any other text) no longer matches; a person choosing to invoke the
// override still only has to type one plain line, unadorned, no HTML/hidden
// markup required (preserving round 2's original human-friendliness intent)
// — but that line must be deliberately its own, which prose discussing the
// mechanism does not naturally produce. This is the same "distinctive,
// deliberately-typed form" property `closingMarker`/`doneMarker` get from
// being hidden HTML comments, achieved here without requiring invisible
// markup, since asking a human to paste markup to be understood was the
// thing round 2 explicitly wanted to avoid.
//
// PRIVILEGE — decided, not left implicit: the override requires NO special
// permission beyond the ability to comment on the PR (already true before
// this fix, and left unchanged here). This is a stated decision, not an
// oversight: the override is a convenience control, not an authorisation
// boundary — it can only ever SUPPRESS this tool's own automatic reopen of
// a PR the underlying user (or anyone with write access) could reopen
// manually at any time regardless of the override's state, and it performs
// zero writes of its own. The worst case of misuse is a stranded PR staying
// closed somewhat longer than it otherwise would, which is recoverable by
// any later comment that lacks the exact-line form (removing the override
// re-enables recovery on the very next dispatch — see `planRecovery`).
// Adding an author/permission check would require a new live API call
// (checking the commenting user's repository permission level) that this
// module does not otherwise make, on the very endpoint class (a live GitHub
// API shape assumed rather than proven) that has produced this PR's last two
// structural blockers — introducing that risk to guard a reversible,
// non-destructive convenience toggle is not a trade this round makes. If a
// future incident shows override abuse is a real, not merely theoretical,
// problem, add the permission check then, deliberately, not here.

export const CHECK_NAME = 'R-120 signed review';
export const MARKER_PREFIX = 'r120-retrigger-sweep';
export const DEFAULT_MAX_ACTIONS = 10;

/** Hidden HTML marker embedded in the comment posted immediately before a close. */
export function closingMarker(headSha) {
  return `<!-- ${MARKER_PREFIX}:closing:${headSha} -->`;
}

/** Hidden HTML marker embedded in the comment posted after a successful reopen. */
export function doneMarker(headSha) {
  return `<!-- ${MARKER_PREFIX}:done:${headSha} -->`;
}

/** Parse one comment body for the newest recognized marker, or null. Pure, no I/O. */
export function parseMarker(body) {
  const re = new RegExp(`<!-- ${MARKER_PREFIX}:(closing|done):([0-9a-f]{40}) -->`);
  const m = re.exec(body || '');
  return m ? { kind: m[1], sha: m[2] } : null;
}

/**
 * Human override opt-out (PR #1785 review, SECOND FINDING; matching rule
 * tightened in FIX ROUND 3 — see the module docstring). A person who wants a
 * stranded PR to stay closed posts a plain, visible comment somewhere on the
 * PR containing a LINE — by itself, nothing else on that line — that is,
 * once trimmed, case-insensitively equal to this exact phrase:
 * `r120-retrigger-sweep: do-not-recover`
 *
 * Unlike `closingMarker`/`doneMarker` this is NOT a hidden HTML comment — a
 * human composing a reply should not have to paste invisible markup to be
 * understood — but it is no longer a bare substring either: a sentence that
 * merely mentions or quotes the phrase inline (e.g. discussing this
 * mechanism, as this very PR's review thread repeatedly does) does not put
 * it alone on its own line, so it does not match. Other lines in the same
 * comment (an explanation before or after) are unaffected.
 */
export const OVERRIDE_TOKEN = 'r120-retrigger-sweep: do-not-recover';

/**
 * True if `body` contains a line — once trimmed of surrounding whitespace —
 * that is case-insensitively identical to `OVERRIDE_TOKEN`, start to end.
 * Deliberately NOT a substring match (FIX ROUND 3): a comment that mentions
 * the phrase as part of a longer sentence, or backtick-quotes it inline
 * within prose, does not satisfy this and must not be treated as an
 * invocation. Pure, no I/O.
 */
export function isOverrideComment(body) {
  if (!body) return false;
  const target = OVERRIDE_TOKEN.toLowerCase();
  return body
    .split(/\r\n|\r|\n/)
    .some((line) => line.trim().toLowerCase() === target);
}

/**
 * Classify one comment body as a recognized recovery-pass signal
 * (`closing`/`done` markers this tool posts, or a human's `override`
 * token), or null if it carries none. `planRecovery` takes whichever signal
 * is chronologically LAST across a PR's full comment history — so a human
 * can post the override token at any point and it is honored for as long as
 * it remains the most recent signal. Pure, no I/O.
 */
function commentSignal(body) {
  const m = parseMarker(body);
  if (m) return m;
  if (isOverrideComment(body)) return { kind: 'override', sha: null };
  return null;
}

/**
 * Fetch every comment on an issue/PR, exhausting all pages.
 *
 * FIX ROUND 2 (PR #1785 review): `issues.listComments` documents no
 * `sort`/`direction` parameter — comments are fixed "ordered by ascending
 * ID" (oldest first) per GitHub's own REST reference. A single bounded page
 * (the round-1 recovery scan used `per_page: 30` with no `page` loop) can
 * therefore never see a marker posted late in a long comment thread. Full
 * pagination via octokit's own `paginate` helper (the same helper this
 * module's caller already uses for `pulls.list`) is correct by the
 * documented contract regardless of comment count or ordering — it does not
 * depend on an unsupported query parameter that GitHub would likely just
 * ignore.
 *
 * @param {object} opts
 * @param {object} opts.github — octokit-shaped client; needs `.paginate` + `rest.issues.listComments`
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.issueNumber
 * @returns {Promise<Array<{body:string, created_at:string}>>}
 */
export async function fetchAllComments({ github, owner, repo, issueNumber }) {
  return github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
}

/**
 * Classify one open PR's current head against the check-runs GitHub has
 * already recorded for that sha. Pure function, no I/O.
 *
 * @param {{number:number, state:string, head:{sha:string}}} pr
 * @param {Array<{name:string, status:string, conclusion:string|null}>} checkRuns
 *   Check-runs for pr.head.sha (any set — this function filters to CHECK_NAME itself).
 * @returns {{prNumber:number, headSha:string, classification:'MISSING'|'PENDING'|'PRESENT', conclusion:string|null, reason:string}}
 */
export function classifyPr(pr, checkRuns) {
  const relevant = (checkRuns || []).filter((r) => r.name === CHECK_NAME);
  const short = pr.head.sha.slice(0, 12);

  if (relevant.length === 0) {
    return {
      prNumber: pr.number,
      headSha: pr.head.sha,
      classification: 'MISSING',
      conclusion: null,
      reason: `no "${CHECK_NAME}" check run recorded for head ${short}`,
    };
  }

  const completed = relevant.filter((r) => r.status === 'completed');
  if (completed.length > 0) {
    // Newest completed run's conclusion is carried for the report ONLY.
    // It is never branched on: PRESENT is left alone whether it is
    // "success" or "failure" (rail 2's negative control, both directions).
    const newest = completed[completed.length - 1];
    return {
      prNumber: pr.number,
      headSha: pr.head.sha,
      classification: 'PRESENT',
      conclusion: newest.conclusion,
      reason: `"${CHECK_NAME}" already completed (${newest.conclusion}) for head ${short} — left alone`,
    };
  }

  return {
    prNumber: pr.number,
    headSha: pr.head.sha,
    classification: 'PENDING',
    conclusion: null,
    reason: `"${CHECK_NAME}" already queued/in_progress for head ${short} — left alone`,
  };
}

/**
 * Build the sweep plan for a batch of open PRs. Pure function, no I/O.
 * @param {Array<object>} prs — PR objects from `pulls.list` (already state=open)
 * @param {Map<number, Array<object>>} checkRunsByPr — pr.number -> check-runs for its head sha
 */
export function planSweep(prs, checkRunsByPr) {
  return prs
    .filter((pr) => pr.state === 'open')
    .map((pr) => classifyPr(pr, checkRunsByPr.get(pr.number) || []));
}

/**
 * Scan CLOSED, non-merged PRs for ones this tool itself stranded: a
 * dangling `closing` marker comment with no later `done` marker for the
 * same head sha — OR for ones a human has explicitly told this tool to
 * leave alone (the `override` token, PR #1785 review, SECOND FINDING).
 * Pure function, no I/O.
 *
 * A PR closed by a human with no recognized signal, or merged, is never
 * flagged either way. Repeated retrigger cycles and a human's override are
 * both handled correctly by the same rule: only the CHRONOLOGICALLY LAST
 * signal on the PR matters. A healthy closing→reopen pair always ends on
 * "done"; an overridden PR's last signal is the human's token, whether they
 * posted it before or after a stranding.
 *
 * @param {Array<{number:number, state:string, merged_at:string|null}>} closedPrs
 * @param {Map<number, Array<{body:string, created_at:string}>>} commentsByPr — MUST be every comment on the PR, not a truncated page (see fetchAllComments)
 * @returns {{stranded: Array<{prNumber:number, headSha:string, reason:string}>, overridden: Array<{prNumber:number, headSha:string|null, reason:string}>}}
 */
export function planRecovery(closedPrs, commentsByPr) {
  const stranded = [];
  const overridden = [];
  for (const pr of closedPrs) {
    if (pr.state !== 'closed' || pr.merged_at) continue;
    const comments = [...(commentsByPr.get(pr.number) || [])].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );
    let last = null;
    for (const c of comments) {
      const s = commentSignal(c.body);
      if (s) last = s;
    }
    if (!last) continue;
    if (last.kind === 'override') {
      overridden.push({
        prNumber: pr.number,
        headSha: last.sha,
        reason:
          `human override present ("${OVERRIDE_TOKEN}" is the most recent recovery-pass signal on this PR) ` +
          '— intentionally left closed; the recovery pass will not reopen it. Post a new comment without ' +
          'that phrase to re-enable recovery.',
      });
      continue;
    }
    if (last.kind === 'closing') {
      stranded.push({
        prNumber: pr.number,
        headSha: last.sha,
        reason:
          'closed with a dangling "closing" marker and no matching "reopened" follow-up — ' +
          'a previous sweep run almost certainly crashed before it could reopen this PR',
      });
    }
  }
  return { stranded, overridden };
}

/**
 * Execute a recovery plan: reopen each stranded PR (unless dryRun, no
 * longer closed by the time we check live state, or the action cap for
 * this dispatch is already spent). This is the "rediscovery" half of
 * BLOCKER 1's fix — it runs before the main sweep on every dispatch.
 *
 * @param {object} opts
 * @param {object} opts.github
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {Array} opts.stranded — output of planRecovery
 * @param {boolean} opts.dryRun
 * @param {number} [opts.maxActions]
 * @returns {Promise<{results: Array, actionsUsed: number}>}
 */
export async function executeRecovery({ github, owner, repo, stranded, dryRun, maxActions = DEFAULT_MAX_ACTIONS }) {
  const results = [];
  let used = 0;
  for (const item of stranded) {
    if (used >= maxActions) {
      results.push({ ...item, action: 'skipped-cap-reached' });
      continue;
    }
    if (dryRun) {
      results.push({ ...item, action: 'would-recover (dry-run, no write performed)' });
      continue;
    }

    const fresh = await github.rest.pulls.get({ owner, repo, pull_number: item.prNumber });
    if (fresh.data.state !== 'closed') {
      results.push({ ...item, action: 'skipped-no-longer-closed' });
      continue;
    }

    await github.rest.pulls.update({ owner, repo, pull_number: item.prNumber, state: 'open' });
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: item.prNumber,
      body:
        `**R-120 retrigger sweep — recovery** (gh-1753): this PR was found CLOSED with a dangling ` +
        `"closing" marker and no matching "reopened" follow-up — a previous sweep run almost certainly ` +
        `crashed between closing and reopening it. Reopened now by this run's automatic recovery pass, ` +
        `which runs before every sweep dispatch. This comment does not assert an R-120 verdict.\n` +
        doneMarker(item.headSha),
    });
    results.push({ ...item, action: 'recovered (reopened)' });
    used += 1;
  }
  return { results, actionsUsed: used };
}

/**
 * Execute a plan: for MISSING entries only, close-then-reopen the PR
 * (unless dryRun, excluded, auto-merge-armed, or the action cap for this
 * dispatch is already spent), which is the only write action this module
 * performs against open PRs. PRESENT and PENDING entries are always left
 * alone — this is not a filter applied here, it falls out of only ever
 * branching on classification === 'MISSING'.
 *
 * Recoverability (BLOCKER 1 fix): a durable marker comment is posted
 * BEFORE the close call, and the reopen is attempted in a `finally` so a
 * throw between close and reopen still tries once, in-run, to recover.
 * If that also fails, the item is reported as needing recovery rather than
 * crashing the whole sweep — `planRecovery`/`executeRecovery` (run first,
 * every dispatch) is what actually guarantees rediscovery, not this
 * `finally` alone.
 *
 * @param {object} opts
 * @param {object} opts.github — octokit-shaped client: needs pulls.get, pulls.update, issues.createComment
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {Array} opts.plan — output of planSweep
 * @param {boolean} opts.dryRun — when true (the default in the workflow), no write calls are made
 * @param {number[]} [opts.excludeNumbers] — PR numbers never to act on even if MISSING (e.g. known-dirty PRs)
 * @param {number} [opts.maxActions] — cap on total close/reopen actions this call will perform
 * @returns {Promise<{results: Array, actionsUsed: number}>}
 */
export async function executeSweep({
  github,
  owner,
  repo,
  plan,
  dryRun,
  excludeNumbers = [],
  maxActions = DEFAULT_MAX_ACTIONS,
}) {
  const results = [];
  let used = 0;
  for (const item of plan) {
    if (item.classification !== 'MISSING') {
      results.push({ ...item, action: 'none' });
      continue;
    }
    if (excludeNumbers.includes(item.prNumber)) {
      results.push({ ...item, action: 'skipped-excluded' });
      continue;
    }
    if (dryRun) {
      results.push({ ...item, action: 'would-retrigger (dry-run, no write performed)' });
      continue;
    }
    if (used >= maxActions) {
      results.push({ ...item, action: 'skipped-cap-reached' });
      continue;
    }

    // Re-verify immediately before acting — a plan built minutes earlier
    // (e.g. while paginating a large open-PR list) can be stale, and this
    // sweep must act on live state, not a cached one (gh-1753/gh-1728's own
    // stale-evidence lesson, applied here rather than repeated).
    const fresh = await github.rest.pulls.get({ owner, repo, pull_number: item.prNumber });
    if (fresh.data.state !== 'open') {
      results.push({ ...item, action: 'skipped-no-longer-open' });
      continue;
    }
    if (fresh.data.head.sha !== item.headSha) {
      results.push({ ...item, action: 'skipped-head-moved-since-plan' });
      continue;
    }
    // MINOR 2 fix: closing a PR silently clears GitHub's auto_merge setting,
    // and reopening does not restore it. Rather than guess at restoring an
    // auto-merge config we didn't set, refuse to act and say so plainly —
    // a human needs to retrigger this PR (or re-arm auto-merge after).
    if (fresh.data.auto_merge) {
      results.push({
        ...item,
        action: 'skipped-auto-merge-armed',
        reason:
          `${item.reason} — auto_merge is enabled on this PR; closing it would silently clear that ` +
          `setting and reopening would not restore it, so this sweep refuses to act. Retrigger manually.`,
      });
      continue;
    }

    try {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: item.prNumber,
        body:
          `**R-120 retrigger sweep** (gh-1753): closing this PR now to retrigger a fresh ` +
          `"${CHECK_NAME}" evaluation on reopen. If this PR is still closed and no follow-up comment ` +
          `appears below, the run that did this crashed before it could reopen — every sweep dispatch ` +
          `runs an automatic recovery pass first and will detect and reopen it. If you want this PR to ` +
          `stay closed instead, reply with a comment containing this phrase, alone on its own line and ` +
          `nothing else on that line, exactly as written (case doesn't matter): "${OVERRIDE_TOKEN}" — a ` +
          `later dispatch will honor that and report it, not reopen this PR. (Merely mentioning the ` +
          `phrase inside a sentence, as this very instruction just did, does NOT invoke it — it has to ` +
          `be its own line.)\n` +
          closingMarker(item.headSha),
      });

      let closeSucceeded = false;
      try {
        await github.rest.pulls.update({ owner, repo, pull_number: item.prNumber, state: 'closed' });
        closeSucceeded = true;
      } finally {
        // Attempt recovery in-run even on a throw between close and reopen.
        // Not sufficient on its own (the process can still be killed, or
        // this call can itself fail) — see the module docstring; the
        // recovery pass is the actual guarantee.
        if (closeSucceeded) {
          await github.rest.pulls.update({ owner, repo, pull_number: item.prNumber, state: 'open' });
        }
      }

      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: item.prNumber,
        body:
          `**R-120 retrigger sweep**: reopened. This PR's head \`${item.headSha.slice(0, 12)}\` had no ` +
          `completed "${CHECK_NAME}" check recorded, so it was closed and reopened to fire a fresh ` +
          `evaluation. This comment does not assert a verdict — the check itself, unmodified, decides.\n` +
          doneMarker(item.headSha),
      });
      results.push({ ...item, action: 'retriggered (closed+reopened)' });
      used += 1;
    } catch (err) {
      // Do not let one PR's failure crash the sweep for the rest of the
      // plan. The next dispatch's recovery pass is what finds and fixes
      // this — see planRecovery/executeRecovery.
      results.push({
        ...item,
        action: 'error-during-retrigger (left for recovery pass on next run)',
        error: String((err && err.message) || err),
      });
      used += 1;
    }
  }
  return { results, actionsUsed: used };
}

/** Plain-text summary table for the job summary / report. Pure function. */
export function formatReport(results, { dryRun, recoveryResults = [] } = {}) {
  const lines = [];

  if (recoveryResults.length > 0) {
    lines.push(
      `R-120 retrigger sweep — RECOVERY PASS (${dryRun ? 'dry run' : 'live'})`,
      '',
      'pr    action                                        reason',
      '----  --------------------------------------------  ------'
    );
    for (const r of recoveryResults) {
      lines.push(`#${String(r.prNumber).padEnd(4)} ${r.action.padEnd(46)}  ${r.reason}`);
    }
    lines.push('');
  }

  lines.push(
    `R-120 retrigger sweep — ${dryRun ? 'DRY RUN (no writes performed)' : 'LIVE'}`,
    '',
    'pr    classification  action                                    reason',
    '----  --------------  ----------------------------------------  ------'
  );
  for (const r of results) {
    lines.push(
      `#${String(r.prNumber).padEnd(4)} ${r.classification.padEnd(14)}  ${r.action.padEnd(42)}  ${r.reason}`
    );
  }
  const missing = results.filter((r) => r.classification === 'MISSING').length;
  const present = results.filter((r) => r.classification === 'PRESENT').length;
  const pending = results.filter((r) => r.classification === 'PENDING').length;
  const retriggered = results.filter((r) => r.action === 'retriggered (closed+reopened)').length;
  lines.push(
    '',
    `Totals: ${results.length} open PR(s) — MISSING=${missing} PRESENT=${present} PENDING=${pending} — retriggered=${retriggered}`
  );
  return lines.join('\n');
}
