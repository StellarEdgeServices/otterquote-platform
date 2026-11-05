// node --test scripts/r177/rerun.test.mjs   (Node 20+, no deps)
//
// gh-2965 (comment 6669372188): after the comment job posts a green "R-177 pair gate" check run, the
// failed `pull_request` run on the same head stays red in GitHub's rollup (the check run lands in
// another check suite and does not replace it). The comment job therefore re-runs that failed run.
// These tests fake every GitHub call. They must FAIL on a tree without rerunStaleGate / the
// `actions: write` scoping, and PASS with the fix.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const runCjs = require('./run.cjs');
const rerunStaleGate = runCjs.rerunStaleGate;
const SHA = 'a'.repeat(40);

function fake(runs, { rerunError, failedError } = {}) {
  const calls = { list: [], failedJobs: [], full: [] };
  const infos = [];
  const github = {
    rest: {
      actions: {
        listWorkflowRuns: async (p) => { calls.list.push(p); return { data: { workflow_runs: runs } }; },
        reRunWorkflowFailedJobs: async (p) => { calls.failedJobs.push(p); if (failedError) throw failedError; },
        reRunWorkflow: async (p) => { calls.full.push(p); if (rerunError) throw rerunError; },
      },
    },
  };
  const core = { info: (m) => infos.push(['info', m]), warning: (m) => infos.push(['warning', m]) };
  return { github, core, calls, infos };
}
const ctx = { owner: 'o', repo: 'r' };

describe('rerunStaleGate', () => {
  it('is exported', () => assert.equal(typeof rerunStaleGate, 'function'));

  it('re-runs the failed pull_request run on the head sha', async () => {
    const f = fake([{ id: 11, status: 'completed', conclusion: 'failure' }]);
    await rerunStaleGate({ ...f, ...ctx, headSha: SHA });
    assert.equal(f.calls.list[0].workflow_id, 'r177-pair-gate.yml');
    assert.equal(f.calls.list[0].event, 'pull_request');
    assert.equal(f.calls.list[0].head_sha, SHA);
    assert.deepEqual(f.calls.failedJobs.map((c) => c.run_id), [11]);
  });

  it('re-runs a cancelled run (a burst of comments can cancel a pending run)', async () => {
    const f = fake([{ id: 12, status: 'completed', conclusion: 'cancelled' }]);
    await rerunStaleGate({ ...f, ...ctx, headSha: SHA });
    assert.deepEqual([...f.calls.failedJobs, ...f.calls.full].map((c) => c.run_id), [12]);
  });

  it('does nothing when the latest run is already green', async () => {
    const f = fake([{ id: 13, status: 'completed', conclusion: 'success' }]);
    await rerunStaleGate({ ...f, ...ctx, headSha: SHA });
    assert.equal(f.calls.failedJobs.length + f.calls.full.length, 0);
  });

  it('does nothing while the latest run is still queued or in progress', async () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending']) {
      const f = fake([{ id: 14, status, conclusion: null }]);
      await rerunStaleGate({ ...f, ...ctx, headSha: SHA });
      assert.equal(f.calls.failedJobs.length + f.calls.full.length, 0, status);
    }
  });

  it('does nothing when there is no pull_request run on that head', async () => {
    const f = fake([]);
    await rerunStaleGate({ ...f, ...ctx, headSha: SHA });
    assert.equal(f.calls.failedJobs.length + f.calls.full.length, 0);
  });

  it('never throws: a rerun API error is a warning, not a failed comment job', async () => {
    const f = fake([{ id: 15, status: 'completed', conclusion: 'failure' }], { failedError: Object.assign(new Error('503'), { status: 503 }) });
    await rerunStaleGate({ ...f, ...ctx, headSha: SHA });
    assert.ok(f.infos.some(([k]) => k === 'warning'));
  });

  it('never throws when listing runs fails', async () => {
    const f = fake([]);
    f.github.rest.actions.listWorkflowRuns = async () => { throw new Error('boom'); };
    await rerunStaleGate({ ...f, ...ctx, headSha: SHA });
    assert.ok(f.infos.some(([k]) => k === 'warning'));
  });
});

describe('run.cjs wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8');
  it('only calls the re-run when the pair is present (res.ok) and only on the postCheck path', () => {
    const i = src.indexOf('if (postCheck)');
    assert.notEqual(i, -1);
    const block = src.slice(i);
    assert.match(block, /if \(res\.ok\)[^]*rerunStaleGate\(/);
    assert.ok(block.indexOf('checks.create') < block.indexOf('rerunStaleGate('), 'rerun must come after the check run is posted');
  });
});

describe('r177-pair-gate.yml permissions and safety', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'r177-pair-gate.yml'), 'utf8');
  const lines = text.split(/\r?\n/);
  // job name -> its lines (two-space-indented keys under top-level `jobs:`)
  const jobs = {};
  let cur = null;
  let inJobs = false;
  for (const l of lines) {
    if (/^jobs:\s*$/.test(l)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; jobs[cur] = []; continue; }
    if (cur) jobs[cur].push(l);
  }
  const body = (n) => (jobs[n] || []).join('\n');

  it('has the two jobs', () => {
    assert.ok(jobs['r177-pair-gate']);
    assert.ok(jobs['r177-pair-gate-comment']);
  });
  it('actions: write is on the comment job only', () => {
    assert.match(body('r177-pair-gate-comment'), /^\s+actions:\s*write\s*$/m);
    assert.doesNotMatch(body('r177-pair-gate').replace(/^\s*#.*$/gm, ''), /actions:\s*write/);
    assert.equal((text.replace(/^\s*#.*$/gm, '').match(/actions:\s*write/g) || []).length, 1);
  });
  it('no workflow-level permissions are granted', () => {
    assert.match(text, /^permissions: \{\}\s*$/m);
  });
  it('the comment job still has no write other than checks and actions', () => {
    const perms = body('r177-pair-gate-comment').split('\n').filter((l) => /^\s{6}[a-z-]+:\s*write\s*$/.test(l)).map((l) => l.trim());
    assert.deepEqual(perms.sort(), ['actions: write', 'checks: write']);
  });
  it('both jobs check out only the default branch, never PR code', () => {
    for (const n of ['r177-pair-gate', 'r177-pair-gate-comment']) {
      const b = body(n);
      assert.match(b, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/, n);
      assert.match(b, /persist-credentials:\s*false/, n);
      assert.doesNotMatch(b, /github\.event\.pull_request\.head|github\.head_ref|refs\/pull\//, n);
    }
  });
  it('sparse checkout stays limited to the three gate files', () => {
    for (const n of ['r177-pair-gate', 'r177-pair-gate-comment']) {
      const sp = body(n).split('\n').filter((l) => /^\s+scripts\/r177\//.test(l)).map((l) => l.trim());
      assert.deepEqual(sp, ['scripts/r177/gate.mjs', 'scripts/r177/run.cjs', 'scripts/r177/predicate.mjs'], n);
    }
  });
  it('does not use pull_request_target', () => {
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /pull_request_target/);
  });
});
