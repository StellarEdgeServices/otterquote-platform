# R-120 signed review (gh-1650)

Constitution entry 6 (R-120): a human — Dustin — reads any diff that touches legal wording, consent, pricing or money before it merges. This page describes the mechanism that enforces it: the **`R-120 signed review`** required check.

## How it works

1. **Detection is content-based.** `scripts/r120/verify.mjs` → `detectR120Content(diff)` scans every **added and removed** hunk line of the PR diff (never filenames, never context lines) for:
   - currency amounts: `$5`, `10 USD`, `5 dollars`, `_CENTS =`
   - money words: price, pricing, fee(s), refund, charge(s), rebate, credit, payout, commission, discount, invoice
   - legal / consent words: license(d/ing), insured, bonded, vetted, certified, guarantee(d/s), warranty/warranties/warranted, consent, agree/agreement(s), terms, "on behalf of", "public adjuster", arbitration, disclaimer, liable/liability

   Case-insensitive. Lines that are obviously not content are skipped: import/require lines, URL-only lines, and analytics/script-tag lines (`googletagmanager`, `gtag`, `ga-gate.js` — the #1622 false positive). These paths are never scanned: `*.test.*`, `__tests__/`, `package-lock.json`, `.github/workflows/`, `scripts/r120/`, `Docs/`, `In Flight/`.

   Three **gate files** are R-120 content whatever they contain: `.github/r120-review-pubkey.jwk`, `scripts/r120/verify.mjs`, `.github/workflows/r120-signed-review.yml`.

2. **Approval is a signature, not a login.** A valid approval is a PR comment containing the line

   ```
   R-120 SIGNED: pr=<n> sha=<40-hex head sha> sig=<base64url>
   ```

   where `sig` is an ECDSA P-256 / SHA-256 signature (raw `r||s`, 64 bytes) over the UTF-8 bytes of exactly

   ```
   R-120 <owner>/<repo>#<pr> <headSha>
   ```

   The check verifies it with `.github/r120-review-pubkey.jwk` **as it exists on `main`**. `pr` must be this PR and `sha` must be the **current** head: any new commit, rebase or force-push invalidates the approval and needs a fresh read and signature. Who posted the comment is irrelevant; only the signature counts. `REVIEW: PASS`, `R-120 READ:` and GitHub "Approve" reviews are not signatures and are ignored.

3. **Verdict.** No R-120 content → check passes with summary "no R-120 content". R-120 content + valid signature for the current head → pass. R-120 content without one → **fail**, with the triggering lines (`file:line`, rule) and the exact signing instruction in the job summary and in a single sticky PR comment (marker `<!-- r120-signed-review -->`, edited in place).

## Threat model

| Threat | Why it does not work |
| --- | --- |
| Agent posts an approval. Every agent session authenticates as `dustinstohler1-dotcom`, the same login as Dustin. | Login is not consulted. The approval must be a signature under a private key that exists only in Dustin's password manager. An agent has nothing to sign with; forging P-256 is not an option. |
| PR edits the workflow, `verify.mjs` or the pubkey to pass itself. | The workflow runs on `pull_request_target`, so the definition comes from the base branch, and the job checks out **only** the default branch (sparse: `verify.mjs` + the pubkey) — PR-head code is never checked out or executed; the diff is fetched as text through the API and scanned. Touching any of the three gate files is itself R-120 content, so such a PR must be signed with the key currently on `main`. |
| Key rotation by an agent (replace the pubkey with one it controls). | Same rule: a diff that touches `.github/r120-review-pubkey.jwk` is verified against the **old** key on `main`. Only the holder of the old key can rotate. (Lost key → manual recovery by an admin editing `main` directly, outside this mechanism.) |
| Reuse a real signature on a different PR or a later commit. | The signed message binds owner/repo, PR number and head sha. A signature for an old sha or another PR fails. |
| Agent claims the current sha in the comment but pastes an old signature. | The signature is verified over the current sha, so it does not verify. |
| Agent posts `REVIEW: PASS` / `R-120 READ:` (the old gate's tokens). | Not signatures; ignored. |
| Skip the check by pushing after signing. | Pushing changes the sha and invalidates the signature; the `synchronize` event re-runs the gate. |
| Comment-triggered evaluation cannot refresh the PR check. | The `issue_comment` run evaluates, updates the sticky comment, and re-runs the head's `pull_request_target` run (`actions: write`) so the required context reflects the new verdict. Fallback: "Re-run jobs" from the Checks tab. |

Permissions are `contents: read`, `pull-requests: write`, `actions: write` only. The sign page (`scripts/r120/sign.html`) is a single offline file with a CSP that forbids all connections; the private key is never stored, never sent, and is cleared on unload.

Tests: `node --test scripts/r120/verify.test.mjs` (valid → ok; wrong sha / wrong pr / tampered sig / other key / `REVIEW: PASS` / `R-120 READ:` → fail; detection positives and negatives including the #1621 and #1622 cases).

## Dustin's one-time setup

1. Open `scripts/r120/sign.html` from a local checkout (double-click; `file://` works; no network).
2. Click **Generate keypair**. Store the **private JWK** in your password manager. Never paste it anywhere except this page.
3. Open a PR that replaces `.github/r120-review-pubkey.jwk` with the **public JWK** the page shows.
4. That PR touches a gate file, so it needs a signature under the key currently on `main`. The key committed by gh-1650 is a TEST key held by the orchestrator (private half at the orchestrator's `out/r120-test-private.jwk`, never in the repo); the orchestrator signs your rotation PR with it (`node scripts/r120/sign.mjs --key <file> --pr <n> --sha <head>`), and from merge onward only your key can approve. Delete the test private key after that merge.
5. Make **`R-120 signed review`** a required status check on `main`, then delete `.github/workflows/r120-review-gate.yml` (superseded; kept only in case its context is still required).

## Per-PR flow

1. A PR opens or gets a new commit. The check runs. If nothing in the diff is legal/consent/pricing/money, it passes ("no R-120 content") and nobody is bothered.
2. If it is R-120 content, the check fails and the sticky comment lists the exact lines and the head sha.
3. Dustin reads the diff at that sha. Then: open `sign.html`, enter PR number + head sha, paste the private JWK, **Sign**, and post the `R-120 SIGNED: …` line as a PR comment.
4. The comment re-runs the check; it passes for that sha. Any later commit resets to step 2.

Agent sessions: do not attempt to satisfy this check. If a task needs R-120 content merged, leave the PR failing with the sticky comment and hand it to Dustin's queue.
