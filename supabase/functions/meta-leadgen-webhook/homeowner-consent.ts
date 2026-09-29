// #2123 HO-2 fix round (LEGAL-READ FAIL 5849223003 defect 4, D-299 consent
// evidence) -- builds the D-299 evidence a homeowner Meta lead-form
// submission needs, the same shape record-lead-details/handler.ts's Arm F
// write already stores in public.lead_consents (read that file's companion
// migration, 20260923211259_gh2122_leads_details_consent.sql, for the table
// this evidence is written to).
//
// Kept as pure, dependency-free functions (no supabase-js, no fetch) so the
// consent-computation logic -- the part LEGAL-READ actually needs verified --
// is unit-testable without a real Graph API response or database.
//
// consent_given records BOTH outcomes, same as Arm F: an unticked checkbox,
// or a config/response that gives no clear answer, is `false` -- never a
// reason to skip writing the lead or the evidence row. D-335 allows
// hand-dialling an unticked-box lead only if the record shows the box was
// unticked, so failing closed to `false` (never silently omitting the row)
// is the compliant behaviour, not a stricter one.

import { fieldDataToPayload, mapFieldData, type LeadFieldDatum } from "./field-mapping.ts";

/** Meta Graph API's per-form custom disclaimer response shape (Marketing API "Retrieving Leads" docs). */
export interface CustomDisclaimerResponse {
  /** #2325: what Meta actually sends -- the checkbox KEY (a slug of the consent text). */
  checkbox_key?: string;
  /** Legacy/assumed shapes; kept only as a fallback match (#2325). */
  id?: string;
  name?: string;
  /** Meta sends the STRING "1" / "0" (observed 2026-09-28); a boolean is also tolerated. */
  is_checked?: boolean | string | number;
}

/** #2325: true only for a clear "ticked" -- boolean true or Meta's "1"/"true". Everything else is false. */
function isTicked(v: unknown): boolean {
  return v === true || v === "1" || v === 1 || v === "true";
}

/** #2123 HO-2: the Graph API fields fetchHomeownerLead requests, beyond the partner path's field_data. */
export interface FetchedHomeownerLead {
  field_data?: LeadFieldDatum[];
  custom_disclaimer_responses?: CustomDisclaimerResponse[];
  created_time?: string;
  ad_id?: string;
  campaign_id?: string;
  platform?: string;
  form_id?: string;
}

/** The homeowner allowlist's required-per-entry consent config (fix 4(b)/5). */
export interface HomeownerConsentConfig {
  consentKey: string;
  consentText: string;
}

/** Everything finalizeHomeownerLead needs to write one public.lead_consents row. */
export interface HomeownerConsentArgs {
  consentKey: string;
  consentGiven: boolean;
  consentText: string;
  formId: string;
  phoneAsTyped: string | null;
  formPayload: Record<string, string>;
  adId: string | null;
  campaignId: string | null;
  createdTime: string | null;
}

/**
 * #2325: matches `consentKey` against Meta's `checkbox_key` (the real shape,
 * `{checkbox_key, is_checked: "1"}`), falling back to `id` / `name` (used by
 * the pre-#2325 tests and handler fixtures). Ticked is boolean true or the
 * string "1"/"true"; "0", false, absent, or anything else is false. Fails
 * closed to `false` when `responses` is missing/malformed or nothing matches.
 * NOTE: the allowlist consent_key must be the checkbox KEY string (identical
 * on forms 1078244861764331 and 1714389966848447), not the checkbox id.
 */
export function getConsentGiven(
  responses: CustomDisclaimerResponse[] | null | undefined,
  consentKey: string,
): boolean {
  if (!Array.isArray(responses)) return false;
  for (const r of responses) {
    if (!r || typeof r !== "object") continue;
    if (r.checkbox_key === consentKey || r.id === consentKey || r.name === consentKey) {
      return isTicked(r.is_checked);
    }
  }
  return false;
}

/**
 * Builds the full consent-evidence argument set for one homeowner lead from
 * its Graph API fetch -- everything finalizeHomeownerLead's `lead_consents`
 * write and `payload` JSON need. `formId` is passed separately (from the
 * signed webhook payload's `value.form_id`, not the Graph fetch) because it
 * is already verified/trusted by the time this runs.
 */
export function buildHomeownerConsentArgs(
  fetched: FetchedHomeownerLead,
  config: HomeownerConsentConfig,
  formId: string,
): HomeownerConsentArgs {
  const mapped = mapFieldData(fetched.field_data);
  return {
    consentKey: config.consentKey,
    consentGiven: getConsentGiven(fetched.custom_disclaimer_responses, config.consentKey),
    consentText: config.consentText,
    formId,
    phoneAsTyped: mapped.phone,
    formPayload: fieldDataToPayload(fetched.field_data),
    adId: fetched.ad_id ?? null,
    campaignId: fetched.campaign_id ?? null,
    createdTime: fetched.created_time ?? null,
  };
}
