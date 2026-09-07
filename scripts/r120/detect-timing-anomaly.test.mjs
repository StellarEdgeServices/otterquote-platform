// node --test scripts/r120/detect-timing-anomaly.test.mjs   (Node 20+, no deps)
//
// Negative control (gh-1747 rail 3): a detector never observed detecting is
// decoration. This file asserts BOTH a clean pass on an ordinary signature and
// a flagged fail on a constructed violation, side by side, so CI keeps proving
// the detector still fires and not just that it stays quiet.
//
// No real key material anywhere here — every `sig=` value below is a
// same-length placeholder string matching APPROVAL_LINE_RE's character class
// (base64url), never a real ECDSA signature and never derived from one.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTimingAnomaly, AGENT_MARKER_RE, DEFAULT_WINDOW_SECONDS } from './detect-timing-anomaly.mjs';

const PLACEHOLDER_SIG = 'PLACEHOLDER-NOT-A-REAL-SIGNATURE-' + 'x'.repeat(30);
const signedLine = (pr, sha) => `R-120 SIGNED: pr=${pr} sha=${sha} sig=${PLACEHOLDER_SIG}`;

describe('DEFAULT_WINDOW_SECONDS calibration', () => {
  test('covers the actual gh-1747 incident gap with headroom', () => {
    // #1747's own body: CEO RUN 30's sentence at 2026-09-06T16:10:52Z, the
    // R-120 signature #1702 needed landed at 2026-09-06T16:12:58Z -> 126s.
    const gap = (Date.parse('2026-09-06T16:12:58Z') - Date.parse('2026-09-06T16:10:52Z')) / 1000;
    assert.equal(gap, 126);
    assert.ok(DEFAULT_WINDOW_SECONDS > gap, `window (${DEFAULT_WINDOW_SECONDS}s) must exceed the real 126s incident gap`);
  });
});

describe('AGENT_MARKER_RE', () => {
  test('matches this system\'s current attribution conventions', () => {
    for (const s of [
      '— Ben, CEO (AI executive), Stellar Edge Services',
      'CEO RUN 30, claim `ceo-2026-09-06T15:54:37Z`.',
      '[RW-CLAIM: rw-f22-20260907T125244-qxrd | 2026-09-07T13:32:00Z | tier=f22 | mode=fanout+continuous]',
      '[CTO DISPATCH — Code lane] This issue is dispatched...',
      '— Kevin, Code lane (`rw-f22-20260907T125244-qxrd`)',
    ]) {
      assert.match(s, AGENT_MARKER_RE, `expected marker in: ${s}`);
    }
  });

  test('does not match an ordinary human sentence', () => {
    assert.doesNotMatch('Looks good, merging this now.', AGENT_MARKER_RE);
  });
});

describe('detectTimingAnomaly — negative control (clean beside flagged)', () => {
  test('CLEAN: signature far in time from any agent-marked comment -> ok, nothing flagged', () => {
    const comments = [
      { id: 1, user: { login: 'dustinstohler1-dotcom' }, created_at: '2026-09-06T09:00:00Z',
        body: '— Ben, CEO (AI executive), Stellar Edge Services — routine board note, unrelated PR.' },
      { id: 2, user: { login: 'dustinstohler1-dotcom' }, created_at: '2026-09-06T16:10:52Z',
        body: signedLine(1702, 'f'.repeat(40)) },
    ];
    const result = detectTimingAnomaly(comments, { windowSeconds: 180 });
    console.log('CLEAN case ->', JSON.stringify(result, null, 2));
    assert.equal(result.ok, true);
    assert.deepEqual(result.flagged, []);
  });

  test('FLAGGED: signature lands 90s after an agent-marked comment on the same thread -> not ok, fires', () => {
    const comments = [
      { id: 10, user: { login: 'dustinstohler1-dotcom' }, created_at: '2026-09-06T16:10:52Z',
        body: 'He rules in chat. The signature and its recording on the PR are mine to carry out.\n\n— Ben, CEO (AI executive), Stellar Edge Services · CEO RUN 30' },
      { id: 11, user: { login: 'dustinstohler1-dotcom' }, created_at: '2026-09-06T16:12:22Z', // +90s
        body: signedLine(1702, 'f'.repeat(40)) },
    ];
    const result = detectTimingAnomaly(comments, { windowSeconds: 180 });
    console.log('FLAGGED case ->', JSON.stringify(result, null, 2));
    assert.equal(result.ok, false);
    assert.equal(result.flagged.length, 1);
    assert.equal(result.flagged[0].approvalCommentId, 11);
    assert.equal(result.flagged[0].nearbyCommentId, 10);
    assert.ok(result.flagged[0].deltaSeconds <= 180);
    assert.match(result.flagged[0].reason, /R-120 SIGNED comment 11 landed 90\.0s from comment 10/);
  });

  test('the real gh-1747 incident timestamps (126s gap) trip the default window', () => {
    const comments = [
      { id: 100, user: { login: 'dustinstohler1-dotcom' }, created_at: '2026-09-06T16:10:52Z',
        body: 'The signature and its recording on the PR are mine to carry out. — Ben, CEO (AI executive)' },
      { id: 101, user: { login: 'dustinstohler1-dotcom' }, created_at: '2026-09-06T16:12:58Z',
        body: signedLine(1702, 'a'.repeat(40)) },
    ];
    const result = detectTimingAnomaly(comments); // default window
    assert.equal(result.ok, false);
    assert.equal(result.flagged[0].deltaSeconds, 126);
  });

  test('a comment with no agent marker never trips it, regardless of proximity', () => {
    const comments = [
      { id: 20, user: { login: 'dustinstohler1-dotcom' }, created_at: '2026-09-06T16:10:52Z', body: 'Looks good, go ahead.' },
      { id: 21, user: { login: 'dustinstohler1-dotcom' }, created_at: '2026-09-06T16:10:55Z', body: signedLine(1702, 'b'.repeat(40)) },
    ];
    const result = detectTimingAnomaly(comments, { windowSeconds: 180 });
    assert.equal(result.ok, true);
  });

  test('an unrelated comment with no created_at is ignored, not crashed on', () => {
    const comments = [
      { id: 30, user: { login: 'x' }, body: 'no timestamp' },
      { id: 31, user: { login: 'dustinstohler1-dotcom' }, created_at: '2026-09-06T16:10:52Z', body: signedLine(1702, 'c'.repeat(40)) },
    ];
    assert.doesNotThrow(() => detectTimingAnomaly(comments));
  });
});
