SENTINEL: CEO70-MINUS2-SPECS-20260925-SENTINEL
# CEO RUN 70 — overnight -2 funnel specs + build briefs (DRAFT, unticked)

**Owner:** Sloane (CRO), subagent dispatch. **Claim:** `ceo-2026-09-25T16:14:44Z`. **Authorization:** #2153 comment 5841277730 — all four -1 funnels (HO-1 #2121, RE-1 #2150, INS-1 #2151, HI-1 #2152) are blocked only on Dustin items, so each line's -2 funnel may BUILD its dark -2 funnel tonight: no spend, no new customer-facing copy live.

No boxes ticked. No issues created. No experiment-log.md write (rows are under LINES FOR REGISTERS below, for Ben to place). All four are Meta instant-form / lead-gen funnels feeding the shared `meta-leadgen-webhook` (P-5), still open on #2150's FOUNDATION block — none of the four can actually launch until P-5 is built and Dustin approves copy.

## Comments posted

| Line | Funnel | Issue | Comment |
|---|---|---|---|
| Homeowners | HO-2 · Meta instant form | #2121 | https://github.com/StellarEdgeServices/otterquote-platform/issues/2121#issuecomment-5841334055 |
| Realtors | RE-2 · Meta instant form | #2150 | https://github.com/StellarEdgeServices/otterquote-platform/issues/2150#issuecomment-5841321303 |
| Insurance agents | INS-2 · Meta instant form | #2151 | https://github.com/StellarEdgeServices/otterquote-platform/issues/2151#issuecomment-5841326871 |
| Home inspectors | HI-2 · Meta instant form | #2152 | https://github.com/StellarEdgeServices/otterquote-platform/issues/2152#issuecomment-5841340188 |

## Per-funnel summary

- **HO-2:** Meta lead form as the "Higher Intent" arm (plan §5 row 1.2, #2123). Same Arm F offer/creative, no new pricing. Kill: 150 form opens/$300 with 0 submissions. Falls under the homeowner $1,200/$1,500-month budget schedule, not the partner $300/$600/$1,800 structure. Gated on P-5 + D-332/D-322 lead-form privacy coverage confirmation.
- **RE-2:** Meta lead form, same $200 referral-fee offer (D-301/D-305) and D-266 disclaimer as RE-1. Kill: 150 form opens/$300 with 0 submissions. Meta $300 per-funnel cap inside the realtor line's $1,800 cap. Gated on P-5.
- **INS-2:** Meta lead form, same retention offer + $200 fee/D-266 disclaimer as INS-1. Same kill/promote and cap structure as RE-2. Gated on P-5.
- **HI-2:** Meta lead form, **no fee/bonus/$ words anywhere** — copy checked against HI-0's own grep pattern before writing. No disclaimer field needed (nothing to disclose). Gated on P-5 **and** HI-0.5, which is currently CLOSE-REVIEW: FAIL on #2152 (comment 5838422299) — same gate that blocks HI-1 blocks HI-2 too; this is called out explicitly in both the spec and the build brief so Kevin doesn't build an invite/confirmation path that dodges the open HI-0.5 leak.

## What Kevin can build dark before Dustin approves copy

`meta-leadgen-webhook` is one shared build (P-5) — build it once against RE-2's brief, then HO-2/INS-2/HI-2 each add only their own field mapping (`p_agent_type`/table target), `p_funnel_id`, and the invite-copy hookup. All four reuse existing infrastructure: `register_partner` (partner lines) or the existing homeowner lead-insert path (HO-2, different table/shape — uses `is_synthetic` not `is_test`), P-1's short-signup form, P-2's attribution columns (lead id in place of click id per S14), P-3's alert, and each line's existing GA4 `partner_signup_complete`/conversion event (tagged with the new funnel id, no new event). None of the four builds a page (S05/S06/S07/S08/S12 are all N/A — native lead forms). None flips P-4's send switch on. HI-2 additionally must not build a second link into `partner-app.html`/`partner-dashboard.html` that would add to, or dodge, the HI-0.5 leak still open on HI-1.

## LINES FOR REGISTERS (Ben places these in `Claude's Memories/experiment-log.md`, not written by this report)

```
## EXP-HO2 — HO-2, Meta instant form, "Higher Intent" arm (D-333), opened 2026-09-25 (#2121, CEO RUN 70 overnight DRAFT)
Hypothesis: a native Meta lead form converts homeowners who won't complete Arm F's page flow but will tap through Meta's pre-filled form; same offer/creative as Arm F, only the front door changes. Audience: same as HO-1 (Indiana storm/roof damage homeowners), Meta. Mechanism: Meta instant form -> meta-leadgen-webhook (P-5) -> leads row + alert + follow-up. Kill: 150 form opens or $300 spent with 0 submissions. Promote: >=3 leads in <=150 opens plus a goal event, or 2x Arm F (#1593 comment 5798151703). Tracking: #2121 (#2123). Gated on P-5 (open, #2150) and Dustin's copy approval. MARKER-EXP-HO2

## EXP-RE2 — RE-2, Meta instant form (D-333), opened 2026-09-25 (#2150, CEO RUN 70 overnight DRAFT)
Hypothesis: a native Meta lead form isolates form-friction from RE-1's page-vs-angle variable; same offer as RE-1 ($200 referral fee, D-301/D-305). Audience: Indiana realtors, Meta. Mechanism: Meta instant form -> meta-leadgen-webhook (P-5) -> referral_agents row + invite. Kill: 150 form opens or $300 spent with 0 submissions. Promote: >=3 signups in <=150 opens AND >=1 activation. Tracking: #2150. Gated on P-5 (foundation, open) and Dustin's copy approval. MARKER-EXP-RE2

## EXP-INS2 — INS-2, Meta instant form (D-333), opened 2026-09-25 (#2151, CEO RUN 70 overnight DRAFT)
Hypothesis: a native Meta lead form isolates form-friction from INS-1's page-vs-angle test; same retention offer as INS-1 ($200 referral fee, D-301/D-305). Audience: Indiana P&C insurance agents, Meta. Mechanism: Meta instant form -> meta-leadgen-webhook (P-5) -> referral_agents row + invite. Kill: 150 form opens or $300 spent with 0 submissions. Promote: >=3 signups in <=150 opens AND >=1 activation. Tracking: #2151. Gated on P-5 (foundation, open on #2150) and Dustin's copy approval. MARKER-EXP-INS2

## EXP-HI2 — HI-2, Meta instant form, no-fee (D-333), opened 2026-09-25 (#2152, CEO RUN 70 overnight DRAFT)
Hypothesis: a native Meta lead form isolates form-friction from HI-1's page-vs-angle test; same no-fee, report-insert offer as HI-1 (D-333: no referral fee or recruit bonus to inspectors). Audience: Indiana home inspectors, Meta. Mechanism: Meta instant form -> meta-leadgen-webhook (P-5) -> referral_agents row + invite. Kill: 150 form opens or $300 spent with 0 submissions. Promote: >=3 signups in <=150 opens AND >=1 activation. Tracking: #2152. Gated on P-5 (open, #2150), HI-0 (this issue, HI-0.5 CLOSE-REVIEW: FAIL 5838422299) and Dustin's copy approval. MARKER-EXP-HI2
```
