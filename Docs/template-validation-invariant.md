# The template-validation invariant (gh-1315)

**One sentence:** a contractor template is *usable* for bidding and signing only if its stored
verdict was produced by the manifest that is deployed **now** and that verdict shows every required
marker present — and that is checked where the verdict is **read**, not only where it was written.

## Why

`validate-contract-template` writes `contractor_templates.status` once, on upload day, against the
manifest deployed that day. Nothing rechecked it. On 2026-09-04 production held 12 templates,
8 `auto_validated`, **0 validated under the deployed v3 manifest**: six carried a v2 result (the
retired DocuSign `anchorString` grammar, superseded by D-274 on 2026-08-13) and six carried no result
at all (#1584's seed shape). `bid_can_submit` keyed on `status` alone; `create-docusign-envelope`
attached the PDF from the legacy `contractors.contract_templates` JSONB without reading the row at all.

The consequence is #1314: every completed contract (2 of 2, both `is_test`) raised
`signed_price_unverified reason=field_absent`, because no attached document carried the v3
`{{text|1|*|Contract Price|contract_price}}` tag that the price halt in `docusign-webhook/price-verify.ts`
reads. A v2 template satisfies exactly 2 of 13 v3 markers (the two plain-text warranty labels) and
none of the BoldSign tags — it cannot place a single field.

## The invariant

`isTemplateUsable(template, currentManifestVersion, { requireFieldIds })` in
`supabase/functions/_shared/template-validity.ts` returns `{ usable, code, reason, storedManifestVersion, missingFieldIds }`.
It is true only when **all** of:

| # | Conjunct | Failure code |
|---|---|---|
| 1 | `status` in `auto_validated`, `manual_validated`, `admin_validated` (the `bid_can_submit` set) | `status_not_validated` |
| 2 | `validation_result` is present | `validation_result_missing` |
| 3 | `validation_result.manifestVersion === CURRENT_TEMPLATE_MANIFEST_VERSION` (`"v3"`) | `manifest_version_stale` |
| 4 | `allRequiredFound === true`, `requiredFoundCount === requiredCount === anchors.length`, every anchor `found` | `required_fields_incomplete` |
| 5 | every caller-declared load-bearing field id is carried by a *found* BoldSign tag | `load_bearing_field_absent` |

`reason` always names the `contractor_templates` row id and the slot. The helper is pure and
version-agnostic (pass `"v2"` and a v2 result is fine) so the next manifest bump is one constant.

### Where it is enforced

* **`create-docusign-envelope` → `handleContractorSign`** (the load-bearing reader). Before the legacy
  JSONB/URL lookup and before any PDF byte is fetched, `assertContractorTemplateUsable` loads the
  `contractor_templates` row for `(contractor_id, trade, funding_type)` and applies the invariant with
  `requireFieldIds: ["contract_price"]`. Failure throws `TemplateNotUsableError` → HTTP **422**
  `{ error: "TEMPLATE_NOT_USABLE", message, template_id, reason_code, stored_manifest_version, current_manifest_version, missing_field_ids }`.
  A contractor with **no** row for the slot is refused too — `bid_can_submit` would have refused the bid
  (`not_found`), so reaching signing without a row means the gate was bypassed (auto-bids skip it).
  Nothing else in the handler changed: legal text, pricing, signer order, tag builders are untouched.
* **`revalidate-contract-templates` pass** (below) uses the same helper to report per-row usability
  before and after.
* `bid_can_submit` (SQL, v65) still keys on `status` alone. It is *consistent* with the invariant only
  once the re-validation pass has rewritten every stale row's status — until then the SQL gate is looser
  than the signing gate, which is the safe direction (a contractor is refused later, not admitted wrongly).
  Folding the manifest-version check into the SQL function is a Tier 3B migration and is not in this PR.

### Single source of the version

`CURRENT_TEMPLATE_MANIFEST_VERSION` lives in `_shared/template-validity.ts`. The deploy path in this repo
does not resolve `_shared/` imports (precedent: `_shared/admin.ts`, `sentry.ts`, `getHomeownerName.ts`),
so `create-docusign-envelope/` and `validate-contract-template/` each carry a **byte-identical sibling
copy**; `_shared/template-validity.test.ts` fails if any copy drifts. `validate-contract-template/manifest.ts`
sets `MANIFEST.version` from the constant, so the health check, the validator, the starter PDF and the
readers all report the same value by construction.

## The re-validation path

`POST validate-contract-template` with `{ "revalidate_all": true, "dry_run": true | false, "force"?: bool, "template_ids"?: [uuid] }`.
Bearer must be the **service-role key** or a JWT with `app_metadata.role === "admin"`; a contractor JWT
is refused (403). `dry_run` **defaults to true**.

It re-runs the identical scan (`manifest.ts` / `pdf-text.ts` — the same functions the fresh path calls)
over every row whose result is missing or was produced under another manifest version, and returns a
per-template report (`before`, `after`, `status_would_change`, `written`, `error`). Write mode rewrites
`validation_result` and — because the fresh path already writes it on every validation — `status`, via
the same D-199 state machine (`allRequiredFound` → `auto_validated`/`manual_validated` if the row carries
`manual_overrides`; else `manual_mapping_pending`). Rows whose PDF is missing or unparseable are reported
and **not written**, exactly like the fresh path's 404/422. `manual_overrides` is never rewritten.
The written result carries `revalidated: { from, at }` for provenance.

Running it in write mode against production today flips every v2 `auto_validated` row to
`manual_mapping_pending`, which is the truth `bid_can_submit` should have been telling contractors since
2026-08-13. Run dry first, read the report, then write.

### One scan fix that rode along

`normalizeForScan` folds typographic apostrophes/quotes (U+2018/2019/201C/201D…) and NBSP to ASCII before
the substring scan. Found live: a fully v3-tagged production template failed only because Word wrote
`Manufacturer’s Warranty:` with U+2019. Tags never contain these characters; manifest strings are unchanged.

## The ceremony prerequisite (#1314)

#1314 closes on the price halt *firing* during an induced-mismatch signing ceremony on an `is_test` row.
The halt can only read a price the document actually carries, and the document is the contractor's
validated template. So the prerequisite chain is:

1. a `contractor_templates` row for the signing contractor's `(trade, funding)` slot that passes
   `isTemplateUsable(row, "v3", { requireFieldIds: ["contract_price"] })` — i.e. a v3-tagged PDF, validated
   (or re-validated) under v3, with the `contract_price` tag found;
2. `create-docusign-envelope` (this PR) refuses to mint otherwise, so a ceremony attempted on a v2 template
   now fails fast with `TEMPLATE_NOT_USABLE` instead of producing another `field_absent`;
3. only then does the induced mismatch reach `price-verify.ts` with a readable `contract_price`.

Measured 2026-09-04 (dry run, read-only): neither completed-contract contractor holds such a template
(`f8223eb9` roofing/retail and `297d480b` roofing/insurance both score 2/13 and 2/14 under v3, no
`contract_price` tag). The only row that would pass v3 is `05d7148c` (PFW Roofing 1787836001, `is_test`,
roofing/retail, 13/13 with the apostrophe fold, `contract_price` present) — that contractor has no quote
or claim, so a ceremony needs either a new `is_test` claim + bid for that contractor, or a v3 starter PDF
(`{ starter: true, trade, funding_type }`) uploaded to the slot of one of the two existing contractors and
validated. See the gh-1315 RUN 23 report for the exact upload.
