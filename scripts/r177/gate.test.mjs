// node --test scripts/r177/gate.test.mjs   (Node 20+, no deps)
//
// gh-2965: negative controls for the R-177 pair gate. Every "must FAIL" case
// below is a way the pair was (or could be) bypassed; the "must PASS" cases show
// the gate is not simply always red. All GitHub reads are faked.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, isFlagged, isHumanComment, hasShaToken, prNumberFromMergeGroupRef, mainMergeChain, STRICT_HEAD, LABEL } from './gate.mjs';

const H = 'a'.repeat(40); // PR head
const SIGNED = 'b'.repeat(40); // an earlier head the pair was signed over
const MAINTIP = 'c'.repeat(40);
const human = (body) => ({ body, user: { login: 'dustinstohler1-dotcom', type: 'User' } });
const outsider = (body, assoc = 'NONE') => ({ body, author_association: assoc, user: { login: 'random-stranger', type: 'User' } });
const member = (body, login = 'some-member') => ({ body, author_association: 'MEMBER', user: { login, type: 'User' } });
const bot = (body) => ({ body, user: { login: 'github-actions[bot]', type: 'Bot' } });
const pair = (n, sha) => [
  human(`LEGAL-READ: PASS - implements D-1; new claims: none. Head ${sha}`),
  human(`R-177 SIGNED: pr=${n} sha=${sha} - Ben, CEO`),
];

// commits: { sha: { parents:[shas], files:[{filename,status,sha}] } }
// mainBlobs: { sha(ref): { path: blobSha } }; mainShas: refs that are on main
function fakeApi({ n = 7, labels = [LABEL], title = 'x', head = H, comments = [], commits = {}, mainBlobs = {}, mainShas = [] }) {
  return {
    getPull: async () => ({ head: { sha: head }, labels: labels.map((name) => ({ name })), title }),
    listComments: async () => comments,
    getCommit: async (sha) => ({ parents: (commits[sha]?.parents || []).map((s) => ({ sha: s })), files: commits[sha]?.files }),
    compareStatus: async (_b, sha) => (mainShas.includes(sha) ? 'behind' : 'diverged'),
    getBlobSha: async (ref, p) => mainBlobs[ref]?.[p] ?? null,
  };
}

