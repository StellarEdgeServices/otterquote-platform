// node --test scripts/r120/retrigger-sweep.test.mjs   (Node 20+, no deps)
//
// Fixture-driven, modelled on scripts/r120-gate-armed-check's fixture
// approach (gh-1728) and verify.test.mjs's style. Two mandatory controls
// per gh-1753 rail 2:
//   (a) POSITIVE — a PR with no recorded check gets retriggered.
//   (b) NEGATIVE, both directions — a PR whose check already completed is
//       left alone whether that completed run was a PASS or a FAIL. A PR
//       whose check is still PENDING is also left alone (not the same as
//       "already ran", but the same "don't touch it" outcome, tested
//       separately so it is not conflated with either negative case).
//
// Also asserts, structurally, that this module never imports or calls
// anything from verify.mjs — the thing that would let it compute a verdict.
//
// FIX ROUND 1 (PR #1785 review) additions:
//   - Recoverability: a simulated crash between close and reopen is driven
//     against the REAL exported executeSweep (not a re-implementation), the
//     resulting stranded PR is fed into the REAL exported planRecovery, and
//     the REAL exported executeRecovery is shown reopening it. This is the
//     "prove the new failure handling, don't describe it" rail — a
//     recovery path never observed recovering is not a recovery path.
//   - MINOR 1 (blast radius): maxActions caps total write actions.
//   - MINOR 2 (auto-merge): a PR with auto_merge armed is refused, not
//     silently closed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPr,
  planSweep,
  executeSweep,
  planRecovery,
  executeRecovery,
  fetchAllComments,
  formatReport,
  closingMarker,
  doneMarker,
  parseMarker,
  OVERRIDE_TOKEN,
  isOverrideComment,
  CHECK_NAME,
} from './retrigger-sweep.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pr = (number, sha, state = 'open') => ({ number, state, head: { sha } });
const run = (status, conclusion, name = CHECK_NAME) => ({ name, status, conclusion });

describe('classifyPr — presence only, never a verdict', () => {
  test('no check runs at all -> MISSING', () => {
    const c = classifyPr(pr(1646, 'de352e2f5fb2' + '0'.repeat(28)), []);
    assert.equal(c.classification, 'MISSING');
    assert.equal(c.conclusion, null);
  });

  test('unrelated check runs present (other job names) -> still MISSING', () => {
    const c = classifyPr(pr(1646, 'de352e2f5fb2' + '0'.repeat(28)), [
      run('completed', 'success', 'Null-Byte & Size Sanity Check'),
      run('completed', 'success', '5-Page Revenue-Path Smoke Check'),
    ]);
    assert.equal(c.classification, 'MISSING');
  });

  test('completed FAIL for current head -> PRESENT, left alone (negative control, red)', () => {
    const c = classifyPr(pr(1664, 'a'.repeat(40)), [run('completed', 'failure')]);
    assert.equal(c.classification, 'PRESENT');
    assert.equal(c.conclusion, 'failure');
  });

  test('completed PASS for current head -> PRESENT, left alone (negative control, green)', () => {
    const c = classifyPr(pr(1702, 'b'.repeat(40)), [run('completed', 'success')]);
    assert.equal(c.classification, 'PRESENT');
    assert.equal(c.conclusion, 'success');
  });

  test('queued/in_progress, not yet completed -> PENDING, left alone', () => {
    const c = classifyPr(pr(1720, 'c'.repeat(40)), [run('in_progress', null)]);
    assert.equal(c.classification, 'PENDING');
  });
});

describe('planSweep', () => {
  test('closed PRs are excluded from the plan entirely', () => {
    const prs = [pr(1, 'a'.repeat(40), 'open'), pr(2, 'b'.repeat(40), 'closed')];
    const plan = planSweep(prs, new Map());
    assert.equal(plan.length, 1);
    assert.equal(plan[0].prNumber, 1);
  });
});

