# OtterQuote — Launch Readiness Report
**Date:** 2026-05-01
**Author:** Ram (AI Technical Co-Founder)
**ClickUp Task:** [86e132bfh](https://app.clickup.com/t/86e132bfh)
**Scope:** Consolidates E2E Phase 3 (retail siding), Phase 5 (admin/platform), Phase 7 (SOW/contract), Phase 8 (spec drift)
**Purpose:** Go / No-Go decision document for first live homeowner

---

## Executive Summary

**Recommendation: GO-WITH-CAVEATS — Insurance Roofing Only**

OtterQuote is not ready for an unrestricted first homeowner today. However, the insurance roofing flow is sufficiently functional to support a first controlled homeowner under specific conditions. The platform must not be opened to retail or siding jobs until the defects identified in Phases 3 and 7 are resolved.

**The three gates that determine the call:**

1. **D-P7-001 (CRITICAL — legal):** Retail envelopes can silently omit Exhibit A on any SOW generation error. This is a potential IC 24-5-11-10(a)(4)+(5) violation. This defect **does not affect insurance roofing** — insurance envelopes have no Exhibit A by design per D-201. The CRITICAL gate is closed for retail; it is not a gate for insurance roofing.

2. **TOS/PP attorney review (OPEN — regulatory):** Terms of Service and Privacy Policy are DRAFT. No live homeowner should create an account against unreviewed legal documents. This is a pre-conditions gate for ALL flows regardless of job type. **This is the single hardest blocker for first homeowner.**

3. **Business insurance (OPEN — operational, due May 8):** Without a confirmed business insurance policy, OtterQuote has no coverage if a contractor dispute escalates. This is a Dustin-action item with a known deadline.

**Conditional GO path for insurance roofing:**
- TOS/PP attorney sign-off received
- Business insurance confirmed (May 8 deadline)
- Phase 5 HIGH defects resolved (form_start GA4 event, platform-health-check cron logging)
- First homeowner is a controlled test (known homeowner, monitored closely) — not a public campaign push

**Unconditional NO-GO for retail/siding:**
- D-P7-001 (CRITICAL) must be resolved and GC-cleared before any retail envelope is sent
- D-P3-001/002 (HIGH) must be resolved before any siding Hover order is placed

---

## Defect Totals by Severity — All Phases

| Severity | Phase 3 | Phase 5 | Phase 7 | Phase 8 | **Total** | Open |
|----------|---------|---------|---------|---------|-----------|------|
| CRITICAL | 0 | 0 | 1 | 0 | **1** | 1 |
| HIGH | 3 | 2 | 2 | 8 (drift) | **15** | 15 |
| MEDIUM / NORMAL | 2 | 0 | 1 | 14 (drift) | **17** | 17 |
| LOW | 1 | 0 | 2 | 9 (drift) | **12** | 12 |
| **Total** | **6** | **2** | **6** | **31** | **45** | **45** |

*Phase 8 counts are drift items (spec documentation debt), not code defects. They do not block launch.*
*Phase 5 defect counts from claude-memory.md "Pre-launch blockers" note — Phase 5 report file was not preserved (D-P7-003 class of issue).*

---

## Open Critical Defect — Must Fix Before First Retail Homeowner

| ID | Phase | Severity | File | Issue | Status |
|----|-------|----------|------|-------|--------|
| D-P7-001 | 7 | CRITICAL | `create-docusign-envelope/index.ts` ~line 1781 | Retail SOW generation failure is non-fatal — envelope sends without Exhibit A. Violates D-185 fail-loud rule. Potential IC 24-5-11-10(a)(4)+(5) exposure. Re-throw required for retail; Tier 3 — GC review required before ship. | [86e16e393](https://app.clickup.com/t/86e16e393) — OPEN |

**This defect does NOT affect insurance roofing.** Insurance envelopes have no Exhibit A (D-201). The critical gate is retail-only.

---

## Must-Fix Before First Homeowner (Any Job Type)

These defects block the controlled first homeowner regardless of job type.

| ID | Phase | Severity | Issue | Blocker Scope |
|----|-------|----------|-------|---------------|
| Phase 5 — HIGH #1 | 5 | HIGH | `platform-health-check` Edge Function not logging public-path probe results to `cron_health`. Platform health monitoring incomplete — outage detection degraded. | All flows |
| Phase 5 — HIGH #2 | 5 | HIGH | `form_start` GA4 event missing from `get-started.html`. Homeowner conversion funnel blind from step 1. Cannot measure acquisition effectiveness. | All flows |
| D-P7-002 | 7 | HIGH | DocuSign envelope document name "Scope of Work" vs. D-200 spec "Exhibit A — Scope of Work". One-line fix. Bundle with D-P7-001 deploy. | Retail only |
| D-P3-006 | 3 | LOW | `help-measurements.html` auth bootstrap uses deprecated `DOMContentLoaded + getSession()` pattern instead of F-007. Race condition on Supabase JS v2. | All flows (help-measurements path) |

*Recommendation: Phase 5 HIGH defects and D-P3-006 can be fixed in a single pre-launch sprint. D-P7-002 bundles with D-P7-001 once GC clears.*

---

## Must-Fix Before First Retail/Siding Homeowner

These defects block retail and siding flows specifically.

| ID | Phase | Severity | Issue | Status |
|----|-------|----------|-------|--------|
| D-P3-001 | 3 | HIGH | `help-measurements.html`: `deliverable_type_id` hardcoded to `2` (Roof Only). Siding Hover order gets no 3D design capability. D-164 gate can never clear. | [86e16d7vw](https://app.clickup.com/t/86e16d7vw) — OPEN |
| D-P3-002 | 3 | HIGH | `create-hover-order/index.ts`: Backend also hardcodes `deliverable_type_id=2`. Frontend fix alone insufficient. | [86e16d7xd](https://app.clickup.com/t/86e16d7xd) — OPEN |
| D-P3-005 | 3 | MEDIUM | `check-siding-design-completion/index.ts`: Resolves `hover_job_id` from filename regex only; doesn't query `hover_orders.hover_job_id`. Gate silently skips claims with valid hover_orders row. | [86e16d80a](https://app.clickup.com/t/86e16d80a) — OPEN |
| D-P3-003 | 3 | HIGH | `color-selection.html`: `loadClaimData()` queries `.eq('homeowner_id', userId)` — column is `user_id`. Page returns no data for any user. Entire post-contract color flow non-functional. | [86e16d7yq](https://app.clickup.com/t/86e16d7yq) — OPEN |
| D-P3-004 | 3 | MEDIUM | `color-selection.html`: `requestColorBoardVisit()` insert uses wrong column names. Contractor never notified. Masked by D-P3-003. | [86e16d7zv](https://app.clickup.com/t/86e16d7zv) — OPEN |
| D-P7-001 | 7 | CRITICAL | Retail SOW fail-loud (see above). | [86e16e393](https://app.clickup.com/t/86e16e393) — OPEN |

---

## Pre-Launch Blocker Reconciliation

Cross-check against `claude-memory.md` Active Projects pre-launch blockers (line 615) and task prompt.

| Blocker | Memory Status | Current State | Cleared? |
|---------|--------------|---------------|----------|
| TOS/PP attorney review | IN PROGRESS 🔄 | `terms.html` + `privacy.html` marked DRAFT — needs attorney review. No confirmation of clearance this session. | ❌ NOT CLEARED |
| Business insurance (May 8) | Open — date specific | May 8 deadline. Today is May 1 — 7 days. Dustin action item. | ❌ NOT YET — deadline May 8 |
| Twilio TCR campaign approval | IN PROGRESS 🔄 | 3rd submission in progress at TCR as of Apr 28. May 14 check-in. Brand APPROVED; campaign pending. SMS notifications unavailable until cleared. | ❌ NOT CLEARED (non-blocking for first homeowner if SMS falls back gracefully) |
| v67 migration (intro video) | Open | `contractors.intro_video_path` column migration. INTRO_VIDEO_ENABLED constant currently `false` — intro video card hidden until migration ships. | 🟡 PARTIAL — feature gated OFF; platform functions without it. Ship v67 before flipping flag. |
| D-181 Hover payment E2E | IN PROGRESS | Phase 3 confirmed the $79 Stripe + Hover flow has the F-007 auth bug (D-P3-006) and the deliverable_type_id bug (D-P3-001/002) for siding. Roofing Hover order path not E2E tested end-to-end on staging with Stripe test keys. Staging Stripe key configuration unconfirmed (Phase 3 note). | ❌ NOT CLEARED — requires staging Stripe key verification + smoke test with real roofing claim |
| Mark Job Complete (86e0yvj7b) | Shipped today | LIVE ✅ confirmed in `otterquote-memory.md` build status. | ✅ CLEARED |
| Home photos on bid form (86e0zdknj) | Shipped today | LIVE ✅ confirmed in `otterquote-memory.md` build status. | ✅ CLEARED |
| Phase 5 HIGH defect — platform-health-check logging | OPEN | Confirmed in claude-memory.md. No Phase 5 report to cross-check but Active Projects note explicitly lists it. | ❌ NOT CLEARED |
| Phase 5 HIGH defect — form_start GA4 missing from get-started.html | OPEN | Same as above. | ❌ NOT CLEARED |

**Note on Phase 5 report:** No Phase 5 E2E report file exists in `Docs/E2E-Reports/`. The Phase 7 report noted this, and it is confirmed here. Phase 5 results were recorded only in `claude-memory.md` Active Projects section. The two HIGH defects are real per that record. A Phase 5 report should be reconstructed or re-run as a separate task.

---

## Flow-by-Flow Readiness Assessment

| Flow | Ready? | Blockers |
|------|--------|----------|
| Insurance roofing — homeowner intake → dashboard | ✅ Ready | — |
| Insurance roofing — Hover measurement order | 🟡 Conditional | D-181 Hover payment E2E (staging Stripe key unconfirmed); D-P3-006 auth bug in help-measurements.html |
| Insurance roofing — contractor bids | ✅ Ready | — |
| Insurance roofing — homeowner bid selection | ✅ Ready | — |
| Insurance roofing — contract signing (DocuSign) | ✅ Ready | D-P7-002 (doc name cosmetic — low risk for first homeowner) |
| Insurance roofing — color selection / project confirmation | 🟡 Conditional | D-P3-003 query bug in color-selection.html (wrong column); fix is a one-liner |
| Retail / siding — any step | ❌ Blocked | D-P3-001/002 (Hover), D-P3-003/004 (color), D-P7-001 (SOW CRITICAL) |
| Admin — contractor approval | ✅ Ready | — |
| Admin — platform health monitoring | 🟡 Degraded | Phase 5 HIGH defect — cron_health logging gap |
| Analytics / GA4 | 🟡 Degraded | Phase 5 HIGH defect — form_start missing from get-started.html |

---

## Pre-Launch Sprint Definition

If Dustin decides to proceed with the conditional GO, the following sprint must ship before first homeowner:

**Sprint tasks (estimated 1 session):**
1. Fix Phase 5 HIGH #1 — `platform-health-check` EF: log public-path probe results to `cron_health`
2. Fix Phase 5 HIGH #2 — `get-started.html`: add `form_start` GA4 event
3. Fix D-P3-006 — `help-measurements.html`: replace deprecated auth bootstrap with F-007 pattern
4. Fix D-P3-003 — `color-selection.html`: change `homeowner_id` → `user_id` in `loadClaimData()` (one-liner)
5. Verify staging Stripe keys in Netlify env → smoke test $79 Hover payment with roofing test claim

**GC/attorney items (external, not code — Dustin coordinates):**
- TOS/PP attorney sign-off
- Business insurance (May 8 deadline)

**Hold for retail/siding (not in pre-launch sprint):**
- D-P3-001/002 (requires Hover deliverable_type_id research)
- D-P7-001 (requires GC review + re-throw logic)

---

## What the First Homeowner Experience Looks Like (Conditional GO)

With the pre-launch sprint complete and TOS/PP + insurance cleared:
1. Homeowner signs up → trade-selector → chooses insurance roofing → dashboard
2. Uploads insurance estimate → requests Hover measurements ($79 Stripe payment, E2E smoke-tested)
3. Hover order placed → measurements returned → bid release
4. Contractor bids arrive → homeowner compares in bids.html (full comparison grid)
5. Homeowner selects contractor → contract-signing.html → DocuSign [contractor first, homeowner second]
6. Executed contract + IC 24-5-11 addendum delivered
7. Contractor sees executed contract on dashboard → initiates job → Mark Job Complete when done
8. Platform processes rebate; warranty upload prompt follows

SMS notifications will be absent (Twilio TCR pending) — homeowners receive email only. This is acceptable for a controlled first homeowner.

---

## Sign-Off Block

```
Reviewed by Dustin: _____________________________ Date: _____________

Decision: ☐ GO — Insurance Roofing Only (pre-launch sprint + TOS/PP + insurance required first)
          ☐ GO — Full Unrestricted (requires all defects resolved — not recommended today)
          ☐ NO-GO — Needs further work before any homeowner

Notes: ____________________________________________________________

Conditions / Caveats: _____________________________________________
```

---

## Report Index

| Phase | File | Verdict | Critical Open |
|-------|------|---------|---------------|
| Phase 3 — Retail Siding | `phase-3-retail-siding-2026-05-01.md` | BLOCKED (3 HIGH) | 0 CRITICAL / 3 HIGH open |
| Phase 5 — Admin/Platform | *(no report file — see claude-memory.md Active Projects)* | PASS with caveats | 0 CRITICAL / 2 HIGH open |
| Phase 7 — SOW/Contract | `phase-7-sow-contract-2026-05-01.md` | BLOCKED (1 CRITICAL) | 1 CRITICAL open |
| Phase 8 — Spec Drift | `phase-8-spec-drift-2026-05-01.md` | Documentation debt only | 0 code defects |

---

*Report generated by Ram. ClickUp tasks: [86e132beg](https://app.clickup.com/t/86e132beg) (Phase 8), [86e132bfh](https://app.clickup.com/t/86e132bfh) (Phase 9 / Final Report).*
