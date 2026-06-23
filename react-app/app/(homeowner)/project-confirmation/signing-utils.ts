/**
 * Homeowner project-confirmation pure signing helpers — D-211 Phase 26, PR 2/2.
 *
 * DOM-free, network-free, fully unit-tested. All behavior ported from
 * project-confirmation.html inline JS. The one intentional delta from the static:
 * buildProjectConfirmationEnvelopeRequest omits the `signer` field — the
 * create-docusign-envelope EF derives the signer server-side (brief D-220).
 * The static sent signer + no return_url; this PR sends return_url + no signer.
 */

// ── Document type ──────────────────────────────────────────────────────────────

export const PROJECT_CONFIRMATION_DOC_TYPE = 'project_confirmation' as const;

// ── Status gate ────────────────────────────────────────────────────────────────

export const STATUS_ALLOWED = ['contract_signed', 'awarded', 'completed'] as const;

/**
 * True when the claim status permits project confirmation. Mirrors the static check
 * (project-confirmation.html:2182): !['contract_signed','awarded','completed'].includes(status).
 */
export function isStatusAllowed(status: string | null | undefined): boolean {
  if (!status) return false;
  return (STATUS_ALLOWED as readonly string[]).includes(status);
}

// ── URL builder ────────────────────────────────────────────────────────────────

/**
 * The embedded-signing return URL targeting the REACT project-confirmation route
 * (not the static .html page). claim_id is encodeURIComponent-encoded.
 */
export function buildProjectConfirmationReturnUrl(origin: string, claimId: string): string {
  return `${origin}/project-confirmation?claim_id=${encodeURIComponent(claimId)}&signed=true`;
}

// ── Envelope request ───────────────────────────────────────────────────────────

export interface ProjectConfirmationEnvelopeRequest {
  claim_id: string;
  document_type: 'project_confirmation';
  contractor_id: string;
  return_url: string;
}

/**
 * Build the body for the create-docusign-envelope EF call.
 * CRITICAL: NO `signer` field — the EF derives the signer server-side (D-220).
 * Includes return_url targeting the React route (delta from static, which had neither).
 */
export function buildProjectConfirmationEnvelopeRequest({
  claimId,
  contractorId,
  origin,
}: {
  claimId: string;
  contractorId: string;
  origin: string;
}): ProjectConfirmationEnvelopeRequest {
  return {
    claim_id: claimId,
    document_type: PROJECT_CONFIRMATION_DOC_TYPE,
    contractor_id: contractorId,
    return_url: buildProjectConfirmationReturnUrl(origin, claimId),
  };
}

// ── Currency formatter ─────────────────────────────────────────────────────────

/**
 * Faithful port of static formatCurrency (project-confirmation.html:1532-1537).
 * null/undefined/'' → '—'; parseFloat NaN → '—'; else '$' + toLocaleString.
 */
export function formatCurrency(val: unknown): string {
  if (val == null || val === '') return '—';
  const n = parseFloat(val as string);
  if (isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Depreciation extractor ─────────────────────────────────────────────────────

/**
 * Extract the numeric depreciation value from parsed_line_items. Faithful port of
 * static lines 2216-2224. Guards when parsedLineItems is null/undefined.
 */
export function extractDepreciation(parsedLineItems: unknown): number | null {
  if (parsedLineItems == null) return null;
  const lineItems = parsedLineItems as Record<string, unknown>;
  // `||` chain (NOT `??`) — faithful to the static (project-confirmation.html:2218-2220):
  // a FALSY value (0, '', null) at one level falls through to the next, then to null. A
  // lone `0` depreciation therefore resolves to null (→ 'None / N/A' banner / '$___'
  // disclosure), exactly as the static rendered it.
  const summaryDep = (lineItems.summary as Record<string, unknown> | undefined)?.depreciation;
  const dep = summaryDep || lineItems.depreciation || null;
  if (dep != null && !isNaN(parseFloat(dep as string))) {
    return parseFloat(dep as string);
  }
  return null;
}

// ── Disclosure injection helpers ───────────────────────────────────────────────

/**
 * Text for the depreciation disclosure injection point (#depreciationAmtDisplay).
 * dep != null → formatCurrency(dep); else → '$___' (copy.ts depreciationAmountDefault).
 * Faithful port of static 2293-2298.
 */
export function depreciationDisclosureAmountText(dep: number | null): string {
  return dep != null ? formatCurrency(dep) : '$___';
}

/**
 * Text for the auto-fill banner (#af-depreciation).
 * dep != null → formatCurrency(dep); else → 'None / N/A'.
 * NOTE: different default vs the disclosure (static 2235-2236).
 */
export function depreciationBannerText(dep: number | null): string {
  return dep != null ? formatCurrency(dep) : 'None / N/A';
}

/**
 * Text for the bad-decking ack sublabel (#deckingRateDisplay).
 * rate != null → formatCurrency(rate) + ' per sheet'; else → 'per contractor quote'.
 * Faithful port of static 2300-2306. NOTE: copy.ts deckingRateDisplayDefault is '—'
 * but the static REPLACES it at runtime with this text.
 */
export function deckingRateAckText(rate: number | null): string {
  return rate != null ? formatCurrency(rate) + ' per sheet' : 'per contractor quote';
}

/**
 * Text for the auto-fill banner (#af-decking-rate).
 * rate != null → formatCurrency(rate) + ' / sheet'; else → '—'.
 * Faithful port of static 2237-2238.
 */
export function deckingRateBannerText(rate: number | null): string {
  return rate != null ? formatCurrency(rate) + ' / sheet' : '—';
}

// ── Shingle manufacturer option resolver ──────────────────────────────────────

/**
 * Case-insensitive match of brand against the option values (static 2274-2286).
 * Returns the matched canonical option value or null.
 */
export function resolveShingleManufacturerOption(
  brand: string | null | undefined,
  options: string[],
): string | null {
  if (!brand) return null;
  const trimmed = brand.trim();
  for (const opt of options) {
    if (opt.toLowerCase() === trimmed.toLowerCase()) {
      return opt;
    }
  }
  return null;
}
