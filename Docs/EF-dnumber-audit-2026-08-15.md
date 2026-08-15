# EF D-Number Audit — 2026-08-15 (GitHub #748)

**Produced by:** run-work worker rw-e7c2-w12
**Live inventory source:** Supabase `list_edge_functions` on production project `yeszghaspzwwstvsrioa`, run 2026-08-15. **Current N = 55 deployed Edge Functions** (enumerated below, 55 of 55).
**Registry sources swept (read-only):**
1. `Claude's Memories/otterquote-ref-platform.md` — Implementation Index (R-009), the canonical D-number → locator registry (read 2026-08-15).
2. `Claude's Memories/exec-cto-memory.md` — EF table (55-row inventory; notes column carries some D-linkages) (read 2026-08-15).
3. `Claude's Memories/otterquote-D-registry.md` — D-number decision registry (read 2026-08-15).
4. Repo `Docs/` (grep for `D-[0-9]{3}`) and each EF's `supabase/functions/<slug>/index.ts` header (first 30 lines) for self-declared parent decisions.

## Reconciliation vs the issue's count

Issue #748 (data from 2026-07-12) said "55 deployed / 14 documented / 41 undocumented." Reconciliation: the issue's documented (15 names) + undocumented (40 names) lists contain **54 unique** slugs — `mark-job-complete` appears in both lists, explaining the 55-vs-54 discrepancy. Today's live 55 = those 54 + `get-payout-completion-status` (deployed 2026-07-24, after the issue's data was gathered). Additionally `d274-boldsign-e2e-test` was deployed and then **deleted 2026-08-15** (BoldSign E2E scaffolding), so it appears in neither roster. `hover-oauth-init` never existed (already corrected in the issue).

## Status definitions

