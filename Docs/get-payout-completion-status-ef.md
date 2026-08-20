# Edge Function: `get-payout-completion-status`

**Doc date:** 2026-08-15 (GitHub #747)
**Source:** `supabase/functions/get-payout-completion-status/index.ts`
**Deployed:** created 2026-07-24 (PR #570, referral channel hardening #567) · live **v3**, ACTIVE, `verify_jwt = false` (verified 2026-08-15 via Supabase `list_edge_functions` on `yeszghaspzwwstvsrioa`)
**D-number:** D-292 (registered 2026-08-17, decision-registry backfill)

---

## Purpose

`admin-payouts.html` shows a "Job complete / In progress" badge per payout row. Deriving that badge requires the join **payout_approvals → referrals → claims.completion_date** — but `claims` and `referrals` carry **no admin RLS read policy**, so the browser's anon-key client cannot make the join. This EF performs the join server-side with the service role, behind the same admin allow-list as `approve-payout`. It is **read-only** — no writes.

This is the admin *read* surface of the D-139 payout-completion gate: the gate itself (commission released only after job completion) is enforced in the payout-execution EFs; this function only reports the completion criterion so admins can see gate state per row.

## Contract

- **Input:** `POST { payout_approval_ids: string[] }` — max 500 ids per call.
- **Output:** `{ ok: true, statuses: { [payout_approval_id]: boolean } }`
  - `true` = the linked claim has `completion_date` set.
  - `false` = no referral / no claim / `completion_date` NULL / id not found.
- **Fail-safe default:** every requested id starts `false` (incomplete/unknown), matching the fail-closed posture of the payout-release gates.

## Auth model (why `verify_jwt = false` is intentional)

- `verify_jwt = false` is **pinned in `supabase/config.toml`** (pinned 2026-07-24, #567 block) so a stray flagless `functions deploy` cannot silently flip it. This is the platform-wide ES256/HS256 gateway-mismatch pattern (Standing Position #4): gateway JWT verification is off, auth is performed **in-handler**.
- In-handler auth: user-scoped client + `auth.getUser()` on the caller's `Authorization` bearer; the caller's email must be in the `ADMIN_EMAILS` allow-list (same pattern as `approve-payout` / `reject-payout`). Non-admin or invalid JWT → 401.
- The service-role client is only created **after** the admin check passes, and is used solely for the three-table read.
- CORS is restricted to the OtterQuote origin allow-list.

Issue #747 asked whether an in-handler service-role/auth check is needed given `verify_jwt=false`: **it already exists** (the admin allow-list check above). No change required.

## Caller surfaces

- `admin-payouts.html` — the **only** caller. Verified 2026-08-15 by repo-wide grep for `get-payout-completion-status` (sole non-self reference: `admin-payouts.html`).
- **Correction to issue #747:** the issue states the EF is "called by process-payout-reminders, approve-payout, and mark-job-complete as the D-139 gate." That is not what the code shows — none of those EFs invoke this function. They enforce the D-139 gate themselves in their own flows; this EF *shares the same auth pattern* as `approve-payout` and reads the same completion criterion, but its only caller is the admin payouts page. (The same wording appears in the exec-cto-memory.md EF-table row; flagged to the Bridge for correction — memory files are Bridge-owned.)

## Why it exists (instead of RLS)

Granting admins RLS SELECT on `claims`/`referrals` would widen two high-sensitivity tables for a single badge. The service-role-behind-allow-list EF keeps the RLS surface unchanged (D-211-era lockdown posture) while exposing exactly one derived boolean per payout row. If admin RLS read policies are ever added to `claims`/`referrals`, this EF can be retired in favor of a client-side join.

## Cross-references

- GitHub #567 (referral-payout hardening — deploy + config pin), PR #570 (deploy vehicle), GitHub #747 (this doc).
- `supabase/config.toml` — `[functions.get-payout-completion-status]` pin + comment.
- Related EFs: `approve-payout`, `reject-payout` (same admin allow-list pattern), `process-payout-reminders`, `mark-job-complete` (D-139 gate enforcement points).