describe('R-177 pair gate: must FAIL', () => {
  it('flagged PR with no comments at all', async () => {
    const r = await evaluate(fakeApi({}), 7);
    assert.equal(r.ok, false);
    assert.match(r.message, /missing a human LEGAL-READ: PASS and R-177 SIGNED/);
  });
  it('REVIEW only (the #2964 case)', async () => {
    const r = await evaluate(fakeApi({ comments: [human('REVIEW: PASS - looks fine')] }), 7);
    assert.equal(r.ok, false);
  });
  it('LEGAL-READ present, SIGNED missing', async () => {
    const r = await evaluate(fakeApi({ comments: [pair(7, H)[0]] }), 7);
    assert.deepEqual([r.readOk, r.signOk, r.ok], [true, false, false]);
  });
  it('SIGNED present, LEGAL-READ missing', async () => {
    const r = await evaluate(fakeApi({ comments: [pair(7, H)[1]] }), 7);
    assert.deepEqual([r.readOk, r.signOk, r.ok], [false, true, false]);
  });
  it('pair names a different (stale) sha and head is not a main-merge', async () => {
    const r = await evaluate(fakeApi({ comments: pair(7, SIGNED) }), 7);
    assert.equal(r.ok, false);
  });
  it('pair posted only by github-actions[bot] (self-issued approval)', async () => {
    const r = await evaluate(fakeApi({ comments: pair(7, H).map((c) => bot(c.body)) }), 7);
    assert.equal(r.ok, false);
  });
  it('SIGNED quoted mid-comment, not anchored at the start', async () => {
    const r = await evaluate(fakeApi({ comments: [pair(7, H)[0], human(`REVIEW: FAIL. You need: R-177 SIGNED: pr=7 sha=${H}`)] }), 7);
    assert.equal(r.signOk, false);
    assert.equal(r.ok, false);
  });
  it('SIGNED names another PR number', async () => {
    const r = await evaluate(fakeApi({ comments: [pair(7, H)[0], human(`R-177 SIGNED: pr=8 sha=${H} - Ben, CEO`)] }), 7);
    assert.equal(r.ok, false);
  });
  it('TRIAGE control: head is a main-merge that CARRIES a PR-file change (blob differs from main)', async () => {
    const api = fakeApi({
      head: H,
      comments: pair(7, SIGNED),
      commits: { [H]: { parents: [SIGNED, MAINTIP], files: [{ filename: 'pricing.html', status: 'modified', sha: 'f1' }] } },
      mainBlobs: { [MAINTIP]: { 'pricing.html': 'f2' } }, // main has a different blob: the PR side changed it
      mainShas: [MAINTIP],
    });
    const r = await evaluate(api, 7);
    assert.equal(r.ok, false);
    assert.deepEqual(r.chain, [H]);
  });
  it('merge whose second parent is NOT on main', async () => {
    const api = fakeApi({
      comments: pair(7, SIGNED),
      commits: { [H]: { parents: [SIGNED, MAINTIP], files: [] } },
      mainShas: [],
    });
    assert.equal((await evaluate(api, 7)).ok, false);
  });
  it('title-flagged PR ([R-177]) without the label still needs the pair', async () => {
    const r = await evaluate(fakeApi({ labels: [], title: '[R-177] pricing copy' }), 7);
    assert.equal(r.ok, false);
  });
  it('R-134: outsider (NONE) posting a valid pair over the head is refused', async () => {
    const r = await evaluate(fakeApi({ comments: pair(7, H).map((c) => outsider(c.body)) }), 7);
    assert.deepEqual([r.readOk, r.signOk, r.ok], [false, false, false]);
  });
  it('R-134: CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR authors are refused too', async () => {
    for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN']) {
      const r = await evaluate(fakeApi({ comments: pair(7, H).map((c) => outsider(c.body, a)) }), 7);
      assert.equal(r.ok, false, a);
    }
  });
  it('R-134: one trusted comment plus one outsider comment is not a pair', async () => {
    const r = await evaluate(fakeApi({ comments: [pair(7, H)[0], outsider(pair(7, H)[1].body)] }), 7);
    assert.deepEqual([r.readOk, r.signOk], [true, false]);
  });
  it('R-134: negation "LEGAL-READ: PASSING is NOT given for <sha>" is refused', async () => {
    const r = await evaluate(fakeApi({ comments: [human(`LEGAL-READ: PASSING is NOT given for ${H}`), pair(7, H)[1]] }), 7);
    assert.deepEqual([r.readOk, r.signOk, r.ok], [false, true, false]);
  });
  it('R-134: "LEGAL-READ: PASS" glued to a letter or digit is refused', async () => {
    for (const w of ['PASSED', 'PASS2', 'PASS_x']) {
      const r = await evaluate(fakeApi({ comments: [human(`LEGAL-READ: ${w} ${H}`), pair(7, H)[1]] }), 7);
      assert.equal(r.readOk, false, w);
    }
  });
  it('R-134: sha that is only a prefix of a longer hex run is refused (LEGAL-READ and SIGNED)', async () => {
    const longer = H + 'a'.repeat(8);
    const r1 = await evaluate(fakeApi({ comments: [human(`LEGAL-READ: PASS ${longer}`), pair(7, H)[1]] }), 7);
    assert.equal(r1.readOk, false);
    const r2 = await evaluate(fakeApi({ comments: [pair(7, H)[0], human(`R-177 SIGNED: pr=7 sha=${longer}`)] }), 7);
    assert.equal(r2.signOk, false);
    const r3 = await evaluate(fakeApi({ comments: [pair(7, H)[0], human(`R-177 SIGNED: Ben, CEO\nHead: ${longer}\n`)] }), 7);
    assert.equal(r3.signOk, false);
  });
  it('R-134: sha that is the tail of a longer hex run is refused', async () => {
    const r = await evaluate(fakeApi({ comments: [human(`LEGAL-READ: PASS 0${H}`), pair(7, H)[1]] }), 7);
    assert.equal(r.readOk, false);
  });
});

