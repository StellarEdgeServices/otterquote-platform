# #588 patch payloads — PENDING LOCAL APPLY

This remote one-shot BUILD session (2026-08-03) works behind a read-only git
proxy, so modified files travel as base64-encoded git patches (byte-exact,
CRLF-safe). New files (sql/v99*, _shared/roofing-scope.ts, supabase/config.toml)
were pushed as real content. All six patches below apply cleanly onto `main`
@ e989e79 (verified in-session with `git apply --check`).

**To apply (next local Code session, BEFORE merging this PR):**

    git checkout feat/588-frozen-sow-catalog-v1
    for p in Docs/588-pending-frontend-patches/*.patch.b64; do
      base64 -d "$p" | git apply - || echo "FAILED: $p"
    done
    git add -A
    git commit -m "feat(588): apply patch payloads (EF pipeline + frontend)"
    git rm -r Docs/588-pending-frontend-patches
    git commit -m "chore(588): remove applied patch payloads"

Contents:
- `parse-hover-measurements.patch.b64` — user-JWT-with-claim-ownership auth path
  (parse-loss-sheet pattern); freeze Exhibit A Section 1 after parse; fail-loud
  platform_alerts_log inserts on every parse miss / freeze failure.
- `hover-webhook.patch.b64` — Hover Complete storage-path bug fix: normalize the
  API measurements.json into claims.hover_measurements; measurements_filename now
  points at the real get-hover-pdf cache path instead of a phantom .json name;
  freeze scope on completion; fail-loud alerts on fetch/store failures.
- `get-hover-pdf.patch.b64` — cache-first serving (#484 item 2) + cache write on
  the direct-stream path.
- `create-docusign-envelope.patch.b64` — Exhibit A Section 1 rendered VERBATIM
  from scope_records (catalog v1.0, pure measured quantities); contractor
  declared_waste_pct prints install-plan quantities alongside frozen measured
  values; hard gate: retail roofing envelope creation ABORTS (fail-loud) when no
  frozen scope exists after lazy freeze/parse attempts.
- `dashboard.html.patch.b64` — upload-time parse invoke + submit-for-bids hard
  release gate on scope_records.
- `contractor-bid-form.html.patch.b64` — Declared Waste % bid field →
  scope_summary.declared_waste_pct.

Deploy gating (unchanged): create-docusign-envelope + hover-webhook are Tier 3B
— R-097 24h risk brief posted to the CEO board; do NOT deploy before the window
closes. parse-hover-measurements + get-hover-pdf ship with the same window since
the pipeline is one unit. v99 migration is already applied (Tier 3A, D-261).

[SPEC-VERIFY] before deploy: transcribe catalog note rows N1–N4 verbatim from
`roofing-sow-line-item-catalog-v1.0-LOCKED-2026-07-31.md` into
DISCLOSURE_PLACEHOLDERS in _shared/roofing-scope.ts, and confirm the ridge-vent
basis + sq_material row set against the locked file.
