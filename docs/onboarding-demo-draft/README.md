# Onboarding Demo — Draft Folder

**Task:** ClickUp 86e0x469m  
**Status:** Draft — awaiting Dustin review. No production changes made.  
**Date:** May 1, 2026  
**Author:** Ram (AI technical co-founder)

---

## What's in this folder

| File | What it is |
|---|---|
| [proposal.md](proposal.md) | Approach memo — problem statement, 3 implementation options compared side by side, CTO recommendation, and 3 open questions for Dustin |
| [sample-claims.md](sample-claims.md) | 4 fully fleshed-out sample opportunity cards: insurance roofing (Tower Hill, Fishers IN), retail siding (LP SmartSide, Carmel IN), retail gutters (5" K-style, Noblesville IN), multi-trade insurance roofing+gutters (Liberty Mutual, Greenwood IN). Includes loss sheet summaries, Hover measurement summaries, material lists, and expected bid ranges. |
| [demo-script.md](demo-script.md) | 6-step contractor-facing copy for the onboarding walkthrough. Written in D-167/D-175 brand voice. Uses "Otter Quotes" (two words), "opportunities," and "signed contracts" per D-191. Includes pre-launch acknowledgment banner copy. |

---

## CTO Recommendation (summary)

**Ship Option A: Static demo route, no database.** A dedicated `/onboarding-demo` route renders hardcoded sample data using real UI components. Zero DB risk, zero Stripe/DocuSign exposure, 1–2 days of frontend build time, no ongoing maintenance tax. The primary goal — contractor confidence before first real opportunity — is solved by showing, not by doing. A polished static demo answers the "will this work for me?" question without the operational cost of an `is_demo` flag on every production query.

**Option B (real test claims in production DB) should not be built.** The maintenance tax is permanent and the risk of demo data leaking into dunning, payout, and analytics flows is real.

**Option C (hybrid with live bid submission) is the right Phase 2 path** once Option A ships and we have contractor feedback on whether read-only bid form experience is sufficient.

---

## Decisions locked — May 1, 2026

| Question | Decision |
|---|---|
| Implementation approach | Option A — static demo route, no DB |
| Visibility window | Disappears once contractor has ≥1 real opportunity; permanent link in How It Works |
| Bid form | Read-only pre-fill |
| Sample set | 4 claims — insurance roofing, retail siding, retail gutters, multi-trade roofing+gutters |

## Where do we go from here

Build task created: **ClickUp 86e16d8hm** — "Build static onboarding demo route — /onboarding-demo"

The build task has a full checklist. Key points:

- Create `onboarding-demo.html` using sample data from `sample-claims.md` and copy from `demo-script.md`
- 4 opportunity cards with detail views (static show/hide)
- Bid form: pre-filled read-only; multi-trade wizard pre-fill for Sample 4 (roofing+gutters bundled)
- Link from `contractor-opportunities.html` empty state; hide once ≥1 real opportunity exists
- No schema changes, no Edge Function changes, no Stripe or DocuSign impact
- Deployment tier: Tier 1 — deploy autonomously after checklist + smoke tests
- Estimated build time: 1–2 days