// A fake octokit client whose pulls.update can be told to throw on a
// specific transition, to simulate a runner death / transient 5xx exactly
// where BLOCKER 1 identified the unguarded window.
function fakeGithub({ headShaOverride, throwOn = null, autoMerge = null, initialState = 'open' } = {}) {
  const calls = [];
  let state = initialState;
  return {
    calls,
    getState: () => state,
    rest: {
      pulls: {
        get: async ({ pull_number }) => {
          calls.push(['pulls.get', pull_number]);
          return {
            data: {
              state,
              head: { sha: headShaOverride || 'd'.repeat(40) },
              auto_merge: autoMerge,
            },
          };
        },
        update: async ({ pull_number, state: newState }) => {
          calls.push(['pulls.update', pull_number, newState]);
          if (throwOn === newState) {
            throw new Error(`simulated failure transitioning to ${newState}`);
          }
          state = newState;
          return { data: {} };
        },
      },
      issues: {
        createComment: async ({ issue_number }) => {
          calls.push(['issues.createComment', issue_number]);
          return { data: { body: '', created_at: new Date().toISOString() } };
        },
      },
    },
  };
}

describe('executeSweep — the only write action is on MISSING, and only when live', () => {
  test('POSITIVE — MISSING + live (dryRun:false) -> closed, reopened, commented, marked done', async () => {
    const headSha = 'd'.repeat(40);
    const plan = [classifyPr(pr(1646, headSha), [])];
    const github = fakeGithub({ headShaOverride: headSha });
    const { results, actionsUsed } = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'retriggered (closed+reopened)');
    assert.equal(actionsUsed, 1);
    assert.deepEqual(github.calls, [
      ['pulls.get', 1646],
      ['issues.createComment', 1646], // closing marker, BEFORE the close call
      ['pulls.update', 1646, 'closed'],
      ['pulls.update', 1646, 'open'],
      ['issues.createComment', 1646], // done marker, after reopen
    ]);
    assert.equal(github.getState(), 'open', 'PR must end up open, not stranded closed');
  });

  test('NEGATIVE (red) — PRESENT/failure is left alone even when live -> zero write calls', async () => {
    const headSha = 'e'.repeat(40);
    const plan = [classifyPr(pr(1664, headSha), [run('completed', 'failure')])];
    const github = fakeGithub({ headShaOverride: headSha });
    const { results } = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'none');
    assert.deepEqual(github.calls, [], 'a PR whose check already ran red must not be touched');
  });

  test('NEGATIVE (green) — PRESENT/success is left alone even when live -> zero write calls', async () => {
    const headSha = 'f'.repeat(40);
    const plan = [classifyPr(pr(1702, headSha), [run('completed', 'success')])];
    const github = fakeGithub({ headShaOverride: headSha });
    const { results } = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'none');
    assert.deepEqual(github.calls, [], 'a PR whose check already ran green must not be re-triggered');
  });

  test('NEGATIVE (pending) — a check already in flight is left alone -> zero write calls', async () => {
    const headSha = '1'.repeat(40);
    const plan = [classifyPr(pr(1720, headSha), [run('in_progress', null)])];
    const github = fakeGithub({ headShaOverride: headSha });
    const { results } = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'none');
    assert.deepEqual(github.calls, []);
  });

  test('MISSING but dryRun:true -> zero write calls, plan still reports what it would do', async () => {
    const headSha = '2'.repeat(40);
    const plan = [classifyPr(pr(1608, headSha), [])];
    const github = fakeGithub({ headShaOverride: headSha });
    const { results } = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: true });

    assert.match(results[0].action, /dry-run/);
    assert.deepEqual(github.calls, []);
  });

  test('MISSING but explicitly excluded (e.g. #1646/#1668, dirty) -> zero write calls', async () => {
    const headSha = '3'.repeat(40);
    const plan = [classifyPr(pr(1646, headSha), [])];
    const github = fakeGithub({ headShaOverride: headSha });
    const { results } = await executeSweep({
      github,
      owner: 'o',
      repo: 'r',
      plan,
      dryRun: false,
      excludeNumbers: [1646],
    });

    assert.equal(results[0].action, 'skipped-excluded');
    assert.deepEqual(github.calls, []);
  });

  test('MISSING, live, but head moved since the plan was built -> re-verified and skipped, no write', async () => {
    const planHeadSha = '4'.repeat(40);
    const liveHeadSha = '5'.repeat(40); // a new commit landed between planning and acting
    const plan = [classifyPr(pr(1604, planHeadSha), [])];
    const github = fakeGithub({ headShaOverride: liveHeadSha });
    const { results } = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'skipped-head-moved-since-plan');
    assert.deepEqual(
      github.calls,
      [['pulls.get', 1604]],
      'must re-check live state before writing, but must not write once state is stale'
    );
  });

  test('MINOR 2 — auto_merge armed -> refused, zero write calls, reason explains why', async () => {
    const headSha = '6'.repeat(40);
    const plan = [classifyPr(pr(1699, headSha), [])];
    const github = fakeGithub({ headShaOverride: headSha, autoMerge: { enabled_by: { login: 'someone' } } });
    const { results } = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'skipped-auto-merge-armed');
    assert.match(results[0].reason, /auto_merge/);
    assert.deepEqual(github.calls, [['pulls.get', 1699]], 'must not close a PR with auto-merge armed');
  });

  test('MINOR 1 — maxActions caps total retriggers in one call', async () => {
    const shas = ['7'.repeat(40), '8'.repeat(40), '9'.repeat(40)];
    const plan = shas.map((sha, i) => classifyPr(pr(1700 + i, sha), []));
    // Use one shared fake client; each PR has a distinct head so pulls.get's
    // single headShaOverride would be wrong for >1 PR — build a per-PR client
    // instead by dispatching on pull_number.
    const calls = [];
    const states = new Map(plan.map((p) => [p.prNumber, 'open']));
    const github = {
      calls,
      rest: {
        pulls: {
          get: async ({ pull_number }) => {
            calls.push(['pulls.get', pull_number]);
            const item = plan.find((p) => p.prNumber === pull_number);
            return { data: { state: states.get(pull_number), head: { sha: item.headSha }, auto_merge: null } };
          },
          update: async ({ pull_number, state }) => {
            calls.push(['pulls.update', pull_number, state]);
            states.set(pull_number, state);
            return { data: {} };
          },
        },
        issues: { createComment: async ({ issue_number }) => { calls.push(['issues.createComment', issue_number]); return { data: {} }; } },
      },
    };

    const { results, actionsUsed } = await executeSweep({
      github,
      owner: 'o',
      repo: 'r',
      plan,
      dryRun: false,
      maxActions: 2,
    });

    assert.equal(actionsUsed, 2);
    const retriggeredCount = results.filter((r) => r.action === 'retriggered (closed+reopened)').length;
    const cappedCount = results.filter((r) => r.action === 'skipped-cap-reached').length;
    assert.equal(retriggeredCount, 2, 'only maxActions PRs should be retriggered');
    assert.equal(cappedCount, 1, 'the rest must be explicitly reported as capped, not silently dropped');
  });

  test('BLOCKER 1 — a crash between close and reopen does not throw out of executeSweep, and is reported for recovery', async () => {
    const headSha = 'aa'.repeat(20);
    const plan = [classifyPr(pr(1785, headSha), [])];
    // Simulate: close succeeds, the finally's own reopen attempt ALSO fails
    // (e.g. a second transient 5xx) — the worst case the review demanded.
    const github = fakeGithub({ headShaOverride: headSha, throwOn: 'open' });

    const { results } = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'error-during-retrigger (left for recovery pass on next run)');
    assert.equal(github.getState(), 'closed', 'this is the stranded state BLOCKER 1 is about — PR left closed');
    // The closing marker comment (posted BEFORE the close call) must exist —
    // that is the durable trace recovery depends on.
    assert.ok(
      github.calls.some((c) => c[0] === 'issues.createComment'),
      'a marker comment must have been posted before the close call, regardless of what failed after'
    );
  });
});