- **documented** — the EF is explicitly named in an Implementation Index D-number row (otterquote-ref-platform.md).
- **unknown-source** — a D-number linkage for the EF exists *somewhere* (in-code header, EF-table note, D-registry decision title, or issue #748's suggestion) but there is **no Implementation Index entry** naming the EF — the linkage is a candidate awaiting Bridge registration, not a registry fact.
- **undocumented** — no D-number linkage found in any swept source.

## Audit table (alphabetical, 55 rows)

| # | Edge Function | Live v | Implementation Index entry | Other D-linkage evidence | Status |
|---|---------------|--------|----------------------------|--------------------------|--------|
| 1 | admin-contractor-action | v47 | — | — | undocumented |
| 2 | approve-payout | v36 | D-263 | in-code D-139/D-180 | documented |
| 3 | approve-warranty-drift | v22 | — | in-code D-202 | unknown-source |
| 4 | check-docusign-usage | v29 | D-032 · D-274 | — | documented |
| 5 | check-rate-limits | v36 | — | — | undocumented |
| 6 | check-siding-design-completion | v45 | — | in-code D-164 (D-164 superseded by D-275; EF not named in the D-275 row) | unknown-source |
| 7 | counter-sig-reminders | v4 | — | in-code D-149; exec-cto EF-table note "per D-149"; D-149 exists in D-registry | unknown-source |
| 8 | create-docusign-envelope | v61 | D-032 · D-274 | `Docs/create-docusign-envelope-audit-v1.md` | documented |
| 9 | create-hover-order | v64 | D-018 (superseded by D-275) · D-275 | in-code D-181/D-205 | documented |
| 10 | create-hubspot-contact | v31 | — | in-code D-189/D-210/D-218 | unknown-source |
| 11 | create-invoice | v24 | — | — | undocumented |
| 12 | create-payment-intent | v75 | — | in-code D-181; issue #748 suggests D-214 (conflicting candidates) | unknown-source |
| 13 | create-setup-intent | v48 | — | — | undocumented |
| 14 | docusign-webhook | v63 | D-269 · D-274 | — | documented |
| 15 | get-contractor-info | v10 | — | — | undocumented |
| 16 | get-hover-pdf | v49 | D-018 (superseded) · D-275 | — | documented |
| 17 | get-hover-siding-data | v46 | D-275 | in-code D-164 | documented |
| 18 | get-payout-completion-status | v3 | — | in-code D-139/#567; `Docs/get-payout-completion-status-ef.md` (this PR — D-number pending assignment, #747) | unknown-source |
| 19 | hover-oauth-callback | v56 | D-275 | — | documented |
| 20 | hover-webhook | v60 | D-018 (superseded) · D-270 · D-275 | in-code D-211 | documented |
| 21 | mark-job-complete | v26 | D-228 | in-code D-139/D-228/D-231 | documented |
| 22 | notify-admin-new-contractor | v9 | — | — | undocumented |
| 23 | notify-contractors | v72 | — | in-code D-030/D-134 | unknown-source |
| 24 | notify-feature-request | v43 | — | — | undocumented |
| 25 | notify-partner-w9 | v37 | — | in-code D-172; issue #748 said "D-263 dead-noted" but the D-263 Index row does not name it | unknown-source |
| 26 | notify-payout-pending | v34 | — | in-code D-180 | unknown-source |
| 27 | parse-hover-measurements | v4 | D-275 | — | documented |
| 28 | parse-loss-sheet | v52 | — | — | undocumented |
| 29 | platform-health-check | v42 | D-196 | — | documented |
| 30 | process-auto-bids | v12 | — | in-code D-093; exec-cto EF-table note "(D-093)" | unknown-source |
| 31 | process-bid-expirations | v39 | — | in-code D-150 | unknown-source |
| 32 | process-coi-reminders | v44 | — | in-code D-170/D-210 | unknown-source |
| 33 | process-dunning | v49 | — | — | undocumented |
| 34 | process-hover-rebate | v28 | D-275 | in-code D-181/D-205 | documented |
| 35 | process-payout-reminders | v40 | D-263 | in-code D-139/D-180/D-211 | documented |
| 36 | record-attestation | v22 | — | in-code D-210 | unknown-source |
| 37 | record-warranty-upload | v22 | — | — | undocumented |
| 38 | refresh-warranty-manifest | v25 | — | in-code D-202 | unknown-source |
| 39 | reject-payout | v35 | — | in-code D-180/D-211 | unknown-source |
| 40 | reject-warranty-drift | v22 | — | in-code D-202 | unknown-source |
| 41 | rescind-bid | v23 | — | — | undocumented |
| 42 | resend-hover-link | v45 | D-275 | — | documented |
| 43 | scrape-manufacturer-certs | v23 | — | in-code D-202/D-204 | unknown-source |
| 44 | send-adjuster-email | v61 | D-059 | — | documented |
| 45 | send-bid-confirmation | v28 | — | issue #748 suggests D-215; no in-code or registry entry found | unknown-source |
| 46 | send-home-profile-prompt | v19 | — | in-code D-205/D-231 | unknown-source |
| 47 | send-incomplete-onboarding-reminders | v24 | — | — | undocumented |
| 48 | send-message-notification | v25 | — | — | undocumented |
| 49 | send-sms | v61 | D-060 | in-code D-063/D-211 | documented |
| 50 | send-support-email | v50 | D-195 (recorded inside the D-197 Index row) | in-code D-195 | documented |
| 51 | send-welcome-email | v8 | — | in-code D-220 (a process-policy decision — weak linkage) | unknown-source |
| 52 | stripe-webhook | v21 | D-228 | in-code D-215/D-228 | documented |
| 53 | submit-partner-w9 | v35 | — | in-code D-172 | unknown-source |
| 54 | switch-contractor | v48 | — | in-code D-025/D-041/D-137/D-171; D-registry has D-171 "Homeowner switch-contractor UX" | unknown-source |
| 55 | validate-contract-template | v26 | — | in-code D-199 | unknown-source |

## Summary

| Status | Count |
|--------|-------|
| documented (named in Implementation Index) | **19 of 55** |
| unknown-source (D-linkage evidence exists; no Index entry) | **23 of 55** |
| undocumented (no D-linkage found anywhere swept) | **13 of 55** |

Since the issue's July-12 data (14–15 documented), D-274 (BoldSign, supersedes D-032/D-109) and D-275 (Hover→RoofScope, 8 Hover EFs named explicitly) expanded Index coverage; that accounts for most of the 15→19 movement (docusign-webhook, get-hover-siding-data, hover-oauth-callback, parse-hover-measurements, process-hover-rebate, resend-hover-link gained entries; notify-partner-w9 lost its claimed one — see row 25).

## Notes and adjacent findings

1. **verify_jwt=true (gateway-verified) EFs, 7 of 55:** create-payment-intent, create-docusign-envelope, rescind-bid, record-attestation, get-contractor-info, send-welcome-email, counter-sig-reminders. The other 48 are verify_jwt=false per the ES256/HS256 gateway-mismatch standing position (auth in-handler where needed).
2. **Committed but NOT deployed:** `supabase/functions/send-partner-status-email/` exists in the repo but is absent from the live 55 — not an audit row, flagged for follow-up.
3. **Index references a non-deployed EF:** the D-196 Index row cites `supabase/functions/forge-daily-sweep/ (scheduled)` — no such function is deployed or in the repo.
4. **D-275 sequencing caveat (from the issue, still current):** the 8 Hover EFs (rows 9, 16, 17, 19, 20, 27, 34, 42) are cutover-not-deletion under D-275; D-number work on them should reference D-275 rather than minting new numbers.
5. **In-code headers were swept at first-30-lines depth** — a D-number declared deeper in a file would be missed (affects "undocumented" rows only in the conservative direction: a row marked undocumented might actually hold deeper evidence).
6. **D-number assignment and Implementation Index updates are Bridge/Dustin-owned** (memory tree is not writable from the Code lane). This artifact is the audit deliverable; the "assign/link D-numbers for all EFs" acceptance item remains open for the Bridge, with rows 3–55's evidence column as the pre-filled candidate list.
