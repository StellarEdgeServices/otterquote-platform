/**
 * D-269 (#550) — otterquote_acknowledgment server-side backstop helpers.
 *
 * [D-274 / #631, 2026-08-13] Re-platformed from DocuSign to BoldSign.
 *
 * The PLATFORM DISCLOSURE acknowledgment is enforced at signing time by an
 * inline BoldSign Text Tag (`{{sign|<homeowner_idx>|*|...|otterquote_acknowledgment}}`,
 * see create-docusign-envelope's buildAddendumTabs-equivalent) on the
 * generated IC 24-5-11 compliance addendum. This module is the
 * completion-side verification layer: given the AUTHORITATIVE signer/field
 * state for a completed document, decide whether the acknowledgment field
 * is verifiably satisfied.
 *
 * Architecture change from the DocuSign version: BoldSign's webhook payload
 * (payload-parser.ts) never carries per-field data — only signer-level
 * status (Completed/NotCompleted/etc). There is no "rich payload, sometimes
 * has tabs" case to check first the way DocuSign Connect had. Every call
 * into this backstop MUST fetch the authoritative state from
 * GET /v1/document/properties (fetchDocumentSignerStatus below) — there is
 * no cheaper path. evaluateAcknowledgment() stays pure/unit-testable
 * (ack-verify.test.ts) and unaware of that distinction; it just evaluates
 * whatever signer+formField data it's given.
 *
 * UNVERIFIED (flagged per the D-274 build report, needs sandbox
 * confirmation before this is trusted in production): the exact shape of a
 * per-signer `formFields` entry from GET /v1/document/properties for a
 * `sign`-type field. BoldSign's OpenAPI spec confirms `signerDetails[].formFields`
 * exists ("the signer's filled-in field values") but the property names for
 * "was this specific field satisfied" were not independently confirmed
 * beyond the general FormField shape (id, fieldType, value, isReadOnly,
 * isRequired) used at send time. This implementation treats a formFields
 * entry with `id === ACK_FIELD_ID` as satisfied when EITHER its `value` is
 * truthy OR its own per-field `status` (if present) case-insensitively
 * indicates completion — deliberately permissive on the "found → what
 * counts as signed" question while staying strict on "was the field found
 * at all," since a false negative here blocks payment/completion (safe
 * failure direction) while a false positive would silently accept an
 * unacknowledged contract (the exact defect class D-269 exists to catch).
 * Test this specific check against a real sandbox document before relying
 * on it in production.
 *
 * Invariant (CEO decision D-269, 2026-07-13): no silently-accepted contract
 * without the acknowledgment.
 */

export const ACK_FIELD_ID = "otterquote_acknowledgment";

export type AckEvaluation =
  | { state: "satisfied"; via: "field" }
  | { state: "defect"; via: "field" | "field_missing"; detail: string }
  | { state: "indeterminate"; detail: string };

interface FormFieldLike {
  id?: string;
  value?: unknown;
  status?: string;
}

interface SignerLike {
  clientUserId?: string;
  status?: string;
  formFields?: FormFieldLike[];
}

/**
 * Evaluate the acknowledgment field state across a document's signers.
 *
 * - A formFields entry with id === ACK_FIELD_ID satisfies the requirement
 *   when its value is truthy OR its status (if the API supplies one)
 *   indicates completion.
 * - No signer carries any formFields data at all → indeterminate (caller
 *   should treat as an infrastructure gap, not proof of absence — this
 *   should not normally happen once fetchDocumentSignerStatus is always
 *   the caller, but is kept as a safe fallback state).
 * - formFields data present but no ACK_FIELD_ID entry found on any signer →
 *   defect (field_missing): a contract envelope without the field cannot
 *   demonstrate acknowledgment.
 */
export function evaluateAcknowledgment(signers: unknown[]): AckEvaluation {
  let sawFieldData = false;
  const matches: FormFieldLike[] = [];

  for (const s of (signers as SignerLike[]) || []) {
    const fields = s?.formFields;
    if (!Array.isArray(fields) || fields.length === 0) continue;
    sawFieldData = true;
    for (const f of fields) {
      if (f?.id === ACK_FIELD_ID) matches.push(f);
    }
  }

  if (!sawFieldData) {
    return { state: "indeterminate", detail: "no formFields data on any signer" };
  }

  if (matches.length === 0) {
    return {
      state: "defect",
      via: "field_missing",
      detail: `formFields data present but no ${ACK_FIELD_ID} field on any signer`,
    };
  }

  const unsatisfied = matches.filter((f) => {
    // Exact match only (not a substring test) — "NotCompleted" contains
    // "Completed" as a substring and must NOT satisfy this check. Caught by
    // ack-verify.test.ts before this ever reached production.
    const statusOk = typeof f.status === "string" && /^(completed|signed|filled)$/i.test(f.status.trim());
    return !f.value && !statusOk;
  });

  if (unsatisfied.length === 0) return { state: "satisfied", via: "field" };
  return {
    state: "defect",
    via: "field",
    detail: `${unsatisfied.length}/${matches.length} ${ACK_FIELD_ID} field(s) not satisfied`,
  };
}

// ═════════════════════════ BoldSign API ══════════════════════════
// [D-274 / #631] Plain API-key auth — X-API-KEY header. No OAuth/JWT/RSA
// key-exchange plumbing at all; this whole section replaces ~160 lines of
// DocuSign JWT-grant machinery (base64url encoding, PKCS#1->PKCS#8 ASN.1
// wrapping, token caching) with a single header.

// Read lazily (not at module scope) so importing this module — e.g. from
// ack-verify.test.ts, which only exercises the pure evaluateAcknowledgment()
// and never calls fetchDocumentSignerStatus() — never requires --allow-env.
function getBoldSignApiBase(): string {
  return Deno.env.get("BOLDSIGN_API_BASE") || "https://api.boldsign.com";
}

function getBoldSignApiKey(): string {
  const key = Deno.env.get("BOLDSIGN_API");
  if (!key) {
    throw new Error("BOLDSIGN_API not configured.");
  }
  return key;
}

export interface SignerWithFields {
  clientUserId: string;
  status: string;
  email: string | null;
  formFields: FormFieldLike[];
}

/**
 * Fetch the authoritative signer + form-field state for a document from
 * GET /v1/document/properties. Throws on any auth/HTTP failure — the
 * caller decides the fail-open/fail-closed posture (mirrors the DocuSign
 * version's contract exactly).
 */
export async function fetchDocumentSignerStatus(documentId: string): Promise<SignerWithFields[]> {
  const apiKey = getBoldSignApiKey();
  const res = await fetch(
    `${getBoldSignApiBase()}/v1/document/properties?documentId=${encodeURIComponent(documentId)}`,
    { headers: { "X-API-KEY": apiKey } },
  );
  if (!res.ok) {
    throw new Error(`BoldSign document/properties request failed: ${res.status} ${await res.text()}`);
  }
  const properties = await res.json();
  const signerDetails: unknown[] = properties?.signerDetails || [];
  // deno-lint-ignore no-explicit-any
  return (signerDetails as any[]).map((s) => ({
    clientUserId: String(s?.id ?? ""),
    status: String(s?.status ?? "").toLowerCase(),
    email: s?.signerEmail ?? null,
    formFields: Array.isArray(s?.formFields) ? s.formFields : [],
  }));
}