describe('BLOCKER 1 fix — recovery pass rediscovers and repairs what a crashed run stranded', () => {
  test('end-to-end: real executeSweep strands a PR closed, real planRecovery finds it, real executeRecovery reopens it', async () => {
    const headSha = 'bb'.repeat(20);
    const plan = [classifyPr(pr(1786, headSha), [])];

    // Step 1: drive the REAL executeSweep into the stranded state (reopen fails).
    const strandingGithub = fakeGithub({ headShaOverride: headSha, throwOn: 'open' });
    const sweepResult = await executeSweep({ github: strandingGithub, owner: 'o', repo: 'r', plan, dryRun: false });
    assert.equal(sweepResult.results[0].action, 'error-during-retrigger (left for recovery pass on next run)');
    assert.equal(strandingGithub.getState(), 'closed');

    // Capture the exact marker comment body the real code posted, so the
    // recovery test isn't hand-authoring a marker — it's the one production
    // code actually wrote to GitHub.
    const closingBody = `... ${closingMarker(headSha)}`;
    const parsed = parseMarker(closingBody);
    assert.deepEqual(parsed, { kind: 'closing', sha: headSha });

    // Step 2: a later dispatch's recovery scan sees this PR now closed, with
    // only the dangling "closing" marker comment (no "done" ever posted,
    // matching what really happened above).
    const closedPrs = [{ number: 1786, state: 'closed', merged_at: null }];
    const commentsByPr = new Map([
      [1786, [{ body: closingBody, created_at: '2026-09-07T14:10:00Z' }]],
    ]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 1);
    assert.equal(stranded[0].prNumber, 1786);
    assert.equal(stranded[0].headSha, headSha);
    assert.equal(overridden.length, 0);

    // Step 3: the REAL executeRecovery reopens it.
    const recoveryGithub = fakeGithub({ headShaOverride: headSha, initialState: 'closed' });
    const { results: recoveryResults, actionsUsed } = await executeRecovery({
      github: recoveryGithub,
      owner: 'o',
      repo: 'r',
      stranded,
      dryRun: false,
    });

    assert.equal(actionsUsed, 1);
    assert.equal(recoveryResults[0].action, 'recovered (reopened)');
    assert.equal(recoveryGithub.getState(), 'open', 'the PR the first run stranded closed is now open again');
    assert.deepEqual(recoveryGithub.calls, [
      ['pulls.get', 1786],
      ['pulls.update', 1786, 'open'],
      ['issues.createComment', 1786],
    ]);
  });

  test('a healthy closed+reopened PR (closing then done marker) is NOT flagged as stranded', () => {
    const headSha = 'cc'.repeat(20);
    const closedPrs = [{ number: 1700, state: 'closed', merged_at: null }]; // hypothetically re-closed by a human later, irrelevant to this check
    const commentsByPr = new Map([
      [
        1700,
        [
          { body: `x ${closingMarker(headSha)}`, created_at: '2026-09-07T14:00:00Z' },
          { body: `y ${doneMarker(headSha)}`, created_at: '2026-09-07T14:00:05Z' },
        ],
      ],
    ]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0, 'a "closing" marker followed by a "done" marker is a completed cycle, not a stranding');
    assert.equal(overridden.length, 0);
  });

  test('a merged PR is never flagged even with a dangling closing marker (should not occur, but must not be treated as a stranding)', () => {
    const headSha = 'dd'.repeat(20);
    const closedPrs = [{ number: 1701, state: 'closed', merged_at: '2026-09-07T15:00:00Z' }];
    const commentsByPr = new Map([[1701, [{ body: `x ${closingMarker(headSha)}`, created_at: '2026-09-07T14:00:00Z' }]]]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0);
    assert.equal(overridden.length, 0);
  });

  test('a closed PR with no marker comments at all (closed by a human, unrelated) is not flagged', () => {
    const closedPrs = [{ number: 1702, state: 'closed', merged_at: null }];
    const commentsByPr = new Map([[1702, [{ body: 'closing this, going a different direction', created_at: '2026-09-07T14:00:00Z' }]]]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0);
    assert.equal(overridden.length, 0);
  });

  test('executeRecovery respects dryRun -> zero write calls', async () => {
    const stranded = [{ prNumber: 1786, headSha: 'e'.repeat(40), reason: 'x' }];
    const github = fakeGithub({ initialState: 'closed' });
    const { results } = await executeRecovery({ github, owner: 'o', repo: 'r', stranded, dryRun: true });
    assert.match(results[0].action, /dry-run/);
    assert.deepEqual(github.calls, []);
  });

  test('executeRecovery respects maxActions -> extras reported as capped, not silently dropped', async () => {
    const stranded = [
      { prNumber: 1786, headSha: 'e'.repeat(40), reason: 'x' },
      { prNumber: 1787, headSha: 'f'.repeat(40), reason: 'y' },
    ];
    const calls = [];
    const github = {
      calls,
      rest: {
        pulls: {
          get: async ({ pull_number }) => { calls.push(['pulls.get', pull_number]); return { data: { state: 'closed' } }; },
          update: async ({ pull_number, state }) => { calls.push(['pulls.update', pull_number, state]); return { data: {} }; },
        },
        issues: { createComment: async ({ issue_number }) => { calls.push(['issues.createComment', issue_number]); return { data: {} }; } },
      },
    };
    const { results, actionsUsed } = await executeRecovery({ github, owner: 'o', repo: 'r', stranded, dryRun: false, maxActions: 1 });
    assert.equal(actionsUsed, 1);
    assert.equal(results.filter((r) => r.action === 'recovered (reopened)').length, 1);
    assert.equal(results.filter((r) => r.action === 'skipped-cap-reached').length, 1);
  });

  test('a PR that is no longer closed by the time recovery checks live state is skipped, not force-reopened', async () => {
    const stranded = [{ prNumber: 1786, headSha: 'e'.repeat(40), reason: 'x' }];
    // Someone already manually reopened it between the scan and the recovery pass.
    const github = fakeGithub({ initialState: 'open' });
    const { results } = await executeRecovery({ github, owner: 'o', repo: 'r', stranded, dryRun: false });
    assert.equal(results[0].action, 'skipped-no-longer-closed');
    assert.deepEqual(github.calls, [['pulls.get', 1786]]);
  });
});

