// _shared/template-validity.ts — the contractor-template validity INVARIANT,
// enforced where `contractor_templates.status` is READ, not only where it is
// written. gh-1315 (project), root of #1313 / #1314 / #1584.
//
// ── CANONICAL COPY. Consumers carry a byte-identical sibling copy ─────────────
// The EF deploy path in this repo does not resolve `_shared/` imports (see
// _shared/admin.ts, _shared/sentry.ts, _shared/getHomeownerName.ts — same
// constraint, same precedent), so each consumer imports `./template-validity.ts`
// from its own directory:
//   create-docusign-envelope/template-validity.ts
//   validate-contract-template/template-validity.ts
// _shared/template-validity.test.ts asserts every copy is byte-identical to
// this file; edit HERE and copy, never edit a sibling.
//
// Why this exists. `validate-contract-template` writes `status` once, on the
// day the contractor uploads, against whatever manifest was deployed that day.
// Nothing ever rechecked it. So on 2026-09-04 production held 12 templates,
// 8 of them `auto_validated`, and 0 of them validated under the deployed v3
// manifest: 6 carried a v2 (retired DocuSign-anchor) result and 6 carried no
// result at all. `bid_can_submit` keyed on `status` alone, and
// `create-docusign-envelope` attached the PDF without looking at the row at
// all. Every completed contract therefore raised `signed_price_unverified
// reason=field_absent` (#1314): the document never carried the v3
// `{{text|1|*|Contract Price|contract_price}}` tag the price halt reads.
//
// The invariant, in one sentence: a template is USABLE for bidding/signing iff
//   1. status is in the validated set, AND
//   2. validation_result.manifestVersion === the manifest currently deployed, AND
//   3. required-field coverage is complete (allRequiredFound, the counts agree,
//      every anchor in `anchors` is found), AND
//   4. every field id the caller declares load-bearing (create-docusign-envelope
//      declares `contract_price`) is carried by a FOUND boldsign_tag anchor.
//
// Any other shape — null result, v2 result, seeded-but-incomplete result — is
// NOT validated, whatever `status` says, and the reader must refuse with a
// specific, template-id-bearing reason rather than fall through.
//
// Pure. No IO, no Supabase, no Deno globals, so every reader and every test can
// import it.

/**
 * The manifest version the platform currently validates against. Single source:
 * validate-contract-template/manifest.ts sets MANIFEST.version from this
 * constant; the health check reports it; readers compare stored results to it.
 * Bump it HERE when the manifest changes and every stored result of the old
 * version becomes stale automatically — which is the whole point.
 */
export const CURRENT_TEMPLATE_MANIFEST_VERSION = "v3";

/** Statuses `bid_can_submit` (v65, D-199) treats as "may bid". Mirrored verbatim. */
export const VALIDATED_STATUSES = ["auto_validated", "manual_validated", "admin_validated"] as const;

/**
 * The BoldSign field id the #1314 price halt (docusign-webhook/price-verify.ts,
 * PRICE_FIELD_ID) reads off the signed document. A template that does not carry
 * it produces `signed_price_unverified reason=field_absent` on every completion.
 * Kept in lock-step by test (template-validity.test.ts imports both).
 */
export const CONTRACT_PRICE_FIELD_ID = "contract_price";

export type TemplateUnusableCode =
  | "status_not_validated"
  | "validation_result_missing"
  | "manifest_version_stale"
  | "required_fields_incomplete"
  | "load_bearing_field_absent";

export interface TemplateUsability {
  usable: boolean;
  code: TemplateUnusableCode | null;
  /** Human-readable, names the template id and the exact reason. Empty when usable. */
  reason: string;
  /** What the stored result claims, for the caller's log line. */
  storedManifestVersion: string | null;
  /** Load-bearing field ids that are NOT carried by a found tag (empty when usable). */
  missingFieldIds: string[];
}

/** The subset of a contractor_templates row the invariant reads. Everything optional: rows arrive from PostgREST. */
export interface TemplateRowLike {
  id?: string | null;
  status?: string | null;
  trade?: string | null;
  funding_type?: string | null;
  // deno-lint-ignore no-explicit-any
  validation_result?: any;
}

export interface IsTemplateUsableOptions {
  /**
   * Field ids the caller's own flow depends on (e.g. create-docusign-envelope's
   * price halt needs `contract_price`). Each must appear as the FieldID of a
   * found boldsign_tag anchor in validation_result.anchors.
   */
  requireFieldIds?: readonly string[];
}

/**
 * FieldID of a BoldSign text tag `{{type|idx|req|Label|field_id}}`, or null for
 * a label_text anchor / anything that is not a tag.
 */
export function fieldIdFromAnchor(anchor: unknown): string | null {
  if (typeof anchor !== "string") return null;
  const m = anchor.match(/^\{\{[^|{}]+\|[^|{}]+\|[^|{}]*\|[^|{}]*\|([^|{}]+)\}\}$/);
  return m ? m[1] : null;
}

