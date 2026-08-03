# #588 frontend patches — PENDING LOCAL APPLY

This session (2026-08-03, remote one-shot BUILD) could not push `dashboard.html`
and `contractor-bid-form.html` through the read-only git proxy at full size, so
their verified changes travel as base64-encoded git patches in this folder.
They apply cleanly onto `main` @ e989e79 (verified in-session).

**To apply (next local Code session, BEFORE merging this PR):**

    cd <repo>
    git checkout feat/588-frozen-sow-catalog-v1
    base64 -d Docs/588-pending-frontend-patches/dashboard.html.patch.b64 | git apply -
    base64 -d Docs/588-pending-frontend-patches/contractor-bid-form.html.patch.b64 | git apply -
    git add dashboard.html contractor-bid-form.html
    git commit -m "feat(588): apply frontend patches (upload-time parse, submit gate, declared waste %)"
    git rm -r Docs/588-pending-frontend-patches
    git commit -m "chore(588): remove applied patch payloads"

What the patches contain:
- `dashboard.html`: invoke `parse-hover-measurements` at measurement-upload time
  (fail-loud toast on miss); hard release gate in `submitForBids()` — retail
  roofing claims cannot set `ready_for_bids` without an active `scope_records`
  row (one lazy parse retry, then block).
- `contractor-bid-form.html`: "Declared Waste %" bid field (0–35, optional) →
  `scope_summary.declared_waste_pct`; prefill on bid edit.

Base64 was chosen because `dashboard.html` is CRLF — the encoding guarantees
byte-exact transport. The PR must NOT merge until these are applied.