describe('R-177 pair gate: must PASS', () => {
  it('flagged PR with both comments over the head sha', async () => {
    const r = await evaluate(fakeApi({ comments: pair(7, H) }), 7);
    assert.equal(r.ok, true);
  });
  it('CEO template: "R-177 SIGNED: Ben, CEO" with an anchored Head: line', async () => {
    const r = await evaluate(fakeApi({ comments: [pair(7, H)[0], human(`R-177 SIGNED: Ben, CEO\nPR: 7\nHead: ${H}\n`)] }), 7);
    assert.equal(r.ok, true);
  });
  it('mainMergeChain (unused while STRICT_HEAD) still walks a pure main-merge', async () => {
    const api = fakeApi({
      comments: pair(7, SIGNED),
      commits: { [H]: { parents: [SIGNED, MAINTIP], files: [{ filename: 'other.js', status: 'modified', sha: 'm1' }, { filename: 'gone.js', status: 'removed', sha: 'x' }] } },
      mainBlobs: { [MAINTIP]: { 'other.js': 'm1' } },
      mainShas: [MAINTIP],
    });
    assert.deepEqual(await mainMergeChain(api, H), [H, SIGNED]);
  });
  it('STRICT_HEAD: a pure main-merge head with a pair over the OLD sha is REFUSED (#2912 decision)', async () => {
    const api = fakeApi({
      comments: pair(7, SIGNED),
      commits: { [H]: { parents: [SIGNED, MAINTIP], files: [{ filename: 'other.js', status: 'modified', sha: 'm1' }] } },
      mainBlobs: { [MAINTIP]: { 'other.js': 'm1' } },
      mainShas: [MAINTIP],
    });
    assert.equal(STRICT_HEAD, true);
    const r = await evaluate(api, 7);
    assert.equal(r.ok, false);
    assert.deepEqual(r.chain, [H]);
  });
  it('bot-authored signature over the exact head plus a human LEGAL-READ is refused', async () => {
    const r = await evaluate(fakeApi({ comments: [pair(7, H)[0], bot(pair(7, H)[1].body)] }), 7);
    assert.equal(r.signOk, false);
    assert.equal(r.ok, false);
  });
  it('R-134: a MEMBER or COLLABORATOR with another login counts; sha followed by punctuation counts', async () => {
    const r = await evaluate(fakeApi({ comments: [member(`LEGAL-READ: PASS (${H}).`, 'x1'), { ...member(`R-177 SIGNED: pr=7 sha=${H}.`), author_association: 'COLLABORATOR' }] }), 7);
    assert.equal(r.ok, true);
  });
  it('R-134: OWNER counts', () => {
    assert.equal(isHumanComment({ author_association: 'OWNER', user: { login: 'o', type: 'User' } }), true);
    assert.equal(isHumanComment({ author_association: 'NONE', user: { login: 'dustinstohler1-dotcom', type: 'User' } }), true);
    assert.equal(isHumanComment({ author_association: 'MEMBER', user: { login: 'x[bot]', type: 'User' } }), false);
    assert.equal(isHumanComment({ author_association: 'MEMBER', user: { login: 'x', type: 'Bot' } }), false);
  });
  it('hasShaToken is a whole-token match', () => {
    assert.equal(hasShaToken(`x ${H}`, H), true);
    assert.equal(hasShaToken(`${H}f`, H), false);
    assert.equal(hasShaToken(`f${H}`, H), false);
  });
  it('unflagged PR is not gated (gate reports success so the required context never blocks)', async () => {
    const r = await evaluate(fakeApi({ labels: [], title: 'fix typo' }), 7);
    assert.equal(r.ok, true);
    assert.equal(r.flagged, false);
  });
});

describe('helpers', () => {
  it('isFlagged', () => {
    assert.equal(isFlagged({ labels: [{ name: LABEL }] }), true);
    assert.equal(isFlagged({ labels: [], title: '[R-120] x' }), true);
    assert.equal(isFlagged({ labels: [{ name: 'other' }], title: 'x' }), false);
  });
  it('merge_group ref -> PR number; unparseable -> null (workflow fails closed)', () => {
    assert.equal(prNumberFromMergeGroupRef('refs/heads/gh-readonly-queue/main/pr-2964-' + 'd'.repeat(40)), 2964);
    assert.equal(prNumberFromMergeGroupRef('refs/heads/main'), null);
  });
});

