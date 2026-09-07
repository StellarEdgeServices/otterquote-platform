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
//   - Its ONLY write action is closing-then-reopening a PR that is already
//     open (a metadata-only state transition — no file, no ref, no commit
//     is touched) plus a plain informational comment. Reopening fires
//     GitHub's own `pull_request_target: reopened` event, which hands
//     control to r120-signed-review.yml — UNCHANGED, UNREAD by this file —
//     to compute whatever real verdict it computes. This module cannot make
//     that verdict pass; it can only cause the real gate to be asked again.
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

export const CHECK_NAME = 'R-120 signed review';

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
 * Execute a plan: for MISSING entries only, close-then-reopen the PR
 * (unless dryRun or excluded), which is the only write action this module
 * performs. PRESENT and PENDING entries are always left alone — this is
 * not a filter applied here, it falls out of only ever branching on
 * classification === 'MISSING'.
 *
 * @param {object} opts
 * @param {object} opts.github — octokit-shaped client: needs pulls.get, pulls.update, issues.createComment
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {Array} opts.plan — output of planSweep
 * @param {boolean} opts.dryRun — when true (the default in the workflow), no write calls are made
 * @param {number[]} [opts.excludeNumbers] — PR numbers never to act on even if MISSING (e.g. known-dirty PRs)
 */
export async function executeSweep({ github, owner, repo, plan, dryRun, excludeNumbers = [] }) {
  const results = [];
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

    await github.rest.pulls.update({ owner, repo, pull_number: item.prNumber, state: 'closed' });
    await github.rest.pulls.update({ owner, repo, pull_number: item.prNumber, state: 'open' });
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: item.prNumber,
      body:
        `**R-120 retrigger sweep** (gh-1753): this PR's head \`${item.headSha.slice(0, 12)}\` had no ` +
        `completed "${CHECK_NAME}" check recorded, so this PR was closed and reopened to fire a fresh ` +
        `evaluation. This comment does not assert a verdict — the check itself, unmodified, decides.`,
    });
    results.push({ ...item, action: 'retriggered (closed+reopened)' });
  }
  return results;
}

/** Plain-text summary table for the job summary / report. Pure function. */
export function formatReport(results, { dryRun }) {
  const lines = [
    `R-120 retrigger sweep — ${dryRun ? 'DRY RUN (no writes performed)' : 'LIVE'}`,
    '',
    'pr    classification  action                                    reason',
    '----  --------------  ----------------------------------------  ------',
  ];
  for (const r of results) {
    lines.push(
      `#${String(r.prNumber).padEnd(4)} ${r.classification.padEnd(14)}  ${r.action.padEnd(42)}  ${r.reason}`
    );
  }
  const missing = results.filter((r) => r.classification === 'MISSING').length;
  const present = results.filter((r) => r.classification === 'PRESENT').length;
  const pending = results.filter((r) => r.classification === 'PENDING').length;
  const retriggered = results.filter((r) => r.action === 'retriggered (closed+reopened)').length;
  lines.push('', `Totals: ${results.length} open PR(s) — MISSING=${missing} PRESENT=${present} PENDING=${pending} — retriggered=${retriggered}`);
  return lines.join('\n');
}
