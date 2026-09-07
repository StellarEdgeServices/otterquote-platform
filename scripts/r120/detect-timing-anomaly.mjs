// scripts/r120/detect-timing-anomaly.mjs — R-120 timing-anomaly detector (gh-1747)
//
// WHAT THIS IS FOR: R-120 verifies a SIGNATURE (verify.mjs), not a PERSON. The
// signature proves possession of the private key; it does not and cannot prove
// who pressed Sign. Every agent session in this system authenticates to GitHub
// as the same shared login (dustinstohler1-dotcom) that Dustin uses, so
// `comment.user.login` carries zero attribution signal — see
// Docs/r120-signed-review.md's threat model and gh-1747. The only thing left to
// look at is TIMING and PATTERN: does an `R-120 SIGNED:` line land suspiciously
// close in time to a comment that self-identifies as an agent run?
//
// WHAT THIS IS NOT: this is not a way to prove the private key entered an agent
// session, and it is not a way to prove it didn't. It is a coarse, honestly
// partial correlation check over PUBLIC comment metadata (id, login, body,
// created_at) that never touches the private key, never touches verify.mjs's
// verification path, and never fails or blocks a merge. A hit means "look at
// this by eye" (the Monday sweep), nothing stronger.
//
// CALIBRATION: gh-1747 itself supplies the only real incident on record. CEO
// RUN 30 wrote, on #1718 at 2026-09-06T16:10:52Z, "The signature and its
// recording on the PR are mine to carry out" — and the R-120 signature that
// PR #1702 needed landed 126 seconds later, at 16:12:58Z (both from #1747's
// own body). DEFAULT_WINDOW_SECONDS = 180 is chosen so that exact gap would
// have been flagged, with headroom, rather than tuned in the abstract.
//
// -----------------------------------------------------------------------------
// WHAT THIS DETECTOR CANNOT CATCH (read this before trusting a clean result):
//
//   1. A human (Dustin) who happens to comment, in his own words, within the
//      window of his own signature — a false positive, not a false negative,
//      but it means a "flagged" result is not evidence of a violation either.
//   2. An agent session that holds the key and waits out the window before
//      posting the signature. There is no window size that defeats a patient
//      violator; widening the window only trades false positives for a bigger
//      hole, it never closes the hole.
//   3. A violation with no nearby comment at all — key material read into a
//      session and used minutes or hours later, or from a session that never
//      posts anything else on the thread. Silence looks identical to a clean
//      human signature.
//   4. AGENT_MARKER_RE is a pattern match on THIS repo's current attribution
//      conventions (CEO RUN N, "(AI executive)", `claim \`ceo-…\``,
//      `RW-CLAIM:`, "— Ben/Marty/Sloane/Kevin"). Any run that stops
//      self-identifying this way — by omission or by design — is invisible to
//      it. It is a pattern check, not a semantic one.
//   5. It reads comment timestamps and bodies only. It has no visibility into
//      whether the *private key itself* ever touched an agent session — that
//      is the thing R-120's structural design (key never committed, never in
//      Doppler, sign.html makes no network calls) is relied on to prevent.
//      This module detects a SYMPTOM pattern in the public record, not the
//      act itself, and is not a substitute for that structural guarantee.
//
// In short: a clean result here proves nothing by itself, and a flagged result
// proves nothing by itself either. It narrows what a human has to look at; it
// does not replace the human look. See gh-1747 rail 4/5 — this file is the
// enforceable partial mechanism; the sentence in verify.mjs's header and in
// Docs/r120-signed-review.md is the documentation half, and it is not itself
// enforcement.
// -----------------------------------------------------------------------------

import { APPROVAL_LINE_RE } from './verify.mjs';

export const DEFAULT_WINDOW_SECONDS = 180;

/** Comment self-identifies as an agent-executive/lane run under this system's
 *  current attribution conventions. See "WHAT THIS CANNOT CATCH" item 4 above:
 *  this is necessarily a snapshot of today's conventions, not a durable test. */
export const AGENT_MARKER_RE =
  /\(AI executive\)|CEO RUN \d+|RW-CLAIM:|CTO DISPATCH|claim `(?:ceo|cto|rw)-[^`]*`|—\s*(?:Ben|Marty|Sloane|Kevin)\b|Code lane \(`rw-/;

/**
 * @param {Array<{id?: number|string, user?: {login?: string}, body?: string, created_at?: string}>} comments
 *        Same shape GitHub's REST `issues.listComments` returns (and what
 *        r120-signed-review.yml already fetches via `github.paginate`).
 * @param {{windowSeconds?: number}} [opts]
 * @returns {{ok: boolean, flagged: Array<{approvalCommentId: *, nearbyCommentId: *, nearbyLogin: string|null, deltaSeconds: number, reason: string}>}}
 */
export function detectTimingAnomaly(comments, { windowSeconds = DEFAULT_WINDOW_SECONDS } = {}) {
  const items = (Array.isArray(comments) ? comments : [])
    .map((c) => ({
      id: c?.id ?? null,
      login: c?.user?.login ?? null,
      body: typeof c?.body === 'string' ? c.body : '',
      ts: c?.created_at ? Date.parse(c.created_at) : NaN,
    }))
    .filter((c) => Number.isFinite(c.ts));

  const approvals = items.filter((c) => c.body.split(/\r?\n/).some((line) => APPROVAL_LINE_RE.test(line.trim())));

  const flagged = [];
  for (const approval of approvals) {
    for (const other of items) {
      if (other === approval || other.id === approval.id) continue;
      if (!AGENT_MARKER_RE.test(other.body)) continue;
      const deltaSeconds = Math.abs(approval.ts - other.ts) / 1000;
      if (deltaSeconds <= windowSeconds) {
        flagged.push({
          approvalCommentId: approval.id,
          nearbyCommentId: other.id,
          nearbyLogin: other.login,
          deltaSeconds,
          reason:
            `R-120 SIGNED comment ${approval.id ?? '?'} landed ${deltaSeconds.toFixed(1)}s from ` +
            `comment ${other.id ?? '?'} (login "${other.login ?? '?'}"), which carries an agent-run ` +
            `attribution marker, on the same thread — within the ${windowSeconds}s window.`,
        });
      }
    }
  }

  return { ok: flagged.length === 0, flagged };
}

// ---------------------------------------------------------------------------
// CLI: node scripts/r120/detect-timing-anomaly.mjs --fixture <file.json> [--window 180]
// Reads a JSON array of comments (the same shape as above) and prints the
// result. This is the offline / test entry point; wiring live GitHub comments
// in is the caller's job (see .github/workflows/r120-timing-anomaly-scan.yml,
// which fetches them the same way r120-signed-review.yml already does and
// passes them straight to detectTimingAnomaly — this file never calls the
// GitHub API itself).
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const fixtureIdx = args.indexOf('--fixture');
  const windowIdx = args.indexOf('--window');
  if (fixtureIdx === -1) {
    console.error('usage: node detect-timing-anomaly.mjs --fixture <comments.json> [--window <seconds>]');
    process.exitCode = 2;
    return;
  }
  const { readFile } = await import('node:fs/promises');
  const comments = JSON.parse(await readFile(args[fixtureIdx + 1], 'utf8'));
  const windowSeconds = windowIdx !== -1 ? Number(args[windowIdx + 1]) : DEFAULT_WINDOW_SECONDS;
  const result = detectTimingAnomaly(comments, { windowSeconds });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