describe('r177-pair-gate.yml wiring', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const text = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'r177-pair-gate.yml'), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  const block = [];
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) block.push(lines[i]);
  const on = block.join('\n');
  it('declares merge_group checks_requested (queue-safe as a required context)', () => {
    assert.match(on, /merge_group:\s*\n\s*types:\s*\[\s*checks_requested\s*\]/);
  });
  it('re-evaluates on issue_comment created/edited and posts a check run to the PR head', () => {
    assert.match(on, /issue_comment:\s*\n\s*types:\s*\[\s*created,\s*edited,\s*deleted\s*\]/);
    const run = fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8');
    assert.match(run, /checks\.create/);
    assert.match(text, /checks:\s*write/);
  });
  const code = text.replace(/^\s*#.*$/gm, '');
  it('R-134: no workflow-level permissions; checks: write only on the issue_comment job', () => {
    assert.match(code, /^permissions:\s*\{\}\s*$/m);
    assert.equal((code.match(/checks:\s*write/g) || []).length, 1);
    const [pullJob, commentJob] = code.split(/^  r177-pair-gate-comment:/m);
    assert.doesNotMatch(pullJob, /checks:\s*write/);
    assert.match(commentJob, /checks:\s*write/);
    assert.match(pullJob, /permissions:\s*\n\s+contents: read/);
  });
  it('R-134: every action is pinned by a full 40-hex commit sha', () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    assert.ok(uses.length >= 4);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
  });
  it('R-134: gate code is read from the default branch, persist-credentials off, no PR-head checkout', () => {
    const refs = [...code.matchAll(/^\s*ref:\s*(.+)$/gm)].map((m) => m[1].trim());
    assert.ok(refs.length >= 2);
    for (const r of refs) assert.equal(r, '${{ github.event.repository.default_branch }}');
    assert.equal((code.match(/persist-credentials:\s*false/g) || []).length, refs.length);
    assert.doesNotMatch(code, /github\.(event\.pull_request\.head|head_ref)|refs\/pull\//);
  });
  it('has an unconditional pull_request trigger (no paths filter) and never pull_request_target', () => {
    assert.match(on, /pull_request:/);
    assert.doesNotMatch(on, /paths:/);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /pull_request_target/);
  });
});

