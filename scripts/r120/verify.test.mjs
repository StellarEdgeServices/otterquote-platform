// node --test scripts/r120/verify.test.mjs   (Node 20+, no deps)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignedApproval, detectR120Content, approvalMessage, classifyLine, bytesToBase64url } from './verify.mjs';
import { signApproval } from './sign.mjs';

const subtle = globalThis.crypto.subtle;
const OWNER = 'StellarEdgeServices';
const REPO = 'otterquote-platform';
const PR = 1650;
const SHA = 'a'.repeat(20) + '0123456789abcdef0123';
const OTHER_SHA = 'b'.repeat(40);

async function keypair() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { privateJwk: await subtle.exportKey('jwk', kp.privateKey), publicJwk: await subtle.exportKey('jwk', kp.publicKey) };
}

const comment = (body, login = 'dustinstohler1-dotcom', id = 1) => ({ id, body, user: { login } });

describe('verifySignedApproval', async () => {
  const { privateJwk, publicJwk } = await keypair();
  const { privateJwk: strangerPriv } = await keypair();
  const base = { owner: OWNER, repo: REPO, pr: PR, headSha: SHA, pubJwk: publicJwk };

  test('signing message is exact', () => {
    assert.equal(approvalMessage({ owner: OWNER, repo: REPO, pr: PR, headSha: SHA.toUpperCase() }), `R-120 ${OWNER}/${REPO}#${PR} ${SHA}`);
  });

  test('valid signature -> ok (even inside a longer comment, from any login)', async () => {
    const line = await signApproval({ privateJwk, owner: OWNER, repo: REPO, pr: PR, headSha: SHA });
    assert.match(line, /^R-120 SIGNED: pr=1650 sha=[0-9a-f]{40} sig=[A-Za-z0-9_-]+$/);
    const r = await verifySignedApproval({ ...base, comments: [comment('Read it all.\n\n' + line + '\n\nthanks', 'some-agent-login', 42)] });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.matched.commentId, 42);
    assert.equal(r.matched.sha, SHA);
  });

  test('signature over an old sha -> fail (new commits invalidate approval)', async () => {
    const line = await signApproval({ privateJwk, owner: OWNER, repo: REPO, pr: PR, headSha: OTHER_SHA });
    const r = await verifySignedApproval({ ...base, comments: [comment(line)] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /signed for sha=/);
  });

  test('comment claims current sha but signature was made over old sha -> fail', async () => {
    const line = (await signApproval({ privateJwk, owner: OWNER, repo: REPO, pr: PR, headSha: OTHER_SHA })).replace(`sha=${OTHER_SHA}`, `sha=${SHA}`);
    const r = await verifySignedApproval({ ...base, comments: [comment(line)] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not verify/);
  });

  test('wrong pr -> fail', async () => {
    const line = await signApproval({ privateJwk, owner: OWNER, repo: REPO, pr: PR + 1, headSha: SHA });
    const r = await verifySignedApproval({ ...base, comments: [comment(line)] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /signed for pr=1651/);
    // and a comment that lies about the pr number but was signed for another pr
    const lied = line.replace('pr=1651', 'pr=1650');
    const r2 = await verifySignedApproval({ ...base, comments: [comment(lied)] });
    assert.equal(r2.ok, false);
  });

  test('tampered sig -> fail', async () => {
    const line = await signApproval({ privateJwk, owner: OWNER, repo: REPO, pr: PR, headSha: SHA });
    const sig = line.split('sig=')[1];
    const flipped = sig.slice(0, 10) + (sig[10] === 'A' ? 'B' : 'A') + sig.slice(11);
    const r = await verifySignedApproval({ ...base, comments: [comment(line.replace(sig, flipped))] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not verify|not base64url|length/);
  });

  test('signature from a different keypair -> fail (forgery)', async () => {
    const line = await signApproval({ privateJwk: strangerPriv, owner: OWNER, repo: REPO, pr: PR, headSha: SHA });
    const r = await verifySignedApproval({ ...base, comments: [comment(line)] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not verify under the pubkey on main/);
  });

  test('wrong owner/repo in the signed message -> fail', async () => {
    const line = await signApproval({ privateJwk, owner: 'someone-else', repo: REPO, pr: PR, headSha: SHA });
    const r = await verifySignedApproval({ ...base, comments: [comment(line)] });
    assert.equal(r.ok, false);
  });

  test('REVIEW: PASS and R-120 READ: comments are not signatures -> fail', async () => {
    const r = await verifySignedApproval({ ...base, comments: [
      comment('REVIEW: PASS — looked good', 'dustinstohler1-dotcom', 1),
      comment('R-120 READ: I read this diff end to end.', 'dustinstohler1-dotcom', 2),
      comment(`R-120 SIGNED pr=${PR} sha=${SHA}`, 'dustinstohler1-dotcom', 3), // malformed: no sig
    ] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no `R-120 SIGNED:` line found/);
  });

  test('garbage sig of wrong length -> fail', async () => {
    const r = await verifySignedApproval({ ...base, comments: [comment(`R-120 SIGNED: pr=${PR} sha=${SHA} sig=${bytesToBase64url(new Uint8Array(10))}`)] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /length 10 != 64/);
  });

  test('bad public key -> fail closed', async () => {
    const line = await signApproval({ privateJwk, owner: OWNER, repo: REPO, pr: PR, headSha: SHA });
    const r = await verifySignedApproval({ ...base, pubJwk: { kty: 'RSA' }, comments: [comment(line)] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /public key unusable/);
  });

  test('empty comments -> fail', async () => {
    const r = await verifySignedApproval({ ...base, comments: [] });
    assert.equal(r.ok, false);
  });
});

function diff(file, added = [], removed = [], { oldStart = 10, newStart = 10 } = {}) {
  const body = [...removed.map((l) => '-' + l), ...added.map((l) => '+' + l)].join('\n');
  return `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -${oldStart},${removed.length + 1} +${newStart},${added.length + 1} @@\n context line\n${body}\n`;
}

describe('detectR120Content', () => {
  test('#1621-style cents constant fires', () => {
    const r = detectR120Content(diff('js/upgrade.js', ['const UPGRADE_PRICE_UNDER_CENTS = 2500;']));
    assert.equal(r.hit, true);
    assert.deepEqual(r.lines.map(({ file, line, rule, side }) => ({ file, line, rule, side })), [{ file: 'js/upgrade.js', line: 11, rule: 'currency-amount', side: '+' }]);
  });

  test('"you get $200 every time" fires', () => {
    const r = detectR120Content(diff('refer-a-friend.html', ['<p>you get $200 every time</p>']));
    assert.equal(r.hit, true);
    assert.equal(r.lines[0].rule, 'currency-amount');
  });

  test('"not a public adjuster" fires (legal wording)', () => {
    const r = detectR120Content(diff('partner-adjusters.html', ['<p>OtterQuote is not a public adjuster.</p>']));
    assert.equal(r.hit, true);
    assert.equal(r.lines[0].rule, 'legal-consent-word');
  });

  test('REMOVED lines are scanned too (deleting a disclaimer is R-120 content)', () => {
    const r = detectR120Content(diff('terms.html', [], ['<p>Binding arbitration applies.</p>']));
    assert.equal(r.hit, true);
    assert.equal(r.lines[0].side, '-');
    assert.equal(r.lines[0].line, 11);
  });

  test('money words fire: refund / fee / payout', () => {
    for (const l of ['We will refund you.', 'platform fee applies', 'payout arrives Friday', '10 USD each', 'ten dollars? no: 5 dollars']) {
      assert.ok(detectR120Content(diff('index.html', [l])).hit, l);
    }
  });

  test('does NOT fire on a ga-gate.js script tag (#1622) or gtag/GTM lines', () => {
    const r = detectR120Content(diff('index.html', [
      '<script src="/js/ga-gate.js"></script>',
      "<script async src=\"https://www.googletagmanager.com/gtag/js?id=G-XXXX\"></script>",
      "gtag('event', 'purchase', { value: 200 });",
    ]));
    assert.equal(r.hit, false, JSON.stringify(r.lines));
  });

  test('does NOT fire on import / require lines or URL-only lines', () => {
    const r = detectR120Content(diff('js/thing.js', [
      "import { price } from './pricing.js';",
      "const { invoice } = require('./invoice');",
      'https://example.com/pricing/terms',
      '',
    ]));
    assert.equal(r.hit, false, JSON.stringify(r.lines));
  });

  test('does NOT scan excluded paths', () => {
    for (const f of ['js/pricing.test.js', 'react-app/src/__tests__/fee.tsx', 'package-lock.json', '.github/workflows/foo.yml', 'scripts/r120/notes.mjs', 'Docs/pricing.md', 'In Flight/plan.md']) {
      assert.equal(detectR120Content(diff(f, ['the price is $5 and you consent'])).hit, false, f);
    }
  });

  test('filenames alone never trigger (content-based, not path-based)', () => {
    const r = detectR120Content(diff('partner-agreement.html', ['<div class="row"></div>']));
    assert.equal(r.hit, false);
  });

  test('gate files always trigger, even with innocuous content', () => {
    for (const f of ['.github/r120-review-pubkey.jwk', 'scripts/r120/verify.mjs', '.github/workflows/r120-signed-review.yml']) {
      const r = detectR120Content(diff(f, ['x']));
      assert.equal(r.hit, true, f);
      assert.equal(r.lines[0].rule, 'gate-file');
    }
  });

  test('context lines are not scanned; hunk line numbers track', () => {
    const d = `diff --git a/a.html b/a.html\n--- a/a.html\n+++ b/a.html\n@@ -1,4 +1,5 @@\n <p>price $5</p>\n old\n+new1\n+we guarantee it\n same\n`;
    const r = detectR120Content(d);
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].line, 4);
    assert.equal(r.lines[0].rule, 'legal-consent-word');
  });

  test('classifyLine is case-insensitive', () => {
    assert.equal(classifyLine('WARRANTY VOID'), 'legal-consent-word');
    assert.equal(classifyLine('Refund Policy'), 'money-word');
    assert.equal(classifyLine('hello world'), null);
  });

  test('empty diff -> no hit', () => {
    assert.deepEqual(detectR120Content(''), { hit: false, lines: [], files: [] });
  });
});
