# `is_test` filter inventory — queries an executive or the SES Portfolio steers by

Filed against #1961. Refuted (`In Flight/reports/cto32-review-pr1975-20260915.md`, REVIEW: FAIL, 16
defects) and rewritten this session (cto32/gh1961-is-test-inventory, claim `cto-2026-09-15T20:08:43Z`).
Every defect below was re-verified independently against the code at head `c715ee0e` and against
live data in project `yeszghaspzwwstvsrioa` — not copied from the refuter's report — before being
fixed. Where I disagree with the refuter or found something new, it is marked **[additional
finding]**. This file lists what filters and what does not; it changes no query (per #1961's scope
note — the fix lands separately).

## Default, and the tie-break when flags disagree

**Default: `is_test = false` is required for anything an executive or the SES Portfolio reads as a
real-world count.** Including fixtures must be explicit and named at the call site. A row below is
"unfiltered" when no such opt-in exists and fixtures are included by default.

**Which flag wins when two disagree, with live counts (this session, `yeszghaspzwwstvsrioa`):**

| Case | Flags that can disagree | Live disagreement | Which one governs |
|---|---|---|---|
| `auth.users` | `.test`-domain heuristic vs. `profiles.is_test` (join `profiles.id = auth.users.id`) | 46 total; 41 not-`.test`-domain; 22 `profiles.is_test=false`; 1 user has no profile row. **18 profiles are `is_test=true` with a non-`.test` email.** | **`profiles.is_test` governs.** The domain heuristic over-counts "real" users by 19. Proof: re-running #1944's shape under each filter — `documents_needed` claims whose owner disagrees returns **2** under the domain filter and **0** under `profiles.is_test` / `claims.is_test`. The domain filter fails the negative control; the flag join does not. |
| `claims` vs. its owner `profiles` row | `claims.is_test` vs. `profiles.is_test` (join `claims.user_id = profiles.id`) | **2** rows disagree (both `status=active`, `claims.is_test=true`, `profiles.is_test=false`: ids `73208937…`, `474af0fc…`) | **`claims.is_test` governs claims-table counts.** A claim is the unit being measured; use the row's own flag, not its owner's. This changes the "active: 1" figure in §A below to **1**, not higher — the 2 disagreeing rows are `is_test=true` on the claim, so they were already excluded from the `is_test=false` count. **Exception for money paths:** this default governs claims-table *counts*; when the row carries a real money event — a live charge (`live_charge_authorized_at IS NOT NULL`) or a hover order with a genuine Stripe payment intent — a claim counts as test only when **both** `claims.is_test` and `profiles.is_test` are `true`. If the two disagree, the claim is treated as real. Known disagreement under this exception: claim `73208937…` (`claims.is_test=true`, `profiles.is_test=false`, `live_charge_authorized_at` = 2026-09-05) — see §I. |
| `profiles` vs. `contractors` (#1763) | `contractors.is_test` vs. owning `profiles.is_test` (join `contractors.user_id = profiles.id`) | **0** rows disagree, live, this session | **Stale finding retired.** #1763's "7 rows disagree" is not reproducible today — either fixed or the data has moved on. #1763 should be re-verified against this count before it is treated as still open on this specific claim. |
| `referrals` vs. its `referral_agents` row | `referrals.is_test` (own column) vs. `referral_agents.is_test` (join `referral_agent_id`) | **4** rows disagree, live, this session | **`referrals.is_test` governs referrals-table counts,** same reasoning as the claims row above — the row's own flag, not its owner's. `referrals` total 20 / own-flag non-test 16; by-agent-flag non-test would read 12 instead, a 4-row difference. |

## A. Negative control — #1944 re-run (this session, `db now() = 2026-09-15T22:30:31Z`, stamp.py)

| Query | Result |
|---|---|
| `select count(*) from claims where status='documents_needed';` (unfiltered) | **3** |
| `select count(*) from claims where status='documents_needed' and is_test = false;` (filtered) | **0** |
| `select status, count(*) from claims where is_test = false group by status;` | `active: 1`, `draft: 2` |
| `select count(*) from claims;` (total, for context) | 16 |

Matches Kevin's #1944 finding exactly: 3 fixture rows, all `is_test=true`; zero real claims near
`documents_needed`. This is the closes-on's required negative control, reproduced independently.

**Caveat carried over from the refuter's report, verified:** under the `.test`-domain filter (which
the original closes-on text also allows as an alternative), the equivalent re-run returns **2**, not
0 — because 2 `documents_needed`-adjacent claims disagree between `claims.is_test` and their owner's
domain. Per the tie-break table above, `claims.is_test` is the governing flag for a claims-table
query, so the correct re-run result is 0, and the domain filter is documented here as the wrong tool
for this table, not as an equally-valid alternative.