/** Field ids carried by FOUND boldsign_tag anchors of a validation_result. */
export function foundFieldIds(validationResult: unknown): Set<string> {
  const out = new Set<string>();
  // deno-lint-ignore no-explicit-any
  const anchors = (validationResult as any)?.anchors;
  if (!Array.isArray(anchors)) return out;
  for (const a of anchors) {
    if (!a || a.found !== true) continue;
    if (a.mechanism !== undefined && a.mechanism !== "boldsign_tag") continue;
    const id = fieldIdFromAnchor(a.anchor);
    if (id) out.add(id);
  }
  return out;
}

function describe(t: TemplateRowLike): string {
  const slot = t.trade && t.funding_type ? ` (${t.trade}/${t.funding_type})` : "";
  return `contractor_templates row ${t.id ?? "<no id>"}${slot}`;
}

/**
 * The invariant. See the file header for the four conjuncts.
 *
 * @param template  a contractor_templates row (id, status, trade, funding_type, validation_result)
 * @param currentManifestVersion  the manifest version deployed NOW (CURRENT_TEMPLATE_MANIFEST_VERSION)
 */
export function isTemplateUsable(
  template: TemplateRowLike | null | undefined,
  currentManifestVersion: string = CURRENT_TEMPLATE_MANIFEST_VERSION,
  opts: IsTemplateUsableOptions = {},
): TemplateUsability {
  const t: TemplateRowLike = template ?? {};
  const vr = t.validation_result;
  const storedManifestVersion = typeof vr?.manifestVersion === "string" ? vr.manifestVersion : null;
  const fail = (code: TemplateUnusableCode, why: string, missingFieldIds: string[] = []): TemplateUsability => ({
    usable: false,
    code,
    reason: `${describe(t)} is not usable: ${why}`,
    storedManifestVersion,
    missingFieldIds,
  });

  // 1. status
  const status = typeof t.status === "string" ? t.status : null;
  if (!status || !(VALIDATED_STATUSES as readonly string[]).includes(status)) {
    return fail("status_not_validated", `status is ${status ? `'${status}'` : "missing"}; must be one of ${VALIDATED_STATUSES.join(", ")}`);
  }

  // 2. a result exists at all (the #1584 shape: status set with no artefact)
  if (vr === null || vr === undefined || typeof vr !== "object") {
    return fail("validation_result_missing", `status is '${status}' but validation_result is ${vr === undefined ? "absent" : "null"} — the verdict was written without a validation artefact`);
  }

  // 3. manifest version
  if (storedManifestVersion !== currentManifestVersion) {
    return fail(
      "manifest_version_stale",
      `validation_result.manifestVersion is ${storedManifestVersion ? `'${storedManifestVersion}'` : "missing"} but the deployed manifest is '${currentManifestVersion}'; re-validate (revalidate-contract-templates) or re-upload`,
    );
  }

  // 4. required-field coverage
  const anchors = Array.isArray(vr.anchors) ? vr.anchors : null;
  const requiredCount = Number(vr.requiredCount);
  const requiredFoundCount = Number(vr.requiredFoundCount);
  // deno-lint-ignore no-explicit-any
  const notFound = anchors ? anchors.filter((a: any) => !a || a.found !== true) : [];
  const coverageOk = vr.allRequiredFound === true &&
    anchors !== null && anchors.length > 0 &&
    Number.isFinite(requiredCount) && Number.isFinite(requiredFoundCount) &&
    requiredCount === requiredFoundCount &&
    anchors.length === requiredCount &&
    notFound.length === 0;
  if (!coverageOk) {
    const detail = anchors === null
      ? "validation_result.anchors is missing"
      : notFound.length > 0
      // deno-lint-ignore no-explicit-any
      ? `${notFound.length} required anchor(s) not found: ${notFound.map((a: any) => a?.field ?? a?.anchor ?? "?").join("; ")}`
      : `allRequiredFound=${String(vr.allRequiredFound)}, requiredFoundCount=${String(vr.requiredFoundCount)}, requiredCount=${String(vr.requiredCount)}, anchors=${anchors.length}`;
    return fail("required_fields_incomplete", `required-field coverage is incomplete under '${currentManifestVersion}' — ${detail}`);
  }

  // 5. load-bearing field ids the caller depends on
  const required = opts.requireFieldIds ?? [];
  if (required.length > 0) {
    const have = foundFieldIds(vr);
    const missing = required.filter((id) => !have.has(id));
    if (missing.length > 0) {
      return fail(
        "load_bearing_field_absent",
        `the document carries no found BoldSign tag for field id(s) ${missing.map((m) => `'${m}'`).join(", ")}; a signed copy could not be reconciled (#1314 reason=field_absent)`,
        missing,
      );
    }
  }

  return { usable: true, code: null, reason: "", storedManifestVersion, missingFieldIds: [] };
}

/**
 * Thrown by readers that gate on the invariant. `statusCode` 422 so
 * create-docusign-envelope's error mapper can hand the caller the reason
 * instead of a generic 500.
 */
export class TemplateNotUsableError extends Error {
  statusCode = 422;
  code = "TEMPLATE_NOT_USABLE";
  usability: TemplateUsability;
  templateId: string | null;
  constructor(usability: TemplateUsability, templateId: string | null) {
    super(usability.reason);
    this.name = "TemplateNotUsableError";
    this.usability = usability;
    this.templateId = templateId;
  }
}
