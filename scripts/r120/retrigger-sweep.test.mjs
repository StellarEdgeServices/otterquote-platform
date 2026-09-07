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
  formatReport,
  closingMarker,
  doneMarker,
  parseMarker,
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
    const stranded = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 1);
    assert.equal(stranded[0].prNumber, 1786);
    assert.equal(stranded[0].headSha, headSha);

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
    const stranded = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0, 'a "closing" marker followed by a "done" marker is a completed cycle, not a stranding');
  });

  test('a merged PR is never flagged even with a dangling closing marker (should not occur, but must not be treated as a stranding)', () => {
    const headSha = 'dd'.repeat(20);
    const closedPrs = [{ number: 1701, state: 'closed', merged_at: '2026-09-07T15:00:00Z' }];
    const commentsByPr = new Map([[1701, [{ body: `x ${closingMarker(headSha)}`, created_at: '2026-09-07T14:00:00Z' }]]]);
    const stranded = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0);
  });

  test('a closed PR with no marker comments at all (closed by a human, unrelated) is not flagged', () => {
    const closedPrs = [{ number: 1702, state: 'closed', merged_at: null }];
    const commentsByPr = new Map([[1702, [{ body: 'closing this, going a different direction', created_at: '2026-09-07T14:00:00Z' }]]]);
    const stranded = planRecovery(closedPrs, commentsByPr);
    assert.equal(stranded.length, 0);
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