describe('truncated merge file list (REVIEW 6323696495 defect 1)', () => {
  // The commit endpoint returns only the first 100 files. The PR-side change hides at file 101+,
  // which the fake (like the real API) does not return. The old guard (>= 200) never tripped.
  const hundred = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.js`, status: 'modified', sha: `s${i}` }));
  const blobs = Object.fromEntries(hundred.map((f) => [f.filename, f.sha]));
  const mk = (files) => fakeApi({
    comments: pair(7, SIGNED),
    commits: { [H]: { parents: [SIGNED, MAINTIP], files } },
    mainBlobs: { [MAINTIP]: blobs },
    mainShas: [MAINTIP],
  });
  it('MUST FAIL: 100-entry (truncated) file list hides a PR-side change', async () => {
    const r = await evaluate(mk(hundred), 7);
    assert.equal(r.ok, false);
    assert.deepEqual(r.chain, [H]);
  });
  it('MUST FAIL: missing file list is unauditable', async () => {
    const r = await evaluate(mk(undefined), 7);
    assert.equal(r.ok, false);
  });
  it('a 99-file pure main-merge is still walked by mainMergeChain (strict mode ignores it)', async () => {
    const api = mk(hundred.slice(0, 99));
    assert.deepEqual(await mainMergeChain(api, H), [H, SIGNED]);
  });
});

// gh-2965 label race: the labeller's GITHUB_TOKEN label starts no workflow, so an unlabeled read must
// still catch a PR whose diff the labeller's predicate flags (live: PR #3043, gate green 14:40:44Z,
// label 14:40:41Z). These use the REAL predicate, not a stub.
import { detectLegalMoneyContent } from './predicate.mjs';
const mkDiff = (file, added) =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -10,1 +10,${added.length} @@\n${added.map((l) => '+' + l).join('\n')}\n`;
const legalDiff = mkDiff('partner-adjusters.html', ['<p>OtterQuote is not a public adjuster.</p>']);
const cleanDiff = mkDiff('docs/notes.md', ['just a note about the build']);
const withPredicate = (diffText, o) => ({ ...fakeApi(o), predicateHit: async () => detectLegalMoneyContent(diffText).hit });

describe('R-177 pair gate: label race (predicate flags before the label exists)', () => {
  it('MUST FAIL: unlabeled PR whose diff trips the predicate and has no pair', async () => {
    const r = await evaluate(withPredicate(legalDiff, { labels: [] }), 7);
    assert.equal(r.ok, false);
    assert.equal(r.flagged, true);
    assert.equal(r.predicateFlagged, true);
    assert.match(r.message, /by the legal\/money predicate/);
  });
  it('MUST FAIL: same with REVIEW-only comments (the #2964 shape, label not applied yet)', async () => {
    const r = await evaluate(withPredicate(legalDiff, { labels: [], comments: [human('REVIEW: PASS - fine')] }), 7);
    assert.equal(r.ok, false);
  });
  it('MUST PASS: unlabeled predicate-flagged PR WITH the pair over the head', async () => {
    const r = await evaluate(withPredicate(legalDiff, { labels: [], comments: pair(7, H) }), 7);
    assert.equal(r.ok, true);
  });
  it('MUST PASS: unlabeled PR whose diff the predicate does not flag', async () => {
    const r = await evaluate(withPredicate(cleanDiff, { labels: [] }), 7);
    assert.equal(r.ok, true);
    assert.equal(r.flagged, false);
  });
  it('fail closed: a predicate read that throws fails the evaluation (no silent green)', async () => {
    const api = { ...fakeApi({ labels: [] }), predicateHit: async () => { throw new Error('diff fetch failed'); } };
    await assert.rejects(() => evaluate(api, 7), /diff fetch failed/);
  });
  it('an already-labelled PR does not need the predicate call', async () => {
    let called = 0;
    const api = { ...fakeApi({}), predicateHit: async () => { called++; return false; } };
    await evaluate(api, 7);
    assert.equal(called, 0);
  });
  it('run.cjs wires the predicate from the default-branch checkout and the workflow sparse-checks it out', () => {
    const run = fs.readFileSync(new URL('./run.cjs', import.meta.url), 'utf8');
    assert.match(run, /predicate\.mjs/);
    assert.match(run, /api\.predicateHit/);
    const yml = fs.readFileSync(new URL('../../.github/workflows/r177-pair-gate.yml', import.meta.url), 'utf8');
    assert.equal((yml.match(/scripts\/r177\/predicate\.mjs/g) || []).length >= 2, true);
  });
});

// gh-2965 REVIEW 6388410977 follow-ups (Ben): newest verdict decides; too-large diff is "flagged".
import { createRequire } from 'node:module';
const run = createRequire(import.meta.url)('./run.cjs');
const prData = { head: { sha: H }, labels: [], title: 'x' };
function runWith({ diffErr, comments }) {
  let failed = null, ok = null;
  const github = {
    rest: {
      pulls: { get: async (o) => { if (o.mediaType) throw diffErr; return { data: prData }; } },
      issues: { listComments: 'lc' },
      repos: {},
      checks: {},
    },
    paginate: async () => comments,
  };
  const core = {
    setFailed: (m) => { failed = m; }, info: (m) => { ok = m; },
    summary: { addHeading() { return this; }, addRaw() { return this; }, write: async () => {} },
  };
  const context = { repo: { owner: 'o', repo: 'r' }, eventName: 'pull_request', payload: { pull_request: { number: 7 } } };
  return run({ github, context, core, postCheck: false }).then(() => ({ failed, ok }));
}
describe('R-177 pair gate: REVIEW 6388410977 follow-ups', () => {
  it('MUST PASS: diff too large (406) is treated as flagged, comments are read, pair at head turns it green', async () => {
    const r = await runWith({ diffErr: Object.assign(new Error('diff too large'), { status: 406 }), comments: pair(7, H) });
    assert.equal(r.failed, null);
    assert.match(r.ok, /both name head/);
  });
  it('MUST FAIL: diff too large with no pair stays red (flagged by default)', async () => {
    const r = await runWith({ diffErr: Object.assign(new Error('diff too large'), { status: 406 }), comments: [] });
    assert.match(r.failed, /missing a human/);
  });
  it('fail closed: any other diff API error (500) still throws', async () => {
    await assert.rejects(() => runWith({ diffErr: Object.assign(new Error('boom'), { status: 500 }), comments: pair(7, H) }), /boom/);
  });
  it('MUST FAIL: a later LEGAL-READ: FAIL at the same head cancels an earlier PASS', async () => {
    const [read, sign] = pair(7, H);
    const r = await evaluate(fakeApi({ comments: [read, sign, human(`LEGAL-READ: FAIL - new claim found. Head ${H}`)] }), 7);
    assert.equal(r.ok, false);
    assert.equal(r.readOk, false);
  });
  it('MUST FAIL: a later QUESTION FOR DUSTIN at the same head cancels an earlier PASS', async () => {
    const [read, sign] = pair(7, H);
    const r = await evaluate(fakeApi({ comments: [read, sign, human(`LEGAL-READ: QUESTION FOR DUSTIN - unclear. Head ${H}`)] }), 7);
    assert.equal(r.ok, false);
  });
  it('MUST PASS: a FAIL followed by a newer PASS at the same head is green; FAIL at another sha is ignored', async () => {
    const [read, sign] = pair(7, H);
    const r = await evaluate(fakeApi({ comments: [human(`LEGAL-READ: FAIL - x. Head ${H}`), read, sign, human(`LEGAL-READ: FAIL - old. Head ${SIGNED}`)] }), 7);
    assert.equal(r.ok, true);
  });
  it('failure message says a new comment re-runs the check', async () => {
    const r = await evaluate(fakeApi({}), 7);
    assert.match(r.message, /new comment re-runs this check/);
  });
});
