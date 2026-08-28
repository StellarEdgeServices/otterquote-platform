/**
 * [#1314, 2026-08-27] Signed-price reconciliation helpers.
 *
 * WHY THIS EXISTS. `create-docusign-envelope`'s `handleContractorSign` builds
 * its BoldSign payload with no `formFields` and no prefill, so the seven
 * contractor-assigned text fields on Document 1 -- `contract_price` among them
 * -- arrive empty and required. The contractor hand-types the contract price
 * inside the signing session, and until this module existed nothing compared
 * what he typed against `quotes.total_price`: the amount the homeowner actually
 * accepted, and the basis the platform fee is charged on.
 *
 * A contractor could accept a $13,560 bid and sign a contract reading $15,000.
 * The platform would record 13,560, invoice a fee on 13,560, and the binding
 * instrument would say something else.
 *
 * Kept pure and separate for the same reason `ack-verify.ts`'s
 * `evaluateAcknowledgment` is: this is a money check, and a money check should
 * be unit-testable without a network. See price-verify.test.ts.
 */

export const PRICE_FIELD_ID = "contract_price";

/** Currency comparison tolerance. Prices are dollars-and-cents, not floats. */
export const PRICE_TOLERANCE = 0.01;

export type PriceEvaluation =
  | { state: "reconciled"; signed: number; expected: number }
  | { state: "mismatch"; signed: number; expected: number; delta: number }
  | { state: "unverified"; reason: "no_expected" | "field_absent" | "unparseable"; raw: string | null; expected: number | null };

interface FormFieldLike {
  id?: string;
  value?: unknown;
}

interface SignerLike {
  formFields?: FormFieldLike[];
}

/**
 * Pull the raw `contract_price` value off whichever signer carries it.
 *
 * Returns the first non-empty value found. The field is assigned to the
 * contractor, but this deliberately does not filter by signer: BoldSign's
 * per-signer formFields shape is documented as UNVERIFIED in ack-verify.ts's
 * header, and a stricter search that assumed the wrong signer would report
 * "absent" on every envelope.
 */
export function extractSignedContractPrice(signers: unknown[]): string | null {
  for (const s of (signers as SignerLike[]) ?? []) {
    const fields = s?.formFields;
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      if (f?.id !== PRICE_FIELD_ID) continue;
      if (f?.value === null || f?.value === undefined) continue;
      const v = String(f.value).trim();
      if (v !== "") return v;
    }
  }
  return null;
}

/**
 * Normalise a hand-typed money string to a number.
 *
 * Accepts "$15,000.00", "15000", "15,000". Returns null for anything that does
 * not yield a finite number -- notably NOT zero, because a price that cannot be
 * read is a different state from a price of nothing, and collapsing them would
 * make an unreadable field look like a $0 contract.
 */
export function parseMoney(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decide whether the signed price reconciles against the accepted bid.
 *
 * The three states map to deliberately asymmetric handling at the call site:
 *   - `reconciled` -> proceed.
 *   - `mismatch`   -> HALT before charging. Money is provably wrong.
 *   - `unverified` -> FLAG, do not halt. The BoldSign formFields shape is
 *     unconfirmed against a live document, so an "absent" reading is more
 *     likely a shape mismatch than a real defect, and halting on it would
 *     strand every legitimately signed contract. Promote `field_absent` to a
 *     halt once the shape is confirmed.
 */
export function evaluatePrice(rawSigned: string | null, expected: number | null): PriceEvaluation {
  if (expected === null || !Number.isFinite(expected)) {
    return { state: "unverified", reason: "no_expected", raw: rawSigned, expected: null };
  }
  if (rawSigned === null) {
    return { state: "unverified", reason: "field_absent", raw: null, expected };
  }
  const signed = parseMoney(rawSigned);
  if (signed === null) {
    return { state: "unverified", reason: "unparseable", raw: rawSigned, expected };
  }
  const delta = signed - expected;
  if (Math.abs(delta) > PRICE_TOLERANCE) {
    return { state: "mismatch", signed, expected, delta };
  }
  return { state: "reconciled", signed, expected };
}
