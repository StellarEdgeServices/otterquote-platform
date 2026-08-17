# D-274 — BoldSign Production Cutover: Pre-Drafted R-097 Tier-3B Brief

**Status: DRAFT. NOT POSTED. NOT A NOTICE. The 24-hour clock has not started.**

Written per #631's code-lane assignment: "pre-draft the R-097 Tier-3B brief so cutover is one merge
away when the vendor answers." Nothing in this document authorizes any action. Its only purpose is
to let whoever posts the real R-097 notice do so by copying the **Notice text** section below,
without having to reconstruct the scope and rollback plan from scratch at that moment.

## Why this is Tier 3B

Per R-109 (tier by consequence): the change itself (an Edge Function rewrite, already built and
open as PR #797) is contained, but what it *causes* on merge is a production cutover of the
platform's only e-signature vendor — money-adjacent (commission/invoice flows key off signed
contracts) and irreversible in the sense that any envelope created under BoldSign cannot be
recreated under DocuSign after the fact. That is squarely R-097's "all but money & legal" boundary:
technical, but consequential enough to earn the 24-hour notice window rather than silent merge.

## Preconditions — NONE of these are met yet (as of 2026-08-17)

1. **BoldSign 403 diagnosis.** PR #797 documents a reproducible 403 on `document/properties` and
   `getEmbeddedSignLink` immediately after a successful `document/send`, using the same sandbox key.
   Needs BoldSign support or Dustin's dashboard access — not a code-side bug. **Open, unresolved.**
2. **Sender email/domain verification on BoldSign's side**, per #631's 2026-08-06 update — needed
   before the sandbox key will actually send anything. **Status unconfirmed as of this brief.**
3. **PR #797 review and merge.** Currently `mergeable_state: behind` main; kept current as of this
   session (see #631's other sub-task). Not merged — deliberately excluded from this session's scope
   per the lane's own "Do NOT merge #797" instruction.

This document exists so that once (1) and (2) clear and Dustin says go, step (3) plus the two
migrations below are "one merge away," per the lane's framing — not so that any of this starts now.

## Exact scope of the cutover (from PR #797's own "What's explicitly NOT in this PR" list)

1. **Merge PR #797** — `create-docusign-envelope`, `docusign-webhook` (path unchanged, logic
   rewritten), `validate-contract-template` (v3 manifest), `create-invoice` (adds
   `EF_OPERATOR_TOKEN` gate), `counter-sig-reminders` (credential pattern update),
   `check-docusign-usage` deleted from the repo.
2. **BoldSign dashboard webhook registration + secret** — manual step on BoldSign's dashboard,
   outside this repo. Not code, not automatable from here.
3. **Apply migration `sql/v112-claims-project-confirmation-signed-at.sql`** — additive, nullable
   column on `claims`. Tier 3A shape on its own (per this repo's own tiering: new nullable columns
   are autonomous), bundled into this Tier-3B window only because it ships alongside a Tier-3B
   cutover, not because the column itself is risky.
4. **Apply migration `sql/v111-retire-check-docusign-usage-cron.sql`** — `select
   cron.unschedule('check-docusign-usage')`. Must run **after** PR #797 merges (the function it
   targets is deleted in that PR) — applying it first is harmless (cron job 404s until the merge),
   but the intended order is merge-then-unschedule, not the reverse.
5. **Frontend/copy still reading "DocuSign"** — not inventoried by this brief; whoever executes the
   cutover should grep for user-facing "DocuSign" strings before or shortly after cutover so the
   product doesn't describe a vendor it no longer uses. Not blocking the technical cutover itself.

## Explicitly NOT part of this cutover (separate, sequenced work)

- **Contractor template re-tagging** (9 templates, 6 contractors) — tracked in
  `Docs/D-274-boldsign-contractor-retagging-plan.md`, its own multi-phase plan, gated on this
  cutover completing first (BoldSign has no anchor-matching fallback, so envelopes against
  un-retagged contractor templates will fail to place fields — a known, accepted, sequenced gap,
  not a blocker to shipping the EF rewrite itself for OtterQuote's own retail Scope-of-Work path,
  which bakes its own Text Tags at generation time and needs no contractor action).
