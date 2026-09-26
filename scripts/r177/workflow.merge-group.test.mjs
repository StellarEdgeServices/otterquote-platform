// node --test scripts/r177/workflow.merge-group.test.mjs   (Node 20+, no deps)
//
// gh-1855: root cause of the "R-177 predicate tests is not safely promotable
// to a required status check" gap that CTO RUN 36 hit and reverted
// (2026-09-22, comment 5780204852 on gh-1855). The repo merges `main` through
// a GitHub merge queue: GitHub builds each queued PR on a synthetic
// `gh-readonly-queue/main/**` ref and fires the `merge_group` event for it,
// which matches neither this workflow's `pull_request` trigger nor its
// `push` trigger. `post-deploy-verify.yml` and `e2e-smoke.yml` (the two
// contexts that ARE required on `main` today) both declare
// `merge_group: { types: [checks_requested] }` for exactly this reason. This
// workflow (`.github/workflows/r177-predicate-tests.yml`) did not, which is
// why CTO RUN 36's attempt to add "R-177 predicate tests" to
// `required_status_checks.contexts` had to be reverted 20 minutes later:
// every merge-queue entry would have waited on a status that never reports,
// per GitHub's `checkResponseTimeout` (3600s), silently freezing the queue.
//
// This test reads the workflow YAML as text (no YAML parser dependency, to
// match this suite's "Node 20+, no deps" contract) and asserts the trigger
// is present with the same shape as the two workflows that already rely on
// it safely. It must FAIL on a copy of the file that lacks the trigger (the
// state gh-1855 was filed against, and the state CTO RUN 36 reverted back
// to) and PASS once the trigger is restored.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'r177-predicate-tests.yml');

function loadWorkflowOnTrigger() {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  // Isolate the top-level `on:` block: from the `on:` line up to the next
  // top-level (zero-indent) key, e.g. `permissions:` / `jobs:`.
  const lines = text.split(/\r?\n/);
  const onIndex = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.notEqual(onIndex, -1, `expected a top-level "on:" key in ${WORKFLOW_PATH}`);
  const block = [];
  for (let i = onIndex + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // next top-level key
    block.push(lines[i]);
  }
  return block.join('\n');
}

describe('r177-predicate-tests.yml — merge-queue reachability (gh-1855)', () => {
  it('declares a merge_group trigger, the same shape used by the two already-required checks', () => {
    const onBlock = loadWorkflowOnTrigger();
    assert.match(
      onBlock,
      /merge_group:\s*\n\s*types:\s*\[\s*checks_requested\s*\]/,
      'r177-predicate-tests.yml must trigger on `merge_group: { types: [checks_requested] }` ' +
        '(matching post-deploy-verify.yml and e2e-smoke.yml) or a merge-queue entry will wait ' +
        'forever on a status this job never reports, freezing the queue -- the exact failure ' +
        'CTO RUN 36 hit and reverted on 2026-09-22 (gh-1855, comment 5780204852).',
    );
  });

  it('keeps the unconditional pull_request trigger (gh-1855 root cause: a path-filtered trigger can never be a safe required check)', () => {
    const onBlock = loadWorkflowOnTrigger();
    const prLine = onBlock.split('\n').findIndex((l) => /^\s*pull_request:\s*$/.test(l));
    assert.notEqual(prLine, -1, 'expected an unconditional `pull_request:` trigger (no paths: filter)');
    const next = onBlock.split('\n')[prLine + 1] ?? '';
    assert.ok(
      !/^\s*paths:/.test(next),
      'pull_request trigger must stay unconditional -- a paths: filter here means a PR that ' +
        'does not touch the filtered paths never runs this job, leaving a required context ' +
        '"Expected" forever (the original gh-1855 incident, PR #1836).',
    );
  });
});
