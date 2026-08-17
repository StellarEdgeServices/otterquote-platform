# D-274 — Contractor Template Re-Tagging Plan (BoldSign Cutover)

**Status:** Plan only. Not executed. No contractor has been contacted about this.
**Blocked on:** #631 production cutover approval (Dustin), which is itself blocked on the BoldSign 403 diagnosis (support ticket, not filed by this lane — see #631).
**Written by:** run-work Code session `rw-f22-20260815T184427-584d`, item 3 sub-task 4, in response to PR #797's "Known gaps — read before merging" item 1.

## Why this exists

PR #797 (open, not merged) rewrites `create-docusign-envelope` to use BoldSign instead of DocuSign. BoldSign has no equivalent to DocuSign's flexible anchor-string matching (`/Customer/`, `Contract Price:`, etc. — see `Docs/contract-template-anchors.md`, the current contractor-facing spec). BoldSign's only API-placeable field mechanism is a literal bracket **Text Tag** baked into the PDF as its own contiguous run of text:

```
{{FieldType|SignerIndex|Required|Label|FieldID}}
```

Example, from PR #797's `validate-contract-template/index.ts` v3 manifest:
`{{sign|2|*|Homeowner Signature|homeowner_signature}}`, `{{text|1|*|Contract Price|contract_price}}`.

Every contractor-uploaded template validated under the current DocuSign anchor scheme will **fail to place any fields at all** under BoldSign until it is re-tagged with this syntax. This is real operational lift, not a code fix — it cannot be automated away, because it requires literally editing each contractor's PDF.

## Scope, verified live (2026-08-15)

```sql
SELECT trade, funding_type, status, count(*) FROM contractor_templates GROUP BY 1,2,3;
```

| Trade | Funding | Status | Count |
|---|---|---|---|
| roofing | insurance | auto_validated | 2 |
| roofing | retail | auto_validated | 4 |
| roofing | retail | manual_validated | 1 |
| siding | insurance | auto_validated | 1 |
| siding | retail | auto_validated | 1 |

**9 templates total, across 6 distinct contractors** (`SELECT count(distinct contractor_id)`). Small enough to handle as a tracked, finite punch list rather than a mass campaign — this is not a launch blocker in scale, only in sequencing (it gates the BoldSign cutover itself, which is why it's on the critical path per #631).

No insurance/roofing template is `manual_validated` — all but one of the 9 auto-passed the current anchor scan. That has no bearing on BoldSign readiness; auto- vs manual-validated only describes how the *current* DocuSign anchor check was satisfied.

## Target manifest (from PR #797, v3, unmerged)

Four trade/funding-type manifests exist, each listing the exact Text Tags a contractor's PDF must contain. Signer index is **positional, not named** — `contractor_sign`'s fixed signer order is 1 = contractor, 2 = homeowner (flagged as a fragile coupling in the v3 manifest's own header comment; do not reorder without updating both sides together).

**Re-verified 2026-08-17 against PR #797 @ `6d6fc9f` directly (counted `mechanism: "boldsign_tag"` entries in each `required` array, per-manifest) — all four rows below are now independently re-derived, not paraphrased. `roofing/insurance` corrects a transcription error in the original table (was 13, is actually 12 — the manifest's own `requiredCount` field of 14 includes the 2 `label_text` rows, which was miscounted the first time this table was written).**

| Manifest | Tag count | Notes |
|---|---|---|
| roofing/retail | 11 | no insurance-specific tags |
| roofing/insurance | 12 | adds `insurance_company`, `claim_number`, `deductible` (was misstated as 13 — corrected 2026-08-17) |
| siding/retail | 9 | corrected from "~10" — verified directly |
| siding/insurance | 10 | corrected from "~12" — verified directly |

Two manifest rows (`Manufacturer's Warranty:`, `Workmanship Warranty:`) stay `mechanism: "label_text"`, not a Text Tag — those are populated by D-202's own logic downstream, not by BoldSign field placement. Don't tag those two. Siding also has two additional `label_text` rows beyond those two — `Siding Product:` and `Wall Substrate:` — so siding's `requiredCount` (13 retail / 14 insurance) is 4 higher than its Text Tag count, not 2 higher like roofing.

## Execution plan (once #631 clears its production-cutover gate)

**Phase 0 — Preconditions (not this lane's job to start without a green light):**
1. #631's BoldSign 403 diagnosis resolved (support ticket response).
2. PR #797 merged, or its relevant pieces cherry-picked to main.
3. `validate-contract-template` v3 (the BoldSign-tag validator) live — this is the tool that will confirm a re-tagged PDF actually validates, so it must exist before contractor communication goes out. It already exists in PR #797; just needs to ship first.

**Phase 1 — Internal dry run (no contractor contact):**
1. Pick the 1 `manual_validated` roofing/retail template (already known to need a human's attention once before) as the pilot.
2. Manually re-tag a **copy** of that PDF with the correct Text Tags for its trade/funding manifest.
3. Run it through `validate-contract-template` (v3) to confirm it passes.
4. Send-test through a BoldSign sandbox envelope (not production) to confirm the tags actually place fields where expected — this catches label/positioning mistakes before any contractor sees the process.

**Phase 2 — Contractor-facing spec:**
1. Write the BoldSign successor to `Docs/contract-template-anchors.md` — same document shape, new tag syntax, one table per trade/funding-type pulled directly from the v3 manifest (do not hand-transcribe; script-generate from the manifest constant so the two can never drift, unlike the current anchor doc which is hand-maintained separately from the validator).
2. This is contractor-facing product copy. Per the authority model, drafting it is fine; **sending it or publishing it is not this lane's call** — flag to Dustin/CEO board before it goes out, same as any contractor communication.

**Phase 3 — Rollout to the 6 contractors, 9 templates:**
1. Contact each contractor (in-app notification + email — existing pattern, see `notify-admin-new-contractor`/`send-support-email` for precedent) with the new spec and a request to re-upload.
2. Track via `contractor_templates.status` — add a transitional status or reuse existing fields to distinguish "re-tagged for BoldSign" from "still DocuSign-anchor-only," so the cutover doesn't have to be all-or-nothing. (Needs a small additive migration — Tier 3A, out of scope for this plan document itself.)
3. Old DocuSign anchor-tagged PDFs remain valid until each contractor re-uploads — no forced downtime for an individual contractor, but the platform-wide BoldSign cutover can't complete until all 9 are done or the remaining holdouts are otherwise handled (fallback envelope path, or a hard deadline — a business call, not this document's to make).

## What this document is NOT

- Not a decision to cut over to BoldSign — that's #631's call, still open.
- Not contractor communication — nothing here has been sent to anyone.
- Not a migration — Phase 3 step 2's status-tracking column is flagged but not written.
- The siding manifest tag counts (and the roofing/insurance correction) above are now independently re-derived against PR #797 directly, not paraphrased — no outstanding count-verification gap remains on this document. Phase 0's other two preconditions (BoldSign 403 diagnosis, PR #797 merge) are unaffected and still open.