- **Auto-filled/locked header fields on contractor-uploaded insurance templates** — BoldSign can
  only prefill+lock via exact pixel coordinates we don't have for arbitrary contractor PDFs; retail
  jobs are unaffected. Flagged as a known product gap in PR #797, not fixed by this cutover.

## Blast radius if this goes wrong

- **All new contract-signing envelopes** (both `create-docusign-envelope`'s two callers — contract
  path and project-confirmation path) route through BoldSign the moment PR #797 merges and the app
  redeploys. There is no dual-write or gradual rollout built into this PR — it is a hard cutover at
  the function level.
- DocuSign is already non-functional in production per the PR's own framing (incident `86e2kk5uv`,
  "DocuSign is suspended/unusable at production volume... the live `create-docusign-envelope`
  function is currently dead in production"). **This means the honest pre-cutover baseline is "no
  working e-signature at all," not "a working DocuSign path that BoldSign would replace."** The
  practical downside of cutting over with an unresolved 403 is not "breaking a working path" — it's
  "the new path may also not work," same net effect as today, with a different failure signature to
  diagnose.
- Webhook path: `docusign-webhook`'s route is unchanged (same URL), logic rewritten for BoldSign's
  HMAC/payload shape. If BoldSign's dashboard webhook isn't registered correctly (precondition 2
  above), completions will silently not persist — the same silent-failure shape #421 originally
  exposed for the OLD webhook, now on the new vendor. **Verify a real test envelope round-trips
  end-to-end (send → sign → webhook fires → `activity_log`/`claims` update) before declaring the
  cutover done, not just "the function deployed without error."**

## Rollback plan

1. **Revert PR #797's merge commit** (`git revert`, not `git reset` — preserves history on a shared
   branch). Redeploys `create-docusign-envelope`, `docusign-webhook`, `validate-contract-template`,
   `create-invoice`, `counter-sig-reminders` to their pre-cutover (DocuSign-era) code.
2. **`sql/v112` (the additive column) does NOT need rollback** — it's inert if unused; no data
   integrity concern in leaving it in place even after a revert. Rollback SQL exists
   (`sql/v112-rollback-claims-project-confirmation-signed-at.sql`) if a clean revert is preferred
   for hygiene, but it is not load-bearing.
3. **`sql/v111` (cron unschedule) rollback**, if `check-docusign-usage` needs to come back: re-run
   `select cron.schedule('check-docusign-usage', '0 12 * * *', $$...$$)` with the original command
   — but note the function it targets (`supabase/functions/check-docusign-usage/`) was deleted from
   the repo in the same PR, so reverting the merge commit restores the function code too. Order
   matters: restore the function (via the PR revert) before re-scheduling the cron job, or the job
   will just 404 again.
4. **DocuSign itself is not confirmed working** (per the "dead in production" framing above) — a
   rollback restores the DocuSign *code path*, not necessarily a *working* e-signature flow. Treat
   rollback as "stop the bleeding on BoldSign," not "restore full function," and expect e-signature
   to need further triage either way.

## Notice text (copy this verbatim when the preconditions above actually clear)

> **R-097 24-HOUR NOTICE — D-274 BoldSign Production Cutover (#631)**
>
> Posting this notice starts the 24-hour window. Absent an objection or an earlier explicit
> go-ahead from Dustin, the following ships after the window closes:
>
> 1. Merge PR #797 (BoldSign replaces DocuSign in `create-docusign-envelope`, `docusign-webhook`,
>    `validate-contract-template`, `create-invoice`, `counter-sig-reminders`; deletes
>    `check-docusign-usage`).
> 2. Apply migration `sql/v112-claims-project-confirmation-signed-at.sql` (additive, nullable).
> 3. Apply migration `sql/v111-retire-check-docusign-usage-cron.sql` (unschedules the now-dead
>    `check-docusign-usage` pg_cron job) — applied after (1), not before.
>
> Full scope, blast radius, and rollback plan: `Docs/D-274-boldsign-cutover-tier3b-brief.md`.
> Preconditions that must be true before this notice is posted for real: BoldSign 403 diagnosed and
> resolved, sender domain verified on BoldSign's side. Contractor template re-tagging is separate,
> sequenced work and does NOT gate this cutover (see `Docs/D-274-boldsign-contractor-retagging-plan.md`).

---
*Drafted by run-work Code, `rw-f22-20260817T185953Z-9c4a`, 2026-08-17, per #631's lane item 3.*
