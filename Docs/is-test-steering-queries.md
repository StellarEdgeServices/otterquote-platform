# `is_test` filter inventory — queries an executive or the SES Portfolio steers by

Filed against #1961. Enumeration method: `grep` over `supabase/functions/**`, `admin-*.html`,
`react-app/app/admin/**`, `partner-dashboard.html`, `Claude's Memories/Skills/{ceo,cto,cro,pre-flight-walk,metrics-pkg,morning}/SKILL.md`,
`In Flight/bin/*.py`, `In Flight/board-overlay.json`, plus `select jobid, jobname, schedule, command from cron.job` via
Supabase MCP against project `yeszghaspzwwstvsrioa`. Every row below carries the file:line (or query) it was read from.
This file lists what filters and what does not; it does not change any query (per #1961 scope note — the fix lands separately).

**Default (this document's stated convention, matching #1961's candidate):** `is_test = false` is the default for
anything an executive or the SES Portfolio reads as a real-world count. Including fixtures must be explicit and named
at the call site (a `scanIsTest=true` dry-run flag, a `showTest` toggle defaulted off, etc.). A row below is "unfiltered"
when no such opt-in exists and fixtures are included by default.

## A. Negative control — #1944 re-run (2026-09-15, this run, project `yeszghaspzwwstvsrioa`)

| Query | Result |
|---|---|
| `select count(*) from claims where status='documents_needed';` (unfiltered — #1944's original query) | **3** |
| `select count(*) from claims where status='documents_needed' and is_test = false;` (filtered) | **0** |
| `select status, count(*) from claims where is_test = false group by status;` | `active: 1`, `draft: 2` |

Matches Kevin's #1944 evidence exactly (3 fixture rows, all `is_test=true`; zero real claims near `documents_needed`).

## B. Dashboards / boards executives and the SES Portfolio actually read

| # | Surface | Source | Tables | Filters `is_test`? | Detail |
|---|---|---|---|---|---|
| 1 | Business Lines dashboard (Otter Quotes line — the closest thing in-repo to "the SES Portfolio" for this line) | `supabase/functions/get-business-lines-dashboard/index.ts:972-998` (reads), `:1335` `nonTestRows()`, `:1454` `nonTest()`, `:1478` `claims_non_test` → rendered by `admin-dashboard.html:462-490` | `profiles`, `claims`, `quotes`, `contractors`, `referral_agents`, `referrals`, `hover_orders`, `leads` | **Yes, both ways** — every tile ships a `*_total` (raw) and a `*_non_test` (filtered) figure side by side; the page shows both (`admin-dashboard.html:462-466`). `hover_orders` and `leads` have no `is_test` column (`index.ts:1009-1012`) and are counted as-is, documented inline. |
| 2 | SES Portfolio artifact (`In Flight/ses-portfolio.html`, Dustin's second pinned report) | `In Flight/bin/render-boards.py:509-536` renders `ov["portfolio"]` from `In Flight/board-overlay.json:91-137` | none directly — **not a live query**. The "2 of 16 claims — both `is_test`" line (`board-overlay.json:137`) is free text a CEO run typed in after running its own ad hoc query. | **No fixed query exists to audit** — this is the structural gap #1961 flags. Today's correctness depends entirely on whoever wrote that line having filtered by hand. Recorded here as: reason = "narrative field, CEO-authored per run, no code path counts it automatically." |
| 3 | Admin Homeowners list + loss-sheet queue | `supabase/functions/get-homeowner-list/index.ts:270-282` (raw select, `is_test` column included, not filtered at the query) → `admin-homeowners.html:612` `state.showTest ? all : all.filter(!is_test)` (page defaults `showTest` off) | `claims`, `profiles` | **Partial.** Row *list* defaults to non-test (toggle-gated). But the **loss-sheet queue tally** (`missing`/`uploaded_unreviewed`/`reviewed` counts) is built from the unfiltered set — `index.ts:356`: `// gh-1796 — counts over ALL rows, is_test included. The page filters.` The page's queue counters (`admin-homeowners.html:401-411`) render off `body.loss_sheet_queue` directly — **no re-filter of that specific tally was found**, so the queue counts an admin sees can include fixture rows. |
| 4 | Admin Contractors list | `admin-contractors.html:883-886`; `react-app/app/admin/contractors/page.tsx:95` | `contractors` | **No** — plain `.select('*', ...).order('created_at')`, no `is_test` predicate and no client-side toggle found in either surface. |
| 5 | Admin Referrals / partner leaderboard | `admin-referrals.html:538-540` (`.eq('is_test', false)`) vs. `:752`, `:769`, `:846` (same table, no `is_test` predicate visible at those call sites) | `referral_agents` | **Partial** — one call site filters, three others on the same page were not confirmed to. Flagged for the triager to re-check the unconfirmed three before relying on this page as fully filtered. |
| 6 | Partner self-service dashboard ("Portfolio Report" tile, `partner-dashboard.html:1165-1167`) | `partner-dashboard.html:1770-1905` | `referral_agents`, `referrals`, `payout_approvals` | **N/A / out of scope for this class** — every query is `.eq('referral_agent_id'/'user_id', currentPartner.id)`-scoped to the signed-in partner's own rows. It is not an aggregate executive metric; a partner cannot see another partner's or a fixture's rows via this surface by design. Named here only because "Portfolio Report" text-matches the issue's "SES Portfolio" wording — **it is a different thing** (per-partner report vs. the CEO's SES Portfolio artifact in row 2). |

## C. Digests / admin alerts (per-event or batch, feed the CEO/CTO inbox rather than a board)

| # | Function | Tables | Filters `is_test`? | Detail |
|---|---|---|---|---|
| 7 | `notify-admin-new-homeowner` (claim-created path) | `profiles`, (claim record) | **Yes** | `index.ts:311-320`: reads `profiles.is_test`, ORs it with `record.is_test` and an excluded-email check; skips the alert entirely if either is true (`:324-330`). |
| 8 | `notify-admin-new-homeowner` (signup-sweep + backfill digest paths) | `profiles`, `contractors`, `claims` | **Yes** | `:423-447` and `:608-640`: candidate profiles filtered by `c.is_test !== true` before either the individual alert or the digest email is built. |
| 9 | `notify-admin-new-contractor` | `contractors` | **No** — `index.ts:190-205` fetches the contractor by id and emails the admin; no `is_test` reference anywhere in the file (`grep -n is_test supabase/functions/notify-admin-new-contractor/index.ts` → 0 hits). Every new contractor signup alerts the admin inbox, fixture or real. |

## D. Cron jobs (`select jobid, jobname, schedule, command from cron.job`, project `yeszghaspzwwstvsrioa`, run this session)

Raw result (20 active jobs; ids and schedules exactly as returned):

```
3  process-bid-expirations              0 * * * *
4  process-coi-reminders                0 8 * * *
5  process-dunning-cron                 */30 * * * *
6  check-siding-design-completion       */30 * * * *
7  platform-health-check-cron           */15 * * * *
8  process-payout-reminders             0 9 * * *
10 process-hover-rebate-scan            */30 * * * *
13 send-incomplete-onboarding-reminders 0 14 * * *
14 manufacturer-cert-scrape             0 8 * * 0
15 warranty-manifest-refresh            0 9 1 1,4,7,10 *
16 home-profile-prompt-hourly           0 * * * *
17 process-auto-bids                    */5 * * * *
18 counter-sig-reminders                */30 * * * *
19 watch-template-mapping               20 * * * *
20 send-homeowner-next-steps            */30 * * * *
21 gh1932-homeowner-signup-sweep        */15 * * * *
```

Each job's command is a `net.http_post` to its Edge Function — the SQL itself carries no table filter; the filter
state is decided inside the function (see below). Jobs not touching the six named tables (`check-siding-design-completion`,
`platform-health-check-cron`, `manufacturer-cert-scrape`, `warranty-manifest-refresh`, `watch-template-mapping`,
`home-profile-prompt-hourly`) are out of scope for this inventory and are not classified below.

| Cron job | Function selects from | Filters `is_test`? | Detail |
|---|---|---|---|
| `send-homeowner-next-steps` (job 20) | `claims`, `hover_orders`, `profiles` | **Yes — this is the #1944/#1570 fix.** `dry-run.ts:130-131`: `.select(...).eq("is_test", opts.scanIsTest)`. Production run always calls with `scanIsTest=false` (`index.ts:375-401`); the dry-run mode explicitly flips to `true` and logs it (`index.ts:352`). Test (`dry-run.test.ts:61-77`) asserts exactly one `is_test` filter is present on every call, never zero. |
| `process-auto-bids` (job 17) | `claims`, `contractors` | **No** — `index.ts:86-93`: qualifying-claims query filters `funding_type`, `job_type`, `ready_for_bids`, `roofing_bid_released_at`, `rcv_amount`; no `is_test` predicate. A fixture claim meeting the other criteria would receive real contractor auto-bids. `is_test` is read later only to stamp the outgoing quote row (`:227`), not to exclude the claim from being bid on. |
| `process-bid-expirations` (job 3) | `claims`, `profiles` | **No** — `index.ts:726-745`: filters `bid_window_expires_at`, `bid_window_notified_at`, `status in (bidding, submitted)`; no `is_test` predicate. Notifies homeowners (real email) on fixture claims that happen to carry a real-looking status. |
| `counter-sig-reminders` (job 18) | `claims`, `contractors` | **No** — `index.ts:526-547`; `grep -n is_test` on the whole file returns 0 hits. |
| `process-coi-reminders` (job 4) | `contractors` | **No filter on the query itself** (`index.ts:669-676`, `:930-934`: filters `status='active'` / `coi_expires_at not null`; no `is_test` predicate). `contractor.is_test` is read only to stamp the `activity_log` row it writes (`:1042`), not to skip fixture contractors. |
| `process-payout-reminders` (job 8) | `referral_agents` | **No** — `index.ts:440-451`, `:484`: filters `payments_blocked`, `w9_notification_sent_at`; no `is_test` predicate found. |
| `process-hover-rebate-scan` (job 10) | `claims`, `hover_orders` | **N/A (by design)** — `index.ts:103-114`: reads `claims.is_test` and propagates it onto the `hover_orders` row it creates (`:146,177`); this is *stamping*, not filtering, and is the intended behavior per gh-1028. |
| `send-incomplete-onboarding-reminders` (job 13) | `contractors` | Not confirmed — file selects `contractors` (`:179,202`) but no `is_test` reference found in a keyword grep; not traced line-by-line this run. Listed for completeness, not verified to the same depth as the rows above. |
| `gh1932-homeowner-signup-sweep` (job 21) | `profiles`, `contractors` | **Yes** — same code path as row 8 above (`notify-admin-new-homeowner`, `event_type=signup_sweep`). |
| `process-dunning-cron` (job 5) | `claims`, `contractors`, `profiles` | **Yes, for the safety-critical path** — `live-charge-guard.ts:48-89`: `GUARD_SELECT` includes `is_test`; the guard allows a **real** charge only when `claim.is_test !== true`, and treats a missing/null flag as "not test" (fail-closed toward blocking test rows from live charges, not toward exposing real ones). This is a charge-authorization gate, not a steering count, but it is the one place `is_test` is load-bearing for money movement, so it's recorded here. |

## E. Documented steering queries in exec tooling (Memories/Skills)

| Source | Query / convention | Filters `is_test`? |
|---|---|---|
| `Claude's Memories/Skills/cro/SKILL.md:44` | "Supabase: `auth.users`, `contractors`, `referral_agents`, `referrals`, `claims` (counts last 24h/7d, `is_test` excluded) — every run" | **Yes**, by stated convention — this is the CRO's funnel-row query, run ad hoc each CRO session via Supabase MCP, not a code path in the repo. |
| `Claude's Memories/Skills/cro/SKILL.md:57` | Funnel row: visits → signups → checkouts → paid → referrals (`is_test=false`) | **Yes** |
| `In Flight/bin/render-boards.py`, `team-score.py`, `cro-ga4.py`, `cro-clarity.py` | Checked directly (`grep -n ".from(\|select \|is_test\|claims\|profiles\|contractors\|referrals\|hover_orders\|auth\.users"`) | **No database queries found at all.** `team-score.py`'s "claims" hits are all GitHub-issue-claim files in `In Flight/claims/`, not the `claims` DB table — a false positive on the grep, confirmed by reading the matched lines. `render-boards.py` reads `In Flight/dump.json` (GitHub) and `In Flight/board-overlay.json` (CEO-authored text) only — it does not touch Supabase. `cro-ga4.py`/`cro-clarity.py` call GA4/Clarity APIs, not Supabase. **These four scripts are a confirmed negative for this class of risk** — recorded so the check doesn't need repeating. |

## F. Known schema/data gaps (per #1961 body and Ben's audit — not fixed here)

- **Tables carrying `is_test` with no user-linking column** (per Ben's audit, confirmed by grep in this run): `quotes`
  (linked via `claim_id`/`contractor_id`, not a user), `payout_approvals`, `referrals` (linked via `referral_agent_id`/`claim_id`),
  `funnel_abandonment_facts`. A filter on these tables excludes fixture rows fine, but nothing here lets you resolve
  a row back to "which person" without joining out — noted, not addressed this run.
- **`hover_orders` and `leads` have no `is_test` column at all** (confirmed at `get-business-lines-dashboard/index.ts:1009-1012`);
  they are counted as-is everywhere, and that is documented inline in the source rather than silently assumed.
- **#1763 (open, PR #1912):** `profiles.is_test` and `contractors.is_test` disagree on 7 rows. Every "filters `is_test`"
  answer in this document is only as trustworthy as that flag; this document does not re-verify the 7-row disagreement
  and defers to #1763. **Dependency, not fixed here.**

## G. Summary count

- Rows enumerated in B+C+D+E: **20** query/surface entries across dashboards, digests, cron-driven Edge Functions, and
  documented exec-tooling conventions (excluding the 6 cron jobs in D ruled out-of-scope and the negative-control row in A).
- **Filters `is_test` (yes or yes-by-design):** rows 1, 3(partial), 7, 8, `send-homeowner-next-steps`, `gh1932-homeowner-signup-sweep`,
  `process-hover-rebate-scan` (stamps, by design), `process-dunning-cron` (charge-guard), CRO SKILL rows (2) — **10 of 20**.
- **Does NOT filter (unfiltered by default):** row 2 (SES Portfolio narrative — no fixed query to filter), row 4
  (admin contractors list), row 9 (`notify-admin-new-contractor`), `process-auto-bids`, `process-bid-expirations`,
  `counter-sig-reminders`, `process-coi-reminders`, `process-payout-reminders` — **8 of 20**.
- **Partial / not fully confirmed:** row 3's loss-sheet queue tally, row 5 (3 of 4 `referral_agents` call sites on
  the same page), `send-incomplete-onboarding-reminders` — **2 of 20** (called out for a follow-up pass, not resolved here).

## Negative control, restated (per #1961's suggested closes-on)

The pre-fix, inflated number **and** the post-filter, real number, side by side, from this session:

```
unfiltered (#1944's own query): select count(*) from claims where status='documents_needed';        -> 3
filtered (is_test=false added): select count(*) from claims where status='documents_needed' and is_test = false; -> 0
grouped real-status count:      select status, count(*) from claims where is_test=false group by status; -> active: 1, draft: 2
```

This matches Kevin's #1944 finding exactly and is the negative control #1961 asked for.
