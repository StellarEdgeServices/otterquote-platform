# Runbook: Cron Alert Triage — Two-Signal Rule

**Type:** Cron / scheduled-job incident (applies to any pg_cron-triggered alert — not one specific job)
**Applies to:** All active pg_cron jobs on `yeszghaspzwwstvsrioa` (14 as of GitHub #898), including `process-bid-expirations`, `check-siding-design-completion`, `process-coi-reminders`, `process-payout-reminders`, `public-path-home`, `public-path-get-started`, and the `EDGE_FUNCTIONS_TO_PING` set (`notify-contractors`, `create-payment-intent`, `process-dunning`, `send-support-email`, `admin-contractor-action`, `send-incomplete-onboarding-reminders`) pinged by `platform-health-check`.
**Last updated:** 2026-08-17 — Created per GitHub #898 (`job_run_details` "succeeded" cannot detect an Edge Function failure)

---

## Why This Runbook Exists

Cron incidents get filed regularly (#500, #721, #722, and the #410 cron gate). The reflexive first move — query `cron.job_run_details`, see `status = 'succeeded'`, conclude the job is fine — is structurally incapable of detecting one entire class of failure, and produces a confident wrong answer. #898 documents a scoped version of this mistake made by the Code lane itself, which required posted corrections to #721 and #722.

## The Two Signals

All 14 active pg_cron jobs dispatch work the same way:

```sql
SELECT net.http_post(url := '.../functions/v1/<fn>', headers := ..., body := '{}'::jsonb) AS request_id;
```

`net.http_post` is **asynchronous**. That single fact is the root cause of the whole defect class:

| Source | Answers | Blind to |
|---|---|---|
| `cron.job_run_details.status` | Did pg_cron fire the trigger (HTTP request enqueued, `request_id` returned)? | Any Edge Function failure — reached, non-200, timeout, or crash before completion |
| `cron_health.last_run_at` (written by `record_cron_health`, read by `platform-health-check` — see `supabase/functions/platform-health-check/index.ts:87-94`) | Did the function finish its work end-to-end? | Nothing relevant — this is the only end-to-end signal available |

**A divergence between them is diagnostic: trigger fired, function failed.** `job_run_details = succeeded` alone proves nothing about function completion — it is never sufficient by itself to close a cron incident.

## The Wall-of-Succeeded Trap (evidence, not theory)

From #500, both July recurrences of the `check-siding-design-completion` alert:

- **2026-07-08** — ran 48 of 48 expected `*/30` invocations, including 08:30 and 09:00, per `job_run_details`. `platform-health-check` still alerted at 09:15:04 reporting `last_run_at` = 08:30:03. The 09:00 dispatch succeeded (pg_cron's view); the function did not complete its `record_cron_health` write (the real state).
- **2026-07-27** — also 48 of 48 (07-26 and 07-28 were clean). Same pattern.

In both cases, `job_run_details` alone said healthy while the job was not.

## Single-Row-No-History Limitation

`cron_health` holds one current row per job (upserted via `record_cron_health`'s `ON CONFLICT (job_name) DO UPDATE`), not a time series. A past EF-completion failure cannot be reconstructed after the fact from `cron_health` alone — the July recurrences above were only diagnosable by *inference*, cross-referencing a perfect `job_run_details` dispatch record against a firing alert. See "Open Gap" below for the retention proposal that would close this.

---

## When This Fires

Any of:
- A `platform-health-check` Phase 2 cron-staleness or `last_run_status = 'error'` alert (2-strikes gated, ~15 min apart) for any job in `CRON_STALENESS_THRESHOLDS`.
- A `platform-health-check` Phase 1 EF-ping failure for any function in `EDGE_FUNCTIONS_TO_PING`.
- A manually-noticed cron incident under investigation (e.g. a newly filed GitHub issue, or continuing #500 / #721 / #722 / #410-style work).

## Tier A Steps (autonomous)

Run all three before drawing any conclusion. Do not stop at query 1.

**1. Recent `job_run_details` for the job — did pg_cron fire the trigger?**
```sql
SELECT jrd.start_time, jrd.end_time, jrd.status, jrd.return_message
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = '<job-name>'
ORDER BY jrd.start_time DESC
LIMIT 20;
```

**2. Current `cron_health` row for the job — did the function report completion?**
```sql
SELECT job_name, last_run_at, last_run_status, last_error, run_count, created_at
FROM public.cron_health
WHERE job_name = '<job-name>';
```

**3. Divergence check — the two signals compared directly:**
```sql
SELECT j.jobname,
       jrd.start_time  AS trigger_fired_at,
       ch.last_run_at  AS function_completed_at,
       CASE
         WHEN ch.last_run_at IS NULL
           OR ch.last_run_at < jrd.start_time - interval '1 minute'
         THEN 'DIVERGENT — trigger fired, function did not complete'
         ELSE 'aligned'
       END AS signal_check
FROM cron.job j
JOIN cron.job_run_details jrd ON jrd.jobid = j.jobid
LEFT JOIN public.cron_health ch ON ch.job_name = j.jobname
WHERE j.jobname = '<job-name>'
ORDER BY jrd.start_time DESC
LIMIT 5;
```

If query 3 reports DIVERGENT, the incident is a Class B failure (function did not complete) regardless of what `job_run_details` alone showed — proceed to the function's own logs (`query_logs` / Edge Function logs) and its `record_cron_health` call site, not to a widened staleness threshold. (#500 makes the "don't just widen the threshold" case explicitly — that treats the symptom, not the cause, and the two failure classes have different owners and different fixes.)

## Tier B Steps (execute + notify Dustin)

- Step 1: If query 3 confirms DIVERGENT, summarize both signals (not just one) in the incident write-up / issue comment, citing this runbook and #898. If a self-reporting job (`process-coi-reminders`, `process-bid-expirations`, `process-payout-reminders`, `check-siding-design-completion` — see the ARCHITECTURE NOTE at `platform-health-check/index.ts:87-94`) is missing its `record_cron_health()` call entirely, that is itself the defect — notify Dustin with the specific function and line.
- Step 2: If the two signals are aligned (both healthy, or both failing together), the incident is a genuine Class A failure (trigger-level) or a genuine full outage — proceed with standard incident triage rather than this runbook's divergence path.

## Tier C Steps (escalate)

- Step 1: Do not resolve or downgrade a cron alert on `job_run_details = succeeded` alone. If the two signals disagree and the fix isn't obvious (e.g. it implicates `platform-health-check` itself, a D-220 Edge Function), escalate to the Bridge/Dustin rather than editing `platform-health-check` unilaterally.
- Step 2: Alert-class relabeling ("trigger missed" vs "function did not complete" as distinct classes) and any `cron_health` history/retention change are open proposals from #898, not yet decided — route to the Bridge, do not implement ad hoc mid-incident.

## Resolution Criteria

- Both signals (`job_run_details` and `cron_health.last_run_at`) reviewed and reconciled — not just the first one checked.
- If DIVERGENT was found: root cause identified (dropped `record_cron_health` call, function-side exception, timeout, etc.) and either fixed or explicitly deferred with an owner.
- Any related GitHub issue (#500 / #721 / #722 / #410-style) is scoped correctly to reflect which signal actually failed.

## Auto-resolve eligible: no

A "succeeded" `job_run_details` reading must never be treated as auto-resolving evidence on its own — that is the exact defect this runbook exists to prevent. Resolution requires a human (or an agent under Tier B/C discipline) to have checked `cron_health` too.

## Open Gap (tracked, not fixed by this runbook)

`cron_health` retains no history — see "Single-Row-No-History Limitation" above. A draft append-only `cron_health_history` schema (table + trigger + retention purge) is proposed in the PR that introduced this runbook (`docs(gh-898)`, "For migration-author" section) and in GitHub #898's suggested scope. Not applied by this runbook or this PR.

---

## See Also

- GitHub #898 — this defect, full analysis, evidence
- GitHub #500 — original discovery, full two-class root-cause analysis, the "don't widen the threshold" argument
- GitHub #721 / #722 — cron incidents with posted corrections to dispatch-based claims
- GitHub #410 — de-fragilize the `process-payout-reminders` cron gate
- GitHub #709 — server-side errors (EF/cron/webhook) likely reporting to no Sentry project
- `supabase/functions/platform-health-check/index.ts:87-94` — architecture note on self-reporting vs externally-written `cron_health` rows
- `runbooks/README.md` — format and coverage policy