## B. Dashboards / boards executives and the SES Portfolio actually read

| # | Surface | Source | Tables | Filters `is_test`? | Detail |
|---|---|---|---|---|---|
| 1 | Business Lines dashboard | `supabase/functions/get-business-lines-dashboard/index.ts:1335,1454,1476-1482` (also `:972-998` reads, `:1009-1015` hover_orders/leads comment) → `admin-dashboard.html:462-490` | profiles, claims, quotes, contractors, referral_agents, referrals, hover_orders, leads | **Yes, both ways** — every tile ships a raw `*_total` and a filtered `*_non_test` figure side by side. `hover_orders`/`leads` have no `is_test` column and are counted as-is, documented inline. |
| 2 | SES Portfolio artifact (`In Flight/ses-portfolio.html`) | `In Flight/bin/render-boards.py:509-536` renders `ov["portfolio"]` from `In Flight/board-overlay.json` (current file, re-checked this session: `"portfolio":` at **line 61**, the fee `"decider"` line at **line 68**, `"2 of 16 claims — both is_test"` at **line 112** — these line numbers rot every time a CEO run edits the file, since it is not version-controlled prose, not code) | none directly — **not a live query** | **No fixed query exists to audit.** Free text a CEO run typed after an ad hoc check. Recorded as: reason = "narrative field, CEO-authored per run, no code path counts it automatically." **[additional finding]** The fee figure itself is currently flagged untrusted by its own author: `board-overlay.json:68` reads *"Collected platform fees are $3.00 by the is_test flag... the flag is unreliable (#1961: a $55 live charge of 09-08 is marked is_test), so the true collected figure is unknown until reconciled."* This is the clearest instance in the whole inventory of the exact risk #1961 is about — a Portfolio money figure with no query behind it, admitted unreliable at the point it was written. |
| 3 | Admin Homeowners list + loss-sheet queue | `get-homeowner-list/index.ts:270-282,356` (raw select + queue tally, unfiltered at the query) → `admin-homeowners.html:612` (`shown = state.showTest ? all : all.filter(r => !r.is_test)`) → `renderLossView(shown, hidden)`, `lossQueueRows(shown)` (queue built from `shown`, not `all`) | claims, profiles | **Yes — corrected from the PR's "Partial."** Re-read at head: the loss-sheet queue counters (`tabCountLoss`, and the queue rendered by `renderLossView`) are computed from `lossQueueRows(shown)`, and `shown` is already the `is_test`-filtered set built two lines above in `render()`. There is no separate unfiltered tally; the same toggle that hides test rows from the main list also hides them from the queue. The PR's cited `:401-411` was the loss-sheet chip helper, not a counter render — wrong line, wrong conclusion. |
| 4 | Admin Contractors list | `admin-contractors.html:883-886`; `react-app/app/admin/contractors/page.tsx:95` (0 `is_test` hits, confirmed by grep this session) | contractors | **No** — plain `.select('*',...).order('created_at')`, no predicate, no toggle on either surface. |
| 5 | Admin Referrals / partner leaderboard | `admin-referrals.html:538-540` reads `referral_agents` with `.eq('is_test', false)` (the page's only read of that table) | referral_agents, referrals (via RPC, see row 5a) | **Yes — corrected from the PR's "Partial."** Re-read at head: `:752`, `:769`, `:846` are `.update({...}).eq('id', agentId)` — a W-9 verify, a manual-unblock and an agent-type change, all writes scoped to one row by id, not additional unfiltered reads. The page has exactly one read of `referral_agents` and it is filtered. |
| 5a | Admin Referrals — the Referrals sub-table on the same page **[additional finding, not in the refuter's 16]** | `admin-referrals.html:~560` calls `sb.rpc('admin_list_referrals')`; the RPC itself (`public.admin_list_referrals()`, checked live via `pg_get_functiondef`) is `SELECT ... FROM public.referrals r LEFT JOIN referral_agents ra ... LEFT JOIN claims c ... WHERE public.is_admin_email()` | referrals, referral_agents, claims | **No** — the RPC's own SQL has no `is_test` predicate anywhere; it returns all 20 `referrals` rows (4 of them `is_test=true`) to the admin UI, which does not filter them client-side either. This is a distinct gap from row 5: the partner list is filtered, the referral list on the same page is not. |
| 6 | Partner self-service dashboard ("Portfolio Report" tile, `partner-dashboard.html:1165-1167,1770-1905`) | referral_agents, referrals, payout_approvals | **N/A / out of scope for this class** — every query is scoped to the signed-in partner's own `id`. Not an aggregate executive metric; named only because "Portfolio Report" text-matches "SES Portfolio" — it is a different thing (per-partner report vs. row 2's CEO artifact). |

## C. Digests / admin alerts

| # | Function | Tables | Filters `is_test`? | Detail |
|---|---|---|---|---|
| 7 | `notify-admin-new-homeowner` (claim-created path) | profiles, claim record | **Yes** — `index.ts:311-330`: ORs `profiles.is_test` with `record.is_test` and an excluded-email check; skips the alert if either is true. |
| 8 | `notify-admin-new-homeowner` (signup-sweep + backfill digest) | profiles, contractors, claims | **Yes** — `:423-447`, `:608-640`: candidates filtered by `c.is_test !== true` before either alert or digest is built. |
| 9 | `notify-admin-new-contractor` | contractors | **No** — 0 `is_test` hits in the file (grep-confirmed this session). Every new contractor signup alerts the admin inbox, fixture or real. |

## D. Cron jobs — re-derived live this session

`select jobid, jobname, schedule, active, command from cron.job order by jobid;`, project
`yeszghaspzwwstvsrioa`, run this session (not copied from the PR):

**16 rows returned. 15 `active = true`. Job 20 (`send-homeowner-next-steps`) is `active = false`
right now** — the PR's text presented this job as active production behavior; at head it is
registered but disabled, which is a materially different claim and is corrected here.

| jobid | jobname | schedule | active |
|---|---|---|---|
| 3 | process-bid-expirations | `0 * * * *` | true |
| 4 | process-coi-reminders | `0 8 * * *` | true |
| 5 | process-dunning-cron | `*/30 * * * *` | true |
| 6 | check-siding-design-completion | `*/30 * * * *` | true |
| 7 | platform-health-check-cron | `*/15 * * * *` | true |
| 8 | process-payout-reminders | `0 9 * * *` | true |
| 10 | process-hover-rebate-scan | `*/30 * * * *` | true |
| 13 | send-incomplete-onboarding-reminders | `0 14 * * *` | true |
| 14 | manufacturer-cert-scrape | `0 8 * * 0` | true |
| 15 | warranty-manifest-refresh | `0 9 1 1,4,7,10 *` | true |
| 16 | home-profile-prompt-hourly | `0 * * * *` | true |
| 17 | process-auto-bids | `*/5 * * * *` | true |
| 18 | counter-sig-reminders | `*/30 * * * *` | true |
| 19 | watch-template-mapping | `20 * * * *` | true |
| 20 | send-homeowner-next-steps | `*/30 * * * *` | **false** |
| 21 | gh1932-homeowner-signup-sweep | `*/15 * * * *` | true |

**Only 3 of these 16 jobs are genuinely out of scope for this class (they never read the six named
tables): `platform-health-check-cron` (reads `platform_alerts_log`/`cron_health` only),
`manufacturer-cert-scrape`, `warranty-manifest-refresh`.** The PR had ruled out 6 jobs; 3 of those
were wrong, corrected below **(this was the PR's largest single defect by row count)**:

| Cron job | Reads (re-verified against `index.ts` at head `c715ee0e`) | Filters `is_test`? | Detail |
|---|---|---|---|
| `check-siding-design-completion` (job 6) | **claims** (`.from("claims").select(...)`, main query and the update at the end), **hover_orders** (`evaluateClaim`'s `hover_job_id` lookup and the `material_list` save) | **No** — 0 `is_test` hits anywhere in the file (grep-confirmed). **[was wrongly ruled "not touching the six tables" in the PR]** |
| `home-profile-prompt-hourly` (job 16) | **claims** (batch scan and targeted-mode select), **profiles** (`email, full_name` lookup), **auth.users** (fallback via `supabase.auth.admin.getUserById` when no profile email) | **No** — 0 `is_test` hits anywhere in the file. **[was wrongly ruled "not touching the six tables" in the PR]** |
| `watch-template-mapping` (job 19) | **contractors** (joined via `contractor_templates:contractors(company_name, email, is_test)`) | **No, explicitly and by design** — the file's own header states: *"is_test rows are NOT excluded: the row this watcher exists to catch today belongs to an is_test contractor, and the message marks them `[is_test]`."* Deliberate, documented, and correctly not a defect in itself — but it does read `contractors` and belongs in this inventory. **[was wrongly ruled "not touching the six tables" in the PR]** |
| `send-homeowner-next-steps` (job 20, **currently `active=false`**) | claims, hover_orders, profiles | **Yes — the #1944/#1570 fix**, when it runs. `dry-run.ts:130-131`: `.eq("is_test", opts.scanIsTest)`; production calls always pass `scanIsTest=false`. But this job is not currently running (see `active` column above) — record accordingly, do not describe it as live production behavior. |
| `process-auto-bids` (job 17) | claims, contractors, quotes | **No** — `index.ts:86-93`: filters `funding_type`, `job_type`, `ready_for_bids`, `roofing_bid_released_at`, `rcv_amount`; no `is_test` predicate. `contractors` query (`:107-111`) also has none. **Corrected from the PR:** `is_test` is read only at `activity_log.insert(...)` (the actual line is inside the per-contractor loop, not `:227` as the PR cited — the PR's line reference had drifted). The `quotes.insert(...)` object (11 named fields) carries **no `is_test` key at all**, so the column's schema default of `false` applies — a fixture auto-bid's quote would read as `is_test=false` everywhere downstream, polluting every quote-based steering count. |
| `process-bid-expirations` (job 3) | claims, profiles | **No** — `index.ts:726-745`; no `is_test` predicate. |
| `counter-sig-reminders` (job 18) | claims, contractors | **No** — 0 `is_test` hits in the file. |
| `process-coi-reminders` (job 4) | contractors | **No filter on the query** (`:669-676,:930-934`); `is_test` is read only to stamp the `activity_log` row it writes (`:1042`). |
| `process-payout-reminders` (job 8) | **payout_approvals is the primary table** (`:day-2 digest query`, `:catch-up query`, both `.from("payout_approvals")`); `referral_agents` is read only in JOB 3, the secondary W-9-request path (`.from("referral_agents").select("id").in("id", partnerIds).eq("payments_blocked", true)...`) | **No** — neither table's query in this file has an `is_test` predicate. **Corrected from the PR**, which listed `referral_agents` as the primary table; re-reading the file at head shows `payout_approvals` is what JOB 1 and JOB 2 read, and it is the table that carries `is_test`. |
| `process-hover-rebate-scan` (job 10) | **claims, hover_orders — and it moves money.** See the dedicated money-path section below. | **No — corrected from the PR, which had this backwards.** The PR called this "N/A (by design)" and said it "propagates is_test onto the hover_orders row it creates (`:146,177`)." Re-read at head: `hover_orders` **has no `is_test` column at all** (confirmed via `information_schema.columns`, 37 columns, none named `is_test`). Lines `:146` and `:177`-equivalent in the current file (`activity_log.insert({..., is_test: claimIsTest, ...})`, twice, both inside error-handling branches) stamp **`activity_log`**, not `hover_orders`. The scan query itself (`.from("hover_orders").select(...).eq("rebate_due", true).is("rebate_paid_at", null).not("homeowner_stripe_payment_intent_id", "is", null).limit(100)`) has **no `is_test` predicate**, and then calls `POST https://api.stripe.com/v1/refunds` for every row it finds. This is the single most severe defect in the PR: a money-moving path was marked as filtered when it is not. |
| `send-incomplete-onboarding-reminders` (job 13) | contractors | **No — corrected from the PR's "not confirmed."** `grep -c is_test supabase/functions/send-incomplete-onboarding-reminders/index.ts` → **0**, confirmed by reading the full file this session. One grep settles it; there was no need to leave this open. |

## E. Documented steering queries in exec tooling (`Claude's Memories/Skills/`)

| Source | Query / convention | Filters `is_test`? |
|---|---|---|
| `Skills/cro/SKILL.md:44,57` | "Supabase: `auth.users`, `contractors`, `referral_agents`, `referrals`, `claims`... `is_test` excluded — every run" | **Yes, by stated convention** — ad hoc query, not a code path. |
| `Skills/cro/SKILL.md:140` **[added — missing from the PR]** | "Funnel — signups... measured 2026-08-28: 5 users / 7 d, 1 / 24 h, 0 real contractors, 14 referral agents" | **Not stated.** No filter clause is written down for this recorded number. Re-measured live this session: `referral_agents` total is **15**, of which **3** are `is_test=false` — the recorded "14" already appears to mix in fixtures relative to today's non-test count, or is simply dated (recorded 08-28, re-read 09-15). Either way, the convention line at `:44` is not visibly applied to this specific recorded figure. |
| `Skills/cro/SKILL.md:143` **[added — missing from the PR]** | "Funnel — referrals... 12 `referrals` rows total (double-counted per #1302; halve until fixed)" | **Not stated.** Re-measured live: `referrals` total is **20**, of which **16** are `is_test=false` by the table's own flag (or **12** by its agent's flag — see the tie-break table above). The recorded "12" matches the agent-flag reading, not the table's own flag, and does not name which one it used. |
| `Skills/metrics-pkg/SKILL.md:104` **[added — missing from the PR]** | "Customer counts: contractors total + new this month" | **No.** No filter named. Live: `contractors` total is **13**, of which **0** are `is_test=false` — every contractor in the database right now is a fixture. Run today, this line of the monthly board package would report "13 contractors" with zero of them real, and nothing in the skill's text says so. |
| `Skills/metrics-pkg/SKILL.md:139` **[added — missing from the PR]** | "Revenue reconciliation — Stripe succeeded payments MTD vs Supabase contracts/quotes marked paid this month. Counts must match." | **No.** No filter named on the Supabase side of the reconciliation; a fixture "paid" quote would count toward the Supabase side of this comparison with nothing to exclude it. |
| `Skills/cto/SKILL.md:61` **[added — missing from the PR]** | "Revenue-path probe... contract path (...`claims.contract_signed_at` count), measurement path (`hover_orders`,...)" | **No.** No filter named. Live: `claims.contract_signed_at IS NOT NULL` count is **2**, of which **0** are `is_test=false` — both signed contracts on the platform right now are fixtures. This is the probe the CTO runs every session; run today it would report "2" with no indication both are test data. |
| `In Flight/board-overlay.json:68` **[added — missing from the PR, and the PR's own row 2 did not surface this]** | "Collected platform fees are $3.00 by the `is_test` flag... the flag is unreliable (#1961: a $55 live charge of 09-08 is marked `is_test`)... true collected figure is unknown until reconciled." | **No fixed query; explicitly self-flagged as unreliable by its own author, in place, right now.** This is the sharpest existing statement of #1961's whole premise and belongs in this inventory, not just in the CEO's private notes. |
| `In Flight/bin/render-boards.py`, `team-score.py`, `cro-ga4.py`, `cro-clarity.py` | checked directly (`grep -n ".from(\|select \|is_test\|claims\|profiles\|contractors\|referrals\|hover_orders\|auth\.users"`) | **No database queries found.** `team-score.py`'s "claims" hits are all GitHub-issue-claim files under `In Flight/claims/`, not the DB table — confirmed by reading the matched lines, a false positive on the grep. `render-boards.py` reads `In Flight/dump.json` and `board-overlay.json` only. `cro-ga4.py`/`cro-clarity.py` call GA4/Clarity APIs, not Supabase. Recorded as a confirmed negative so this class of risk doesn't need re-checking on these four scripts. |

## F. `auth.users` — full inventory (missing entirely from the PR; the closes-on names this table by name)

`auth.users` has no `is_test` column of its own. Two candidate filters exist and they disagree — see
the tie-break table at the top of this document for the live counts (46 / 41 / 22 / 1) and why
`profiles.is_test` (join on `id`) governs, not the `.test`-domain heuristic.

Live code paths that read `auth.users` / call `auth.admin.*` (grep, this session, repo at head):

| File | Call | Purpose | Filters `is_test`? |
|---|---|---|---|
| `supabase/functions/send-home-profile-prompt/index.ts:390` | `auth.admin.getUserById` | Fallback homeowner email lookup when `profiles.email` is absent | **No** — transactional, single-user-by-id lookup, not a steering count. Recorded because job 16 (this same function) is a steering-relevant cron job per §D above. |
| `supabase/functions/send-bid-confirmation/index.ts` | `auth.users` (1 hit) | Transactional email lookup | **No** — single-user, not a count. |
| `supabase/functions/resend-hover-link/index.ts` | `auth.users`/`auth.admin.getUserById` (2 hits) | Transactional resend | **No** — single-user, not a count. |
| `supabase/functions/send-homeowner-next-steps/index.ts:499` | `auth.admin.getUserById` | Fallback email lookup (same pattern as job 16) | **No** — transactional. |
| `supabase/functions/send-adjuster-email/index.ts:206` | `auth.admin.getUserById` | Fallback email lookup | **No** — transactional. |
| `supabase/functions/mark-job-complete/index.ts:114` | `auth.admin.getUserById` | Fallback email lookup | **No** — transactional. |
| `supabase/functions/mint-test-session/index.ts:138` | `auth.admin.getUserById` | Test-session tooling, not production steering | **N/A** — dev/test utility. |
| `login.html` (1 hit) | `auth.users` reference | Auth flow | **No** — not a count. |
| `public.admin_contractor_last_logins` (view, see §G) | `contractors c LEFT JOIN auth.users u ON c.user_id = u.id`, gated `WHERE auth.email() = 'dustinstohler1@gmail.com'` | Last-login times for contractors, read by an admin surface | **No** — the view carries no `is_test` predicate and returns every contractor's last login regardless of test status. |

**None of the transactional lookups above are steering counts** — they resolve one user's email to
send one email, and are recorded here only for completeness per the closes-on's explicit naming of
`auth.users`. **The one steering-relevant `auth.users` surface is the `admin_contractor_last_logins`
view**, which is unfiltered (§G).

## G. Admin pages — completeness sweep over the six tables (6 pages entirely missing from the PR)

Counted via `.from('<table>')` at head `c715ee0e`, cross-checked against a local clone of the exact
PR-head commit (not GitHub's code-search API, which returned 0 hits for known-positive queries in
this session and is not reliable for this purpose — see the Completeness Sweep appendix):

| Page | Tables read | `is_test` refs | Detail |
|---|---|---|---|
| `admin-cert-verifications.html` | contractors ×1 (`:218`) | 0 | No toggle, no filter. |
| `admin-cpa.html` | contractors ×3 (`:412,421,521`) | 0 | No toggle, no filter. |
| `admin-incomplete-profiles.html` | contractors ×1 (`:681`) | 0 | No toggle, no filter. |
| `admin-measurements.html` | contractors ×1 (`:331`, admin-role check), hover_orders ×2 (`:378,669`), claims ×2 (`:675,695`, both writes by id) | 0 | No toggle, no filter on the reads. |
| `admin-template-review.html` | contractors ×1 (`:254`) | 0 | No toggle, no filter. |
| `admin-warranty-drift.html` | contractors ×1 (`:288`, admin-role check) | 0 | No toggle, no filter. |
| `react-app/app/admin/referrals/page.tsx` **[additional finding — a second react admin surface, not named in the refuter's 16]** | referrals / referral_agents (mirrors `admin-referrals.html`) | 0 | Same class of gap as row 5a above, on the react-app surface. |

Plus the one DB-level surface with no HTML in front of it:

- **`public.admin_contractor_last_logins`** (view) — `SELECT c.id AS contractor_id, u.last_sign_in_at
  FROM contractors c LEFT JOIN auth.users u ON c.user_id = u.id WHERE auth.email() =
  'dustinstohler1@gmail.com'`. Gated to the admin account, but carries no `is_test` predicate — every
  contractor's last login is returned, fixture or real. Confirmed via a live `pg_get_functiondef`-style
  view-definition read this session.

None of these six pages or the view were in the PR at all. They join `admin-contractors.html`,
`admin-homeowners.html`, `admin-dashboard.html` and `admin-referrals.html` (already covered in §B) as
the full set of admin surfaces over the six named tables — **10 admin HTML pages plus 2 react admin
pages plus 1 view, all now enumerated.**

## H. Known schema/data gaps

- **Tables carrying `is_test` with no user-linking column:** `quotes` (linked via `claim_id`/
  `contractor_id`), `payout_approvals`, `referrals` (linked via `referral_agent_id`/`claim_id`),
  `funnel_abandonment_facts`. A filter on these excludes fixture rows fine; nothing here resolves a
  row back to "which person" without a join.
- **`hover_orders` and `leads` have no `is_test` column at all** — confirmed via
  `information_schema.columns` this session (37 columns on `hover_orders`, none named `is_test`).
  They are counted as-is everywhere that reads them.
- **#1763 status, re-verified this session:** `contractors.is_test` vs. owning `profiles.is_test`
  disagree on **0** rows right now (not 7 — see the tie-break table). This does not mean #1763 was
  wrong when filed; it means the count needs re-measuring before being cited again, and this document
  does that. **A different, previously-unrecorded disagreement was found in this session:** `claims`
  vs. owner `profiles` disagree on 2 rows, and `referrals` vs. owner `referral_agents` disagree on 4
  rows (both in the tie-break table above). These are new findings, not #1763 restated.

## I. Money-path blast radius — `process-hover-rebate-scan` (read-only, this session)

Per #1961's framing ("a metric that silently counts fixtures as customers is worse than having no
metric"), the same risk applies with more force to a path that spends real money. Measured read-only
against `yeszghaspzwwstvsrioa` this session; no writes, no Stripe calls made by this session.

- **`hover_orders` total: 3.** By `claims.is_test` alone, 2 (`716e0bab…`, `3b4622fb…`) sit on claim `73208937…` and 1 (`c9096712…`) on claim `5c16cc1e…`. **Corrected under the money-path exception in the tie-break table above:** claim `73208937…` has `profiles.is_test=false` and `live_charge_authorized_at` set (2026-09-05 19:26Z), so it fails the both-flags-true test and is real, not test — both of its hover orders, including the $55 order (`3b4622fb…`, real payment intent `pi_3UDD9…`, created 2026-09-08), are governed as real for money-path purposes. **0 of the 3 hover orders belong to a claim that is test under both flags; all 3 are real.**
- **`hover_orders.rebate_stripe_id` is NULL on all 3 rows, and `rebate_paid_at` is NULL on all 3
  rows.** No rebate has ever been marked paid on any hover order, test or real, as of this session.
- **`activity_log` (1,055 rows total) has 0 rows with `event_type` matching `%rebate%` or
  `%refund%`.** The function's own code writes `hover_rebate_failed` / `hover_rebate_db_update_failed`
  activity_log rows only on a Stripe error or a post-refund DB-update failure — the absence of any
  such row is consistent with the scan never having attempted a refund that reached those branches
  (either it never ran against a qualifying row, or every attempt succeeded silently with no logged
  failure — the code has no success-path activity_log write to distinguish these).
- **Reading the one qualifying real row directly:** `hover_orders` id `c9096712…` (claim `5c16cc1e…`,
  `is_test=false`) has `rebate_due=true`, `rebate_paid_at=NULL`, `rebate_stripe_id=NULL`, and a real
  `homeowner_stripe_payment_intent_id`. Despite matching the scan's own query predicate, this row is not actually refundable by the scan right now because its claim's `completion_date` is `NULL`, and `rebateOne` returns early with "Job not marked complete" before ever calling Stripe (`process-hover-rebate/index.ts:102-110`) — real, not a fixture, and currently un-refundable for a reason unrelated to `is_test`.
- **Has the scan ever issued a refund for an `is_test` claim's hover order?** No evidence of it having
  issued *any* refund at all, test or real — no `rebate_stripe_id` populated anywhere, no
  `rebate_paid_at` set anywhere, and 0 rebate/refund rows in `activity_log`. **Answer: not
  demonstrated to have happened, ever, on this data.**
- **Livemode check on any refund id:** moot — there is no stored refund id anywhere in
  `hover_orders.rebate_stripe_id` to check. **No Stripe MCP tool was available in this session** (a
  targeted search found no `mcp__Stripe__*`/`stripe` tool to load), so a direct Stripe-API livemode
  check could not be performed even if an id existed. This is a limitation of this session, not a
  finding that the check was run and passed — flagged as a gap for whoever next has Stripe MCP access.
- **The defect that remains regardless of history:** the scan's query has **no `is_test` predicate**.
  The 2 hover orders on claim `73208937…` are not currently `rebate_due=true` (both read `rebate_due=false`
  in this session) — and, per the money-path correction above, that claim is real, not test, so this isn't a test-fixture case today; but nothing in the code prevents a
  future `is_test=true` hover order with `rebate_due=true` and a real-looking
  `homeowner_stripe_payment_intent_id` from being refunded by this cron job the next time it runs.
  That is the live risk, independent of whether it has fired historically.

**Verdict for §D's cron table: No — corrected from the PR's "N/A (by design)."**

## J. Summary counts — re-derived so they add up

Counting every row across §B–E that carries an actual Yes/No/N/A verdict row in one of those
sections' tables (§A's negative-control row is excluded as out-of-class; §F/§G are transactional
lookups and a completeness sweep, not steering verdicts, and are not part of this tally either):

**Derived by script, not by hand — this is the whole basis for the numbers below:**

```
$ python3 count_rows.py Docs/is-test-steering-queries.md
Section rows  Yes  No   N/A
B       7     3    3    1
C       3     2    1    0
D       11    1    10   0
E       8     1    7    0
-----------------------------
TOTAL   29    7    21   1

29 rows across sections B-E = 7 Yes / 21 No / 1 N/A
```

The script reads every row's own `**Yes**` / `**No**` / `**N/A**` (or `**Not stated**`, folded into
"No" — an unstated filter is a filter that does not exist) verdict marker directly off the table
text in §B, §C, §D's classification table and §E; it does not hardcode a row count or a
column position, because several rows here have fewer cells than their header (a separate, non-blocking
defect, unchanged by this fix).

- **Filters `is_test` (7 Yes):** §B row 1, §B row 3, §B row 5, §C rows 7–8, §D
  `send-homeowner-next-steps` (currently inactive), §E's CRO convention row (`:44,57`).
- **Does not filter (21 No):** every other tabulated row in §B–E — §B rows 2, 4, 5a; §C
  row 9; the 10 remaining §D cron rows; 6 of §E's remaining 7 rows.
- **N/A / out of scope (1):** §B row 6 (partner-scoped self-service dashboard).
- **Named in prose, not tabulated, and excluded from the 29-row count on purpose (not double-counted,
  not silently dropped):**
  - `gh1932-homeowner-signup-sweep` (cron job 21) is not a second steering surface — job 21 *is*
    the trigger for §C row 8 (`notify-admin-new-homeowner`'s signup-sweep path). Giving it its own
    row, on top of §C row 8, is what double-counted it in the old summary below.
  - `process-dunning-cron` (cron job 5) is a money-path charge-guard with a fail-open/fail-closed
    rule, not a `SELECT`-shaped steering query with a Yes/No verdict — see the dedicated paragraph
    below. It is documented in prose, not given a table row.
  - The 3 cron jobs confirmed genuinely out of scope this session (`platform-health-check-cron`,
    `manufacturer-cert-scrape`, `warranty-manifest-refresh`) never read any of the six named tables,
    so §D's classification table never gave them rows either; they are named in §D's prose only.
- **This replaces the PR's "9 / 24 / 4 of 33" (9+24+4 = 37, an arithmetic error over-counting by 4)
  and the round-1 figure before that ("10 / 8 / 2 of 20").** The corrected, script-derived total is
  **29 tabulated rows = 7 Yes / 21 No / 1 N/A** across §B–E.

**`process-dunning-cron` charge-guard, corrected:** `live-charge-guard.ts` evaluates `is_test`,
`live_charge_authorized_at` on the claim row. **A null or undefined `is_test` REFUSES the charge**
(`claim_unreadable`) — the PR had this backwards, describing null as being treated as "not test" (which
would *allow* a live charge on an unreadable row). The actual code fails closed: unreadable → refuse;
real claim → allow; test claim with the authorization marker set → allow (Dustin's deliberate
verification path, #1467); test claim without the marker → refuse. This is the one place in the whole
inventory where `is_test` gates money directly rather than just being counted, and getting its
direction backwards in documentation is exactly the kind of error #1961 exists to catch.

## Completeness sweep — commands and raw hit counts (this session)

Run against a local clone of the exact PR-head commit `c715ee0ed69e76b0365d07a652abd96bcbe31621`
(**GitHub's `search_code` API returned 0 hits for several known-positive queries in this session —
e.g. `is_test path:supabase/functions/check-siding-design-completion`, which the direct file read
above shows is wrong — so it was not used as evidence of absence anywhere in this document; a local
clone was used instead**):

```
git clone --depth 1 https://github.com/StellarEdgeServices/otterquote-platform.git
git checkout c715ee0ed69e76b0365d07a652abd96bcbe31621

grep -rlE "\.from\(['\"](claims|profiles|contractors|referrals|referral_agents|hover_orders)['\"]\)" \
  supabase/functions --include=*.ts | wc -l
  -> 60 files (of these, 30 have zero "is_test" hits by grep -c)
  [The PR's own report, run in a different container/session, found 55 files / 27 zero-hit — the
   ~5-file difference is consistent with this run's pattern also matching referral_agents and not
   excluding *.test.ts fixtures; both counts agree on the shape of the gap (roughly half of all
   table-touching functions have no is_test reference at all) and neither is treated as exact.]

grep -rlE "\.from\(['\"](claims|profiles|contractors|referrals|referral_agents|hover_orders)['\"]\)" \
  --include=*.html --include=*.tsx --include=*.ts . | grep -v supabase/functions
  -> 10 admin-*.html pages, 2 react-app/app/admin/*.tsx pages (full list in §G)
     + customer-facing pages (bids.html, dashboard.html, etc. — out of scope: user-scoped by RLS/
       .eq(user.id), not executive steering)

grep -rn "auth\.users\b" --include=*.ts --include=*.html --include=*.tsx --include=*.sql .
  -> 62 hits, mostly historical migration SQL (not steering surfaces); of the 3 non-migration
     function files the PR named (send-bid-confirmation, resend-hover-link, login.html):
     grep -c auth.users/auth.admin. on each -> 1, 2, 1 = 4 hits, 3 files (PR said "6 hits, 3 files" —
     close, not exact; recorded as measured this session, not reconciled further)

grep -rliE "create (or replace )?(view|function)" supabase/migrations | wc -l
  -> 52   (142 total migration files)
  of which, filtering to ones whose body reads one of the six tables:
  -> 30 (grep -liE "from (public\.)?(claims|profiles|contractors|referrals|referral_agents|
         hover_orders)\b" over those 52)

Executive tooling (device_bash, "Claude Downloads" mount):
  grep -lE "\.from\(.?(claims|profiles|contractors|referrals|referral_agents|hover_orders)|
    auth\.users|auth\.admin\." "In Flight/bin/"*.py
  -> 0 files. No Supabase-querying Python script in bin/ touches these tables by name (team-score.py's
     "claims" hits are GitHub issue-claim files, not the DB table — confirmed by reading the matches).

  grep -rlE "\bclaims\b|\bprofiles\b|\bcontractors\b|\breferrals\b|\breferral_agents\b|
    \bhover_orders\b|auth\.users" "Claude's Memories/Skills/"*/SKILL.md
  -> 29 SKILL.md files mention at least one of these words. Of those, the ones carrying an actual
     recorded steering NUMBER against one of the six tables (not just prose mentioning "claims" in
     the sense of GitHub issue claims, or "referrals" in a marketing sense) are: cro, cto,
     metrics-pkg — all three now enumerated in §E. The rest (auth-doctor, bug-killer, ceo-board,
     forge, migration-author, run-work, etc.) mention the words structurally (e.g. "file a claim",
     "GitHub issue") without recording a steering count, and are out of scope with that reason.
```

Every hit surfaced by the commands above is now either in this document (§B–G) or named out-of-scope
with a reason in this appendix (customer-scoped pages, historical migration SQL, dev/test tooling,
GitHub-issue-claim false positives, SKILL.md files that mention the words without recording a count).