// ── FIX ROUND 2 (PR #1785 review, BLOCKER): the recovery pass's comment
// fetch, API-shape coverage ────────────────────────────────────────────
//
// Everything above drives `planRecovery` with `commentsByPr` built by hand
// in memory — it never exercises the actual API-shape defect, which lived
// entirely in how `.github/workflows/r120-retrigger-sweep.yml` FETCHED
// comments before ever calling `planRecovery`. This section builds a fake
// octokit client whose `issues.listComments` behaves like the real REST
// endpoint (oldest-first, page/per_page only, no sort/direction) and whose
// `.paginate` behaves like octokit's real paginate helper (follow pages
// until a short page), then demonstrates:
//   1. the OLD single-page fetch (per_page:30, no loop — literally the code
//      that was in the workflow) missing a marker that is comment #31 of 40.
//   2. the NEW `fetchAllComments` (this fix) finding it.
//   3. `planRecovery` correctly flagging the PR as stranded only when fed
//      the complete comment set — silently missing it when fed the
//      truncated one, i.e. the exact silent failure the review demonstrated.
describe('FIX ROUND 2 — recovery-pass comment fetch, real API shape (>30 comments)', () => {
  /**
   * A fake octokit-shaped client whose issues.listComments mimics the real
   * REST endpoint: `page`/`per_page` only (no sort/direction — matches
   * GitHub's own docs, confirmed by fetch during this review round), and
   * returns comments in the FIXED oldest-first order GitHub documents.
   * `.paginate` mimics octokit's real pagination helper: call repeatedly
   * with incrementing `page`, stop once a page comes back shorter than
   * `per_page`.
   */
  function fakeGithubWithComments(allCommentsOldestFirst) {
    const listCalls = [];
    const listComments = async ({ page = 1, per_page = 30 }) => {
      listCalls.push({ page, per_page });
      const start = (page - 1) * per_page;
      return { data: allCommentsOldestFirst.slice(start, start + per_page) };
    };
    return {
      listCalls,
      rest: { issues: { listComments } },
      paginate: async (fn, params) => {
        let page = 1;
        let all = [];
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { data } = await fn({ ...params, page });
          all = all.concat(data);
          if (data.length < (params.per_page || 30)) break;
          page += 1;
        }
        return all;
      },
    };
  }

  // 40 comments, oldest (id/creation order) first — the closing marker is
  // comment #31 (i.e. the newest one at the time the PR went stranded,
  // matching how executeSweep actually posts it: immediately before close).
  function buildFortyCommentsWithMarkerAt(index, marker) {
    const comments = [];
    for (let i = 0; i < 40; i += 1) {
      comments.push({
        body: i === index ? `... ${marker} ...` : `routine bot/status comment #${i}`,
        created_at: new Date(2026, 8, 7, 0, i).toISOString(),
      });
    }
    return comments;
  }

  test('BEFORE (current-code reproduction): a single per_page:30, no-loop fetch misses a marker at position 31/40', async () => {
    const headSha = 'ff'.repeat(20);
    const marker = closingMarker(headSha);
    const allComments = buildFortyCommentsWithMarkerAt(31, marker); // 0-indexed: position 31 is the 32nd comment, well past 30
    const github = fakeGithubWithComments(allComments);

    // This IS the pre-fix workflow line, reproduced verbatim:
    //   const resp = await github.rest.issues.listComments({ owner, repo, issue_number: pr.number, per_page: 30 });
    //   commentsByPr.set(pr.number, resp.data);
    const resp = await github.rest.issues.listComments({ owner: 'o', repo: 'r', issue_number: 1785, per_page: 30 });
    const truncatedComments = resp.data;

    assert.equal(truncatedComments.length, 30, 'the old code only ever sees one 30-row page');
    assert.ok(
      !truncatedComments.some((c) => c.body.includes(marker)),
      'the marker at position 31 must NOT be present in the truncated (old-code) page'
    );

    // Feed the truncated set into the real, unmodified planRecovery — this
    // is the demonstrated failure: a genuinely stranded PR is NOT flagged.
    const closedPrs = [{ number: 1785, state: 'closed', merged_at: null }];
    const commentsByPr = new Map([[1785, truncatedComments]]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0, 'BEFORE fix: the stranded PR is silently invisible to recovery');
    assert.equal(overridden.length, 0);
  });

  test('AFTER (this fix): fetchAllComments finds the same marker regardless of position, and planRecovery flags the PR', async () => {
    const headSha = 'ff'.repeat(20);
    const marker = closingMarker(headSha);
    const allComments = buildFortyCommentsWithMarkerAt(31, marker);
    const github = fakeGithubWithComments(allComments);

    const fetched = await fetchAllComments({ github, owner: 'o', repo: 'r', issueNumber: 1785 });

    assert.equal(fetched.length, 40, 'fetchAllComments must return every comment, not one page');
    assert.ok(fetched.some((c) => c.body.includes(marker)), 'the marker at position 31 must be present');
    assert.equal(github.listCalls.length, 1, '40 comments fit in a single per_page:100 page, so exactly one call is made');
    assert.deepEqual(github.listCalls[0], { page: 1, per_page: 100 });

    const closedPrs = [{ number: 1785, state: 'closed', merged_at: null }];
    const commentsByPr = new Map([[1785, fetched]]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 1, 'AFTER fix: the same stranded PR IS flagged for recovery');
    assert.equal(stranded[0].prNumber, 1785);
    assert.equal(stranded[0].headSha, headSha);
    assert.equal(overridden.length, 0);
  });

  test('AFTER (this fix), exhaustive pagination: marker beyond 100 comments (forces a 2nd page) is still found', async () => {
    const headSha = '11'.repeat(20);
    const marker = closingMarker(headSha);
    const comments = [];
    for (let i = 0; i < 140; i += 1) {
      comments.push({
        body: i === 137 ? `... ${marker} ...` : `routine comment #${i}`,
        created_at: new Date(2026, 8, 7, 0, 0, i).toISOString(),
      });
    }
    const github = fakeGithubWithComments(comments);

    const fetched = await fetchAllComments({ github, owner: 'o', repo: 'r', issueNumber: 9999 });

    assert.equal(fetched.length, 140);
    assert.equal(github.listCalls.length, 2, 'must span exactly two 100-row pages to reach comment #137');
    assert.ok(fetched.some((c) => c.body.includes(marker)));

    const closedPrs = [{ number: 9999, state: 'closed', merged_at: null }];
    const { stranded } = planRecovery(closedPrs, new Map([[9999, fetched]]));
    assert.equal(stranded.length, 1);
    assert.equal(stranded[0].prNumber, 9999);
  });
});

