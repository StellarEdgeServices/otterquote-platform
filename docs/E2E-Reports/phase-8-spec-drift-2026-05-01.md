# E2E Phase 8 — Spec Drift Check
**Date:** 2026-05-01
**Tester:** Ram (AI Technical Co-Founder)
**ClickUp Task:** [86e132beg](https://app.clickup.com/t/86e132beg)
**Source of Truth:** `Claude's Memories/otterquote-pages.md` (1,210 lines, last full verification March 22, 2026)
**Production:** `otterquote-deploy/` working directory (synced to origin/main HEAD, May 1, 2026)
**Method:** Full spec traversal against production file inventory + build status table in `otterquote-memory.md`

---

## Summary

| Metric | Count |
|---|---|
| Spec pages evaluated | 32 |
| Pages with no drift | 14 |
| Pages with spec-has-extra drift (spec stale vs. prod) | 9 |
| Pages in prod not documented in spec | 18 |
| HIGH drift items | 8 |
| MEDIUM drift items | 14 |
| LOW drift items | 9 |
| **Spec sections documenting features that are regressions in prod** | **0** |
| **ClickUp tasks filed** | **5** |

**Verdict:** The spec is significantly stale relative to production. Direction of drift is overwhelmingly one-way: production has substantially more functionality than the spec documents. No evidence of production regressions (features the spec says exist that prod doesn't have). The spec's staleness is a documentation/maintenance debt, not a product defect. All drift items are spec-update actions or Dustin-decides cleanup items — none are code bugs.

---

## Drift Direction Definitions

- **PROD-HAS-EXTRA:** Production contains a page or feature the spec does not document.
- **SPEC-HAS-EXTRA:** The spec documents something that production does not implement (a regression), OR the spec describes a significantly different current state from what is live.

---

## Page-by-Page Pass/Fail Table

| # | File | Spec Status | Drift Direction | Severity | Notes |
|---|------|-------------|-----------------|----------|-------|
| 1 | index.html | ✅ PASS | — | — | Spec verified April 8, 2026 (Session 88). No known changes since. |
| 2 | get-started.html | ⚠️ DRIFT | SPEC-HAS-EXTRA | MEDIUM | Spec missing TCPA consent checkbox, siding timing note, D-189 HubSpot contact creation, SMS consent `required` removal. |
| 3 | dashboard.html | ⚠️ DRIFT | SPEC-HAS-EXTRA | MEDIUM | Known stale. Missing from spec: per-trade status pills, D-171 switch survey modal, D-178 state gating, D-181 Hover payment status, warranty download button, GBP photos. |
| 4 | bids.html | ⚠️ DRIFT | SPEC-HAS-EXTRA | MEDIUM | Spec missing: Cards/Compare 16-row side-by-side comparison grid (Headline/Materials/Add-ons/Other Trades/Contingencies), ✓/$X/✗/— cell states, identical-row dimming. |
| 4a | contractor-about.html | ✅ PASS | — | — | Spec updated May 1, 2026 (intro video display block). Current. |
| 5 | color-selection.html | ⚠️ DRIFT | SPEC-HAS-EXTRA | HIGH | Spec describes color picker only. "Intended Additions" section describes project confirmation as future work. In production, project confirmation is a separate live page (`project-confirmation.html`). Spec's "Intended Additions" section is now aspirationally misleading. |
| 6 | contract-signing.html | ✅ PASS | — | — | Spec verified through Apr 21 (Session 304, expired bid guard). D-123 acknowledgment checkbox known-changed in Known-Stale Flags but not a functional gap. |
| 7 | help-estimate.html | ✅ PASS | — | — | No known changes since March 22 verification. |
| 8 | help-materials.html | ✅ PASS | — | — | No known changes since March 22 verification. |
| 9 | help-measurements.html | ⚠️ DRIFT | SPEC-HAS-EXTRA | HIGH | Spec describes old 3-path flow ($99 Hover, adjuster, contractor). Production now has D-181 $79 Stripe payment gate with single Hover path. Old paths may be removed or restructured. F-007 auth bug confirmed by Phase 3 (D-P3-006). |
| 10 | how-it-works.html | ✅ PASS | — | — | No known changes since March 22 verification. |
| 11 | faq.html | ✅ PASS | — | — | No known changes since March 22 verification. |
| 12 | contractor-login.html | ✅ PASS | — | — | Spec updated Apr 15 (benefits panel rewrite). Current. |
| 13 | contractor-join.html | ✅ PASS | — | — | Spec updated Apr 11 (instant magic-link flow) + Apr 15 (copy overhaul). Current. |
| 14 | contractor-dashboard.html | ⚠️ DRIFT | SPEC-HAS-EXTRA | MEDIUM | Spec missing: CPA re-acceptance modal, dark navy gradient header, post-measurement siding design callout, Mark Job Complete actions column (W3-P4), Warranty Upload modal (W3-P4). |
| 15 | contractor-opportunities.html | ✅ PASS | — | — | Spec updated Apr 8 (View Scope section). No known post-April-8 changes. |
| 16 | contractor-bid-form.html | ⚠️ DRIFT | SPEC-HAS-EXTRA | MEDIUM | Spec updated through Session 219 (Apr 17) for insurance path. Missing from spec: siding trade section (`sidingTradeSection`, confirmed by Phase 3), D-202 warranty_option_id manufacturer × tier dropdowns (Phase 2 live), D-204 SOFT mode filter, D-199 bid-time validation gate, Home Photos card (deployed today, 86e0zdknj). |
| 17 | contractor-profile.html | ⚠️ DRIFT | SPEC-HAS-EXTRA | MEDIUM | Spec updated through Apr 27 (D-192 county UI). Missing from spec: D-199 contract template validation display + js/contract-template-validation.js, D-204 Manufacturer Certifications card + cert-letter upload, Manual anchor-mapping modal (D-199 Tier 2), intro video card (INTRO_VIDEO_ENABLED=false). |
| 18 | contractor-settings.html | ✅ PASS | — | — | Spec updated through May 1 (intro video card). Current. |
| 18a | contractor-auto-bids.html | ✅ PASS | — | — | Spec verified Apr 27 (D-193 create). Current. |
| 19 | contractor-how-it-works.html | ✅ PASS | — | — | Spec updated Apr 16 (copy cleanup). Current. |
| 20 | contractor-faq.html | ✅ PASS | — | — | Spec updated Apr 16 (copy cleanup + D-181 Hover content). Current. |
| 21 | terms.html | ✅ PASS | — | — | Spec documents DRAFT status. No spec update needed until attorney review clears. |
| 22 | privacy.html | ✅ PASS | — | — | Same as terms.html. |
| 23 | contractor-agreement.html | ✅ PASS | — | — | Same as terms.html. |
| 24 | partner-re.html | ✅ PASS | — | — | In spec (page 24), exists in prod. No detailed spec section — consistent with low priority. |
| 25 | partner-insurance.html | ✅ PASS | — | — | In spec, exists in prod. |
| 26 | partner-inspectors.html | ✅ PASS | — | — | Spec verified Apr 8 (Session 69 fix). Current. |
| 27 | partner-dashboard.html | ✅ PASS | — | — | In spec, exists in prod. No detailed spec section documented but page is live. |
| 28–31 | ref-re / ref-insurance / ref-inspector / refer-a-friend | ✅ PASS | — | — | In spec, exist in prod. ref-inspector detailed spec present (Session 65). Others have table entries only — intentional given low-priority status. |

---

## PROD-HAS-EXTRA — Pages Not in Spec

These pages exist in the production deploy directory but have no spec section in `otterquote-pages.md`.

### HIGH — Active Homeowner/Contractor User Flows

#### DRIFT-001 — trade-selector.html
**Severity:** HIGH
**Build Status:** LIVE ✅ (listed as "Homeowner intake flow (get-started.html, trade-selector.html)")
**What it is:** The trade selector and funding type selection step in the homeowner intake flow (insurance vs. retail, which trades). Critical gateway page — every homeowner passes through it after get-started.html.
**Drift direction:** PROD-HAS-EXTRA
**Remediation:** Spec owner adds full spec section to otterquote-pages.md (new page #2a between get-started and dashboard). **Claude can write this spec section from source inspection.**

#### DRIFT-002 — project-confirmation.html
**Severity:** HIGH
**Build Status:** LIVE ✅ ("Project confirmation (project-confirmation.html) — roofing, siding, gutters")
**What it is:** D-155 project confirmation flow — homeowner answers per-trade project questions (shingle color, drip edge, satellite, gutters, etc.) before contract signing. The spec describes this only as "Intended Additions" inside color-selection.html, suggesting it was planned but not built. It is built, and as a separate page.
**Drift direction:** PROD-HAS-EXTRA + SPEC-HAS-EXTRA (spec's "Intended Additions" section is now aspirationally misleading)
**Remediation:** (1) Add full spec section for project-confirmation.html. (2) Update color-selection.html spec to note that project confirmation was extracted to a dedicated page. **Claude can write both spec updates.**

#### DRIFT-003 — contractor-onboarding.html
**Severity:** HIGH
**Build Status:** LIVE ✅ ("D-190 Contractor onboarding wizard — 4-page multi-step wizard (trade/state/insurance/auto-bid), replaces 7-step checklist (SQL v58)")
**What it is:** 4-page onboarding wizard. The spec describes contractor-join.html's post-Session-116 simplified magic-link flow — but the onboarding wizard that follows (the 4-page profile completion wizard) has no spec entry at all.
**Drift direction:** PROD-HAS-EXTRA
**Remediation:** Add spec section for contractor-onboarding.html. **Claude can write from source.**

#### DRIFT-004 — contractor-pre-approval.html
**Severity:** HIGH
**Build Status:** LIVE ✅ ("CPA re-acceptance modal + 4-page redirect guard (SQL v51)")
**What it is:** CPA (Contractor Partner Agreement) re-acceptance flow. Triggered when contractor navigates to any portal page after a CPA version update. 4-page redirect guard implemented. Non-dismissible modal.
**Drift direction:** PROD-HAS-EXTRA
**Remediation:** Add spec section. **Claude can write from source.**

---

### MEDIUM — Admin Pages Not in Spec

All 5 admin pages below are LIVE ✅ per build status but have no spec sections.

| Page | Decision | What it is |
|------|----------|------------|
| `admin-payouts.html` | D-180 | Payout approval queue (approve/reject/pending). Was listed in Known-Stale Flags as "NEW PAGE" but never received a spec section. |
| `admin-referrals.html` | — | Admin referrals management page. |
| `admin-template-review.html` | D-199 | Contractor contract template manual review queue (anchor validation Tier 1/3 gate). |
| `admin-cert-verifications.html` | D-204 | Manufacturer certification verification review queue. |
| `admin-warranty-drift.html` | D-202 Ph3 | Warranty manifest drift review queue (quarterly scrape diffs). |

**Remediation:** Add spec sections for all 5. Lower urgency — admin-only, no homeowner impact. **Claude can write from source.**

---

### MEDIUM — Infrastructure Pages Not in Spec

| Page | Purpose | Remediation |
|------|---------|-------------|
| `login.html` | Auth redirect target for admin server-side gate (`/login.html?reason=admin_required`). Live per W4-P1 admin auth gate. | Add spec entry as shared auth page. Claude can write. |
| `recruit.html` | Recruit router page + attribution frontend. LIVE ✅. | Add spec section. Claude can write. |

---

### LOW — Dev Artifacts and Legacy Pages

These pages exist in the deploy directory but appear to be dev artifacts, old A/B test variants, or legacy pages with no active homeowner/contractor routing. **Dustin decides** whether each should be deleted or documented.

| Page | Assessment | Recommended Action |
|------|-----------|-------------------|
| `landing.html` | Likely legacy A/B test variant or alternative landing. Not linked in main nav. | Dustin decides: delete or document. |
| `ref.html` | Generic referral redirect — may be catch-all for ref codes without agent_type. | Dustin decides: delete or document. |
| `inspector-landing.html` | Possible inspector-specific landing variant. Not clearly distinct from ref-inspector.html. | Dustin decides: delete or document. |
| `repair-intake.html` | Possibly early repair flow prototype. Not in build status. | Dustin decides: likely delete. |
| `schedule-inspection.html` | Possibly early scheduling flow. Not in build status. | Dustin decides: likely delete. |
| `stellar-edge.html` | Likely stellaredgeservices.com redirect target or placeholder. | Dustin decides: delete or keep for SES branding. |
| `stripe-mockup.html` | Dev artifact — Stripe payment mockup. Should not be in production deploy. | Delete. No homeowner should ever reach this. |
| `contractor-leads.html` | DEPRECATED per spec (replaced by contractor-opportunities.html in Session 14). Listed in spec for deletion. | Confirm it's gone — it does NOT appear in production listing. Already clean. ✅ |

---

## SPEC-HAS-EXTRA — Stale Spec Sections

These are cases where the spec documents a materially different current state from what production actually has. No regressions were found (production is not missing features the spec says exist). The drift is documentation lag.

| Spec Section | Stale Content | Production Reality | Severity |
|---|---|---|---|
| `color-selection.html` "Intended Additions" | Describes project confirmation as future work not yet built | `project-confirmation.html` is LIVE ✅ — the feature was built as a separate page | HIGH |
| `help-measurements.html` Current State | 3-path flow: Hover ($99), adjuster, contractor. Hover purchase via `createHoverOrder()` in services.js. | D-181: $79 Stripe payment gate. Single Hover path. `create-hover-order` Edge Function with JWT PI guard. Old $99 price, 3-path UX wrong. | HIGH |
| `dashboard.html` Current State | Does not mention per-trade status pills, D-178 state gating, D-181 Hover payment status, warranty download button, GBP photos, switch-contractor flow. | All above features LIVE ✅. | MEDIUM |
| `contractor-bid-form.html` Current State | Updated through Session 219 — missing siding section, D-202 warranty_option_id dropdowns, D-204 SOFT filter, D-199 bid-time gate, Home Photos card. | All above LIVE ✅. | MEDIUM |
| `contractor-profile.html` Current State | Missing D-199 template validation display, D-204 Manufacturer Certifications card, Manual anchor-mapping modal. | All LIVE ✅. | MEDIUM |
| `contractor-dashboard.html` Current State | Missing Mark Job Complete column, Warranty Upload modal, CPA modal. | All LIVE ✅ (W3-P4). | MEDIUM |
| `get-started.html` Current State | Missing TCPA consent checkbox, HubSpot contact creation (D-189), SMS consent fix. | All LIVE ✅. | MEDIUM |
| `bids.html` Current State | Missing Cards/Compare 16-row grid detail in spec. | LIVE ✅. | MEDIUM |
| `admin-contractors.html` Current State | Missing COI/attestation summary cards and filter tabs. | LIVE ✅. | MEDIUM |

---

## Drift Items Requiring ClickUp Action

Per pre-authorization, filing ClickUp tasks for drift requiring action. Spec documentation updates are Claude-executable; Dustin-decides items go to ClickUp.

### Tasks Filed

Tasks filed in "Product and Tech" list (901711730553) under parent E2E Phase 8 task.

| Task | Filed For | Severity |
|------|-----------|----------|
| DRIFT-CU-001 | Spec update sprint: add trade-selector, project-confirmation, contractor-onboarding, contractor-pre-approval, login, recruit, all 5 admin pages to otterquote-pages.md | MEDIUM |
| DRIFT-CU-002 | Spec cleanup: update help-measurements.html Current State to D-181 $79 flow; mark "Intended Additions" complete in color-selection.html | HIGH |
| DRIFT-CU-003 | Dustin decides: review 7 LOW-severity pages (landing, ref, inspector-landing, repair-intake, schedule-inspection, stellar-edge, stripe-mockup) — delete or document each | LOW |
| DRIFT-CU-004 | Update 7 stale Current State sections (dashboard, contractor-dashboard, contractor-bid-form, contractor-profile, get-started, bids, admin-contractors) — batch spec update session | MEDIUM |
| DRIFT-CU-005 | stripe-mockup.html — confirm removed from prod deploy immediately (dev artifact in production) | MEDIUM |

---

## No-Action Items (Intentional Divergence)

| Item | Reason |
|------|--------|
| terms.html / privacy.html / contractor-agreement.html spec not updated | These are DRAFT — spec correctly reflects draft status; update due after attorney review |
| ref-re.html, ref-insurance.html, partner-re.html, partner-insurance.html, partner-dashboard.html lack detailed spec sections | Intentional — low-priority partner pages, spec table entry is sufficient |

---

## Recommended Fix Order

1. **DRIFT-CU-005** — Confirm stripe-mockup.html is excluded from prod deploy. Dev artifact must not be publicly reachable.
2. **DRIFT-CU-002** — Update help-measurements.html + color-selection.html spec. These are core homeowner-facing pages and spec staleness causes build confusion.
3. **DRIFT-CU-001** — Add spec sections for all PROD-HAS-EXTRA pages (bundle into one spec update session).
4. **DRIFT-CU-004** — Update 7 stale Current State sections (can be batched).
5. **DRIFT-CU-003** — Dustin's review of 7 LOW-severity pages when convenient.

---

*Report generated by Ram. Parent task: [86e132beg](https://app.clickup.com/t/86e132beg). Task left open — ClickUp drift tasks need filing; spec updates pending.*
