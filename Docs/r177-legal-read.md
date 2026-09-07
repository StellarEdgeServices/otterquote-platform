# R-177 legal-read (supersedes the R-120 signed review)

**Constitution entry 6**, as rewritten by **R-177** on 2026-09-07: a PR whose diff touches **legal wording, consent language, pricing, or money movement** merges only after **both** of

- **(a) LEGAL-READ** — a fresh-context refuter agent that is **not the PR's author** reads the full diff against `otterquote-D-registry.md`, `otterquote-ref-legal.md` and the governing copy quoted on the issue, and posts on the PR:

  ```
  LEGAL-READ: PASS | FAIL — implements D-<n> …; new claims/prices/promises/consent text introduced: none | <list>
  ```

- **(b) R-177 SIGNED** — the **CEO** posts, over the same head sha the LEGAL-READ read:

  ```
  R-177 SIGNED: pr=<n> sha=<40-hex head sha> — Ben, CEO
  ```

**Any later commit voids both.** A new head sha needs a fresh LEGAL-READ and a fresh signature.

**Dustin is never in the loop on a diff.** This is the whole point of R-177. What R-120 asked of him — read the diff, open an offline page, paste a private key, post a signature — he had said he would not do (*"I don't review pr's… Steps that gate things on a technical review by an attorney are pure theatre"*), and the gate had blocked 16 of 20 open PRs for three days with zero genuine signatures ever posted. His ruling, verbatim: **"1. Retire and replace. 2. Notify after."**

## Who posts what

| Comment | Who | When |
| --- | --- | --- |
| `LEGAL-READ: PASS\|FAIL — …` | a fresh-context refuter agent, **not** the PR's author | after reading the full diff at the current head sha |
| `R-177 SIGNED: pr=… sha=… — Ben, CEO` | the CEO (Ben) | after a `LEGAL-READ: PASS` on that same head sha |
| the `r177:legal-read` label + one notice comment | the **R-177 legal-read needed** workflow, automatically | when the predicate fires |

A **`LEGAL-READ: FAIL`**, or any diff that introduces a legal position, price, promise or consent text **with no D-number behind it**, does not merge. It goes to **Dustin as Tier C** under constitution entry 2, with the CEO's recommendation — exactly as any new decision does. That is a *decision* reaching him, not a diff.

## What is automated, and what is not

**The predicate is a labeller. It is not a gate. It always exits 0.**

`.github/workflows/r177-legal-read.yml` — the check named **`R-177 legal-read needed`** — runs `detectLegalMoneyContent()` from `scripts/r177/predicate.mjs` over the PR diff. When it fires it:

1. adds the label **`r177:legal-read`** to the PR (creating the label on the repo if it does not exist yet), and
2. posts **one** comment — *"R-177: this diff touches legal/money text — a LEGAL-READ and a CEO R-177 SIGNED comment are required before merge (constitution entry 6)"* — only if no such comment is already on the PR, and never edits or repeats it.

It never fails a PR, and it is **not** a required status check. Even an internal error is caught and downgraded to a warning: a labeller that can brick the merge queue is the failure mode R-177 exists to remove. The `R-120 signed review` required status check was removed from `main`'s branch protection on 2026-09-07T21:04Z.

**The comment pair is enforced by the CTO's merge tooling** (`In Flight/bin/merge.py` / `pr-merge-serial-device.py`), which refuses to merge a PR whose title carries `[R-177]` or whose diff the predicate flags unless both comments exist over the **current** head sha. Until that is wired, the CEO checks by hand and says so in the ledger.

## The predicate

`scripts/r177/predicate.mjs` → `detectLegalMoneyContent(diff)` scans every **added and removed** hunk line of the PR diff — never filenames, never context lines — for:

- **currency amounts**: `$5`, `10 USD`, `5 dollars`, `_CENTS =`
- **money words**: price, pricing, fee(s), refund, charge(s), rebate, credit, payout, commission, discount, invoice
- **legal / consent words**: license(d/ing), insured, bonded, vetted, certified, guarantee(d/s), warranty/warranties/warranted, consent, agree/agreement(s), terms, "on behalf of", "public adjuster", arbitration, disclaimer, liable/liability
- **money identifiers on real code lines**: payment, payout, stripe, refund, charge, invoice, price, `fee_`/`_fee`, cents, amount, award, `accept_bid`, `live_charge`, balance, commission, rebate, credit
- **`GRANT` / `REVOKE`** in SQL — one `money-permission` hit per file, not one per row

Case-insensitive. Skipped as obviously-not-content: import/require lines, URL-only lines, analytics/script-tag lines (`googletagmanager`, `gtag`, `ga-gate.js`), and code comments (for the word rules — a currency amount on a real code line still fires).

**Scan modes** (`scanModeFor(file)`):