// ── SECOND FINDING (PR #1785 review): human override ────────────────────
describe('human override — an explicit, honored, reported opt-out', () => {
  test('isOverrideComment matches the documented token, case-insensitively, as a substring', () => {
    assert.equal(isOverrideComment(OVERRIDE_TOKEN), true);
    assert.equal(isOverrideComment(OVERRIDE_TOKEN.toUpperCase()), true);
    assert.equal(isOverrideComment(`Leaving this closed — ${OVERRIDE_TOKEN} — see thread`), true);
    assert.equal(isOverrideComment('just a normal comment'), false);
    assert.equal(isOverrideComment(''), false);
    assert.equal(isOverrideComment(undefined), false);
  });

  test('a stranded PR with a later human override comment is reported as overridden, NOT reopened', () => {
    const headSha = '22'.repeat(20);
    const closedPrs = [{ number: 1900, state: 'closed', merged_at: null }];
    const commentsByPr = new Map([
      [
        1900,
        [
          { body: `x ${closingMarker(headSha)}`, created_at: '2026-09-07T14:00:00Z' },
          { body: `Saw this — ${OVERRIDE_TOKEN}, leaving it.`, created_at: '2026-09-07T15:00:00Z' },
        ],
      ],
    ]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0, 'an overridden PR must not also appear in the actionable stranded list');
    assert.equal(overridden.length, 1);
    assert.equal(overridden[0].prNumber, 1900);
    assert.match(overridden[0].reason, /human override/);
  });

  test('override honored end-to-end: executeRecovery is never even asked about an overridden PR', async () => {
    const headSha = '33'.repeat(20);
    const closedPrs = [{ number: 1901, state: 'closed', merged_at: null }];
    const commentsByPr = new Map([
      [
        1901,
        [
          { body: `x ${closingMarker(headSha)}`, created_at: '2026-09-07T14:00:00Z' },
          { body: OVERRIDE_TOKEN, created_at: '2026-09-07T14:05:00Z' },
        ],
      ],
    ]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0);
    assert.equal(overridden.length, 1);

    // Mirrors exactly how the workflow wires this: only `stranded` (never
    // `overridden`) is passed to executeRecovery, so an overridden PR incurs
    // zero write calls and zero API calls beyond the comment fetch already done.
    const github = fakeGithub({ initialState: 'closed' });
    const { results, actionsUsed } = await executeRecovery({ github, owner: 'o', repo: 'r', stranded, dryRun: false });
    assert.equal(results.length, 0);
    assert.equal(actionsUsed, 0);
    assert.deepEqual(github.calls, [], 'an overridden PR must generate zero API calls from the recovery executor');
  });

  test('override posted BEFORE a later re-stranding is superseded — chronologically-last signal still wins', () => {
    // Not a realistic sequence in production (an overridden PR is never
    // reopened, so it can never be re-closed by this tool either) but
    // proves the precedence rule is symmetric, not hardcoded to "override
    // always wins" regardless of order.
    const headSha = '44'.repeat(20);
    const closedPrs = [{ number: 1902, state: 'closed', merged_at: null }];
    const commentsByPr = new Map([
      [
        1902,
        [
          { body: OVERRIDE_TOKEN, created_at: '2026-09-07T13:00:00Z' },
          { body: `x ${closingMarker(headSha)}`, created_at: '2026-09-07T14:00:00Z' },
        ],
      ],
    ]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(overridden.length, 0, 'a stale override predating the current closing marker must not suppress recovery');
    assert.equal(stranded.length, 1);
    assert.equal(stranded[0].prNumber, 1902);
  });

  test('a healthy done-marker PR is unaffected by isOverrideComment (no false-positive substring collision)', () => {
    const headSha = '55'.repeat(20);
    const closedPrs = [{ number: 1903, state: 'closed', merged_at: null }];
    const commentsByPr = new Map([
      [
        1903,
        [
          { body: `x ${closingMarker(headSha)}`, created_at: '2026-09-07T14:00:00Z' },
          { body: `y ${doneMarker(headSha)}`, created_at: '2026-09-07T14:00:05Z' },
        ],
      ],
    ]);
    const { stranded, overridden } = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0);
    assert.equal(overridden.length, 0);
  });
});

