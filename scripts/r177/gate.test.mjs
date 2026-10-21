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
import { evaluate, isFlagged, prNumberFromMergeGroupRef, mainMergeChain, STRICT_HEAD, LABEL } from './gate.mjs';

const H = 'a'.repeat(40); // PR head
const SIGNED = 'b'.repeat(40); // an earlier head the pair was signed over
const MAINTIP = 'c'.repeat(40);
const human = (body) => ({ body, user: { login: 'dustinstohler1-dotcom', type: 'User' } });
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
    assert.match(on, /issue_comment:\s*\n\s*types:\s*\[\s*created,\s*edited\s*\]/);
    assert.match(text, /checks\.create/);
    assert.match(text, /checks:\s*write/);
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
