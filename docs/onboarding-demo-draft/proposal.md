# Onboarding Demo — Approach Proposal

**Task:** 86e0x469m  
**Date:** May 1, 2026  
**Status:** Draft for Dustin review — no production changes made

---

## Problem Statement

A contractor completes the four-page onboarding wizard, gets approved, and logs in for the first time. They see an empty opportunities list. No opportunity cards, no bid history, no sense of what a contract package looks like. The platform they just invested time joining has nothing to show them.

This is a confidence problem, not a technical problem. The contractor's internal question is: "Will this actually work for me?" An empty dashboard answers that question poorly. Every day between approval and their first real opportunity is a window for them to mentally disengage.

The specific gaps today:
- No opportunity card — they don't know what city, trade scope, damage type, or estimated value looks like in practice
- No bid form context — they don't know what fields auto-populate from the claim, what the warranty builder looks like, or how the fee calculator works
- No Hover summary — they can't see what a design summary or material list looks like before they have to trust one for a real bid
- No SOW preview — they've never seen how their contract template comes back as a completed document

The goal of demo content is not to simulate the full lifecycle — it is to answer the question "what happens next?" before real work arrives.

---

## Option Comparison

### Option A — Static Demo Mode
A dedicated `/onboarding-demo` route (or a modal overlay on the empty opportunities page) that renders hardcoded sample data using the same UI components as real opportunities. No database reads or writes for the demo content itself. A single page or tabbed view walks through: opportunity card → opportunity detail → bid form (pre-filled, non-submittable) → sample Hover summary → sample contract package.

| | |
|---|---|
| **Pros** | Zero DB risk. Zero leak risk. Zero Stripe/DocuSign exposure. Fast to build. No ongoing guard work as features evolve. Can ship this week. Visually identical to real content. |
| **Cons** | Not interactive — contractor cannot actually submit a bid. The bid form fields are pre-filled but read-only, which some contractors will notice. |
| **Build complexity** | Low — 1 to 2 days of frontend work. No schema changes, no Edge Function changes, no Stripe/DocuSign bypass logic needed. |
| **Ongoing maintenance** | Low — update the static data file when UI components change. One-time effort when new trade flows launch. |
| **Leak risk** | Zero — there is nothing in the database to leak. |

---

### Option B — Real Test Claims with `is_demo` Flag
A set of real claim and quote records inserted into the production database, flagged with an `is_demo = true` column. Contractors approved within the past 7 days (or with zero bids submitted) see these demo records in their opportunities list. They can actually submit a bid, which writes a real quote row (also flagged `is_demo = true`). DocuSign and Stripe are bypassed for `is_demo` flows.

| | |
|---|---|
| **Pros** | Fully interactive — contractor goes through the real bid form, experiences real auto-population, submits a real bid. Closest to the actual workflow. |
| **Cons** | Every table that touches claims or quotes must filter `is_demo = false` in production queries. Every new Edge Function, cron job, and admin report must be written with this filter or demo data pollutes real analytics, dunning queues, payout triggers, and DocuSign usage counts. That is a permanent maintenance tax. |
| **Build complexity** | High — schema migration (add `is_demo` to claims, quotes, possibly documents, hover_orders), RLS policy updates for 3–4 tables, DocuSign bypass in `create-docusign-envelope`, Stripe bypass in `create-payment-intent`, cron guard in `process-bid-expirations`, `process-dunning`, `process-coi-reminders`, and payout logic. Minimum 5–8 days across backend and frontend. |
| **Ongoing maintenance** | High — every future feature touching claims or quotes must handle `is_demo`. This is easy to forget. The blast radius of missing one filter is real (e.g., a demo bid triggering a Stripe dunning cycle). |
| **Leak risk** | Medium to high. Any query that forgets `is_demo = false` will surface demo records in the wrong context. The risk compounds as the codebase grows. |

---

### Option C — Hybrid (Static Walkthrough + Live Bid Submission)
Static screens for opportunity detail, Hover summary, and contract package preview — but a live, submittable bid form backed by a real sandbox claim record in the database. The demo claim is flagged and isolated, but the bid form submission writes a real quote row so contractors experience the actual form flow. DocuSign and Stripe are bypassed on the demo claim only. The bid is immediately voided after submission (or cleaned up on a nightly cron).

| | |
|---|---|
| **Pros** | The one interaction contractors most want — actually filling out and submitting a bid — is live and real. Everything else (opportunity card, Hover summary, contract preview) is static and safe. Scoped leak risk. |
| **Cons** | Still requires an `is_demo` flag and associated guards (DocuSign bypass, Stripe bypass, cron exclusion), just for one interaction path instead of the full lifecycle. Slightly more complex than Option A without delivering a dramatically different experience. |
| **Build complexity** | Medium — 3 to 4 days. Schema: `is_demo` on claims and quotes. DocuSign bypass in `create-docusign-envelope`. Stripe bypass in bid submission path. Nightly demo-bid cleanup cron or auto-void on submission. Frontend changes to show static screens for non-bid interactions. |
| **Ongoing maintenance** | Medium — fewer guard points than Option B, but still a permanent `is_demo` filter requirement on any query touching the live bid submission path. |
| **Leak risk** | Low — scoped to the bid submission flow. Still nonzero. |

---

## CTO Recommendation: Option A

Ship Option A now. Upgrade to Option C in Phase 2.

**Reasoning:** The confidence gap is solved by showing, not by doing. A contractor who sees a realistic opportunity card (Fishers, IN — insurance roofing — $24,840 RCV — GAF Timberline HDZ), a fully rendered bid form with the right fields, a Hover design summary with real measurements and a material list, and a sample SOW PDF walks away understanding the platform. The incremental value of making the bid form *submittable* on a demo record is smaller than it appears — what the contractor learns is the same either way, and the operational cost of maintaining `is_demo` guards is permanent.

Option B should not be built. The maintenance tax is too high for a pre-revenue product where every engineering hour needs to go toward real features.

Option C is the right Phase 2 path. Once we have real contractor feedback on Option A — specifically, whether contractors feel the read-only bid form is confusing or unsatisfying — we can decide whether to invest in live interactivity. Building it speculatively before we have that signal is premature.

**Ship sequence:**
1. Option A: Static demo on `/onboarding-demo` route. Link from empty opportunities state. Banner: "These are sample opportunities. When real homeowners are matched to your service area, they'll appear here automatically."
2. Gather feedback from first 10–20 approved contractors.
3. Decide whether to invest in Option C based on that feedback.

---

## Open Questions for Dustin

**Q1 — Visibility window:** Should the demo route be visible indefinitely (always accessible from a Help or How It Works link), or only during the "empty dashboard" state (disappears once the contractor has at least one real opportunity)?

**Q2 — Bid form interactivity:** The static demo shows a pre-filled bid form the contractor can read through but not submit. If initial feedback from contractors is that they want to "try" submitting, are you willing to invest the additional build time for Option C (3–4 days plus ongoing maintenance), or would you prefer to address that through the How It Works page or a guided video?

**Q3 — Trade scope of demo:** The current sample set is one insurance roofing claim, one retail siding claim, and one retail gutters claim. Should the demo also include a multi-trade claim (e.g., roofing + gutters) to show contractors how bundled bidding works, or is three separate claims sufficient for Phase 1?