describe('parseMarker', () => {
  test('round-trips closingMarker and doneMarker', () => {
    const sha = 'a1b2c3d4e5f6' + '0'.repeat(28);
    assert.deepEqual(parseMarker(`text ${closingMarker(sha)} more text`), { kind: 'closing', sha });
    assert.deepEqual(parseMarker(`text ${doneMarker(sha)}`), { kind: 'done', sha });
  });

  test('returns null for unrelated comment bodies', () => {
    assert.equal(parseMarker('just a normal comment'), null);
    assert.equal(parseMarker(''), null);
    assert.equal(parseMarker(undefined), null);
  });
});

describe('formatReport', () => {
  test('renders a totals line that adds up', () => {
    const results = [
      { prNumber: 1, classification: 'MISSING', action: 'retriggered (closed+reopened)', reason: 'x' },
      { prNumber: 2, classification: 'PRESENT', action: 'none', reason: 'y' },
      { prNumber: 3, classification: 'PENDING', action: 'none', reason: 'z' },
    ];
    const text = formatReport(results, { dryRun: false });
    assert.match(text, /MISSING=1 PRESENT=1 PENDING=1/);
    assert.match(text, /retriggered=1/);
  });

  test('includes a recovery section when recoveryResults is non-empty', () => {
    const text = formatReport([], {
      dryRun: false,
      recoveryResults: [{ prNumber: 9, action: 'recovered (reopened)', reason: 'stranded' }],
    });
    assert.match(text, /RECOVERY PASS/);
    assert.match(text, /#9/);
  });
});

describe('structural incapacity — this module cannot compute an R-120 verdict', () => {
  test('source never imports verify.mjs, sign.mjs, or the pubkey, and never emits an R-120 SIGNED line', () => {
    const src = fs.readFileSync(path.join(__dirname, 'retrigger-sweep.mjs'), 'utf8');
    assert.doesNotMatch(src, /from ['"].*verify\.mjs['"]/);
    assert.doesNotMatch(src, /from ['"].*sign\.mjs['"]/);
    assert.doesNotMatch(src, /r120-review-pubkey/);
    assert.doesNotMatch(src, /detectR120Content|verifySignedApproval/);
    assert.doesNotMatch(src, /R-120 SIGNED:/);
    assert.doesNotMatch(src, /r120-signed-review -->/); // the real gate's sticky-comment marker
    // Its only PR-state write calls are pulls.update to closed/open — never a
    // check-run creation/update call.
    assert.doesNotMatch(src, /checks\.(create|update)/);
  });
});