- `none` — `*.test.*`, `__tests__/`, `package-lock.json`, `.github/workflows/`, `scripts/r177/`, `Docs/`, `In Flight/`
- `currency-only` — harness paths `tests/`, `scripts/`, `tools/`: literal currency amounts survive, prose word rules and the identifier rule do not
- `full` — everything else, **plus** the `COPY_GUARD_FILES` carve-out: the files under `scripts/` and `tools/` that hold, quote or emit customer money/legal copy

**Predicate files** are legal/money content whatever they contain, because changing how legal copy is watched is itself a change to legal copy's protection: `scripts/r177/predicate.mjs` and `.github/workflows/r177-legal-read.yml`.

This predicate is R-120's, carried over unchanged in behaviour: the gh-1650 content rules plus the gh-1701 scope narrowing, measured before/after on all 15 then-open PRs with 16 controls.

## Tests

```
node --test scripts/r177/*.test.mjs
```

- `scripts/r177/predicate.test.mjs` — rule vocabulary: which lines fire and which must stay silent (the #1621 and #1622 cases, removed lines, comment-vs-code, predicate files).
- `scripts/r177/predicate.scope.test.mjs` — which **files** and which **lines** the rules may look at, including the **ratchet** that walks `scripts/` and `tools/` and fails, naming the file, when something carrying customer copy vocabulary is missing from `COPY_GUARD_FILES`.

Wired into CI by `.github/workflows/r177-predicate-tests.yml` (**R-177 predicate tests**), advisory, glob-based so a new control file needs no CI edit.

## Notify-after: the board section

Dustin sees legal/money text **after** it ships, never before. Every merged R-177 PR is listed on the next CEO board under

> **Legal/money text that shipped since your last board**

one line each: PR number, what changed, D-number. It is a **Tier B notify-after — never an ask**. `render-boards.py` emits the section from merged PRs carrying the comment pair since the previous board stamp (`In Flight/board-overlay.json`, `shipped_legal` block); until that is wired the CEO writes the section by hand.

The **Monday sweep** counts merged PRs in scope that carry no comment pair. Any nonzero count is that week's after-action line.

## What R-177 retired

Deleted from this repo, with the R-120 machinery they belonged to:

| Retired | Was |
| --- | --- |
| `.github/workflows/r120-signed-review.yml` | the `R-120 signed review` **required** status check |
| `.github/workflows/r120-review-gate.yml` | the superseded login-based advisory path gate |
| `.github/r120-review-pubkey.jwk` | the committed ECDSA P-256 public key |
| `scripts/r120/sign.html` | the offline signing page |
| `scripts/r120/sign.mjs` | the CLI signer |
| `verifySignedApproval`, `approvalMessage`, `APPROVAL_LINE_RE`, the base64url helpers | signature verification in `verify.mjs` |
| the `R-120 SIGNED:` comment format and its 11 tests | signature controls in `verify.test.mjs` |
| the `R-120 signed review` required check on `main` | branch protection (removed 2026-09-07T21:04Z) |

Renamed and kept: `scripts/r120/verify.mjs` → `scripts/r177/predicate.mjs` · `verify.test.mjs` → `predicate.test.mjs` · `verify.scope.test.mjs` → `predicate.scope.test.mjs` · `r120-verifier-tests.yml` → `r177-predicate-tests.yml` · `Docs/r120-signed-review.md` → this file.

Historical `R-120` mentions elsewhere in the tree — `contract-signing.html`, `react-app/app/get-started/page.tsx`, the gh-1337 migration and its pre-flight notes — record *approvals Dustin actually gave* on specific copy in August 2026. Those are facts about the past and are left as written; they are not live process.

## Why replace rather than retire outright

What R-120 protected is real: twice in the week before R-177, live copy carried a falsehood (#1625, #1719). But its mechanism confused *a decision* (Tier C — Dustin's, already covered by constitution entry 2) with *verifying an implementation of a decision* (Tier A). The second read is the same instrument this system already trusts for every closure (EXEC-PROTOCOL § 7.3 refuters): an independent, fresh-context reader told to find the defect. It costs Dustin nothing and keeps a second pair of eyes on the one class of copy that has bitten us.

## Agent sessions

Do not attempt to sign for the CEO, and do not wait for Dustin. If your PR is labelled `r177:legal-read`:

1. Ask for a **fresh-context refuter** that did not author the PR to post the `LEGAL-READ:` line at the current head sha.
2. Hand the PR to the CEO for the `R-177 SIGNED:` line.
3. If the read comes back **FAIL**, or your diff introduces a legal position, price, promise or consent text with **no D-number behind it**, stop: that is a Tier C decision. Write it up for Dustin with a recommended default. Do not merge, and do not reword your way past the predicate.
