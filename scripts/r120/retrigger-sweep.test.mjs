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

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPr, planSweep, executeSweep, formatReport, CHECK_NAME } from './retrigger-sweep.mjs';

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

describe('executeSweep — the only write action is on MISSING, and only when live', () => {
  function fakeGithub(headShaOverride) {
    const calls = [];
    return {
      calls,
      rest: {
        pulls: {
          get: async ({ pull_number }) => {
            calls.push(['pulls.get', pull_number]);
            return { data: { state: 'open', head: { sha: headShaOverride || 'd'.repeat(40) } } };
          },
          update: async ({ pull_number, state }) => {
            calls.push(['pulls.update', pull_number, state]);
            return { data: {} };
          },
        },
        issues: {
          createComment: async ({ issue_number }) => {
            calls.push(['issues.createComment', issue_number]);
            return { data: {} };
          },
        },
      },
    };
  }

  test('POSITIVE — MISSING + live (dryRun:false) -> closed, reopened, commented', async () => {
    const headSha = 'd'.repeat(40);
    const plan = [classifyPr(pr(1646, headSha), [])];
    const github = fakeGithub(headSha);
    const results = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'retriggered (closed+reopened)');
    assert.deepEqual(github.calls, [
      ['pulls.get', 1646],
      ['pulls.update', 1646, 'closed'],
      ['pulls.update', 1646, 'open'],
      ['issues.createComment', 1646],
    ]);
  });

  test('NEGATIVE (red) — PRESENT/failure is left alone even when live -> zero write calls', async () => {
    const headSha = 'e'.repeat(40);
    const plan = [classifyPr(pr(1664, headSha), [run('completed', 'failure')])];
    const github = fakeGithub(headSha);
    const results = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'none');
    assert.deepEqual(github.calls, [], 'a PR whose check already ran red must not be touched');
  });

  test('NEGATIVE (green) — PRESENT/success is left alone even when live -> zero write calls', async () => {
    const headSha = 'f'.repeat(40);
    const plan = [classifyPr(pr(1702, headSha), [run('completed', 'success')])];
    const github = fakeGithub(headSha);
    const results = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'none');
    assert.deepEqual(github.calls, [], 'a PR whose check already ran green must not be re-triggered');
  });

  test('NEGATIVE (pending) — a check already in flight is left alone -> zero write calls', async () => {
    const headSha = '1'.repeat(40);
    const plan = [classifyPr(pr(1720, headSha), [run('in_progress', null)])];
    const github = fakeGithub(headSha);
    const results = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'none');
    assert.deepEqual(github.calls, []);
  });

  test('MISSING but dryRun:true -> zero write calls, plan still reports what it would do', async () => {
    const headSha = '2'.repeat(40);
    const plan = [classifyPr(pr(1608, headSha), [])];
    const github = fakeGithub(headSha);
    const results = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: true });

    assert.match(results[0].action, /dry-run/);
    assert.deepEqual(github.calls, []);
  });

  test('MISSING but explicitly excluded (e.g. #1646/#1668, dirty) -> zero write calls', async () => {
    const headSha = '3'.repeat(40);
    const plan = [classifyPr(pr(1646, headSha), [])];
    const github = fakeGithub(headSha);
    const results = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false, excludeNumbers: [1646] });

    assert.equal(results[0].action, 'skipped-excluded');
    assert.deepEqual(github.calls, []);
  });

  test('MISSING, live, but head moved since the plan was built -> re-verified and skipped, no write', async () => {
    const planHeadSha = '4'.repeat(40);
    const liveHeadSha = '5'.repeat(40); // a new commit landed between planning and acting
    const plan = [classifyPr(pr(1604, planHeadSha), [])];
    const github = fakeGithub(liveHeadSha);
    const results = await executeSweep({ github, owner: 'o', repo: 'r', plan, dryRun: false });

    assert.equal(results[0].action, 'skipped-head-moved-since-plan');
    assert.deepEqual(github.calls, [['pulls.get', 1604]], 'must re-check live state before writing, but must not write once state is stale');
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
    // Its only PR-state write call is pulls.update to closed/open — never a
    // check-run creation/update call.
    assert.doesNotMatch(src, /checks\.(create|update)/);
  });
});
