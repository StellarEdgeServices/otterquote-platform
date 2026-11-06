// R-177 pair gate runner (gh-2965). Called by .github/workflows/r177-pair-gate.yml through
// actions/github-script. It is ALWAYS checked out from the DEFAULT branch (never the PR), so a PR
// cannot weaken the gate that polices it. Decision logic: ./gate.mjs. Only GITHUB_TOKEN is used.
// `postCheck` is true only for the issue_comment job (the only job holding checks: write).
const path = require('path');
const { pathToFileURL } = require('url');

// gh-2965 (comment 6669372188): the check run posted below lands in the labeller's check suite, so it
// does not replace a failed `pull_request` run of this same workflow on the head; GitHub's rollup keeps
// showing that stale red. Once the pair is present, re-run that run (it re-evaluates against the
// current comments and goes green in its own suite). Best effort: never throws, so a GitHub 5xx here
// cannot fail the comment job. A `cancelled` run counts too: both jobs share one concurrency group
// (r177-pair-gate-<pr>, cancel-in-progress false), so a burst of comments can cancel a pending run, and
// the next comment re-fires this. Runs still queued/in progress are left alone.
// Needs `actions: write`, held by the comment job only. The comment job itself checks out and runs no
// PR code, but the run it re-runs executes the PR's copy of the workflow file; hence the refusals below
// (trusted commenter only, same-repo head only, failure/cancelled/timed_out only).
async function rerunStaleGate({ github, core, owner, repo, headSha, trusted }) {
  try {
    // Refusals (review 6669589037): an outsider's comment must never cause a re-run, and a run that came
    // from a fork may be waiting on maintainer approval (`action_required`), which a re-run could bypass.
    if (trusted !== true) return;
    const { data } = await github.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: 'r177-pair-gate.yml', event: 'pull_request', head_sha: headSha, per_page: 1,
    });
    const latest = data.workflow_runs[0];
    if (!latest) return;
    if (!latest.head_repository || latest.head_repository.full_name !== `${owner}/${repo}`) return;
    if (latest.status !== 'completed') return;
    // Allowlist: anything else (success, action_required, skipped, neutral, stale, startup_failure) does nothing.
    if (latest.conclusion === 'failure') {
      await github.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: latest.id });
    } else if (latest.conclusion === 'cancelled' || latest.conclusion === 'timed_out') {
      await github.rest.actions.reRunWorkflow({ owner, repo, run_id: latest.id });
    } else {
      return;
    }
    core.info(`re-ran ${latest.conclusion} R-177 pair gate pull_request run ${latest.id} on ${headSha}`);
  } catch (e) {
    core.warning(`could not re-run the stale R-177 pair gate run on ${headSha}: ${e && e.message}`);
  }
}

module.exports = async function run({ github, context, core, postCheck }) {
  const gate = await import(pathToFileURL(path.join(__dirname, 'gate.mjs')).href);
  const { owner, repo } = context.repo;

  let prNumber;
  if (context.eventName === 'merge_group') {
    prNumber = gate.prNumberFromMergeGroupRef(context.payload.merge_group.head_ref);
    if (!prNumber) {
      core.setFailed(`cannot derive a PR number from merge_group head_ref "${context.payload.merge_group.head_ref}"; failing closed.`);
      return;
    }
  } else if (context.eventName === 'issue_comment') {
    prNumber = context.payload.issue.number;
  } else {
    prNumber = context.payload.pull_request.number;
  }

  const api = {
    getPull: async (n) => (await github.rest.pulls.get({ owner, repo, pull_number: n })).data,
    listComments: (n) => github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: n, per_page: 100 }),
    getCommit: async (sha) => (await github.rest.repos.getCommit({ owner, repo, ref: sha, per_page: 100 })).data,
    compareStatus: async (base, head) =>
      (await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}`, per_page: 1 })).data.status,
    getBlobSha: async (ref, p) => {
      try {
        const r = await github.rest.repos.getContent({ owner, repo, path: p, ref });
        return Array.isArray(r.data) ? null : r.data.sha;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
  };

  // Same predicate and diff source as the labeller (r177-legal-read.yml); read from the default branch.
  const predicate = await import(pathToFileURL(path.join(__dirname, 'predicate.mjs')).href);
  api.predicateHit = async (n) => {
    let diffResp;
    try {
      diffResp = await github.rest.pulls.get({ owner, repo, pull_number: n, mediaType: { format: 'diff' } });
    } catch (e) {
      // Diff too large to render: cannot be scanned, so treat as flagged (needs the pair) and go on
      // to read comments. Any other error rethrows (fail closed).
      if (gate.isDiffTooLarge(e)) return true;
      throw e;
    }
    const diffText = typeof diffResp.data === 'string' ? diffResp.data : String(diffResp.data);
    return predicate.detectLegalMoneyContent(diffText).hit;
  };

  const res = await gate.evaluate(api, prNumber);
  await core.summary
    .addHeading('R-177 pair gate')
    .addRaw(`\n${res.message}\n\nflagged: ${res.flagged} | LEGAL-READ: ${res.readOk} | SIGNED: ${res.signOk} | chain: ${res.chain.join(', ')}\n`)
    .write();
  if (postCheck) {
    // The job runs on the default branch, so report on the PR head (read in this same run) instead.
    await github.rest.checks.create({
      owner, repo, name: 'R-177 pair gate', head_sha: res.headSha, status: 'completed',
      conclusion: res.ok ? 'success' : 'failure',
      output: { title: res.ok ? 'R-177 pair present' : 'R-177 pair missing', summary: res.message.slice(0, 60000) },
    });
    core.info(res.message);
    if (res.ok) await rerunStaleGate({ github, core, owner, repo, headSha: res.headSha, trusted: gate.isHumanComment(context.payload.comment) });
    return;
  }
  if (res.ok) core.info(res.message); else core.setFailed(res.message);
};

module.exports.rerunStaleGate = rerunStaleGate;
