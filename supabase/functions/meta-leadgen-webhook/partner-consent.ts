// gh-2313 -- builds the call/text consent evidence a PARTNER Meta lead-form
// submission needs, BEFORE register_partner runs. The partner sibling of
// homeowner-consent.ts (#2123 HO-2), and it deliberately reuses that file's
// getConsentGiven() so the two paths read Meta's custom_disclaimer_responses
// identically (id-or-name match, and only the literal boolean `true` counts).
//
// What differs from the homeowner path, on purpose (Marty's ruling, #2306
// comment 5876046128, Tier A): a homeowner lead is registered either way and
// carries consent_given=false when the box is unticked (D-335). A PARTNER lead
// whose required box is absent or unticked is LOGGED AND NOT REGISTERED, so
// this module returns a three-way result and handler.ts acts on it:
//   - "ok"             -> write the evidence row, then register_partner
//   - "config_missing" -> the allowlist entry has no consent_key/consent_text:
//                         we have no wording to store, so we do not invent any
//                         and do not register
//   - "not_given"      -> box absent / unticked / malformed response: do not register
//
// Pure, dependency-free (no supabase-js, no fetch) so the part LEGAL-READ needs
// verified is unit-testable without a Graph response or a database.

import { getConsentGiven, type CustomDisclaimerResponse } from "./homeowner-consent.ts";
import { fieldDataToPayload, mapFieldData, type LeadFieldDatum } from "./field-mapping.ts";
import type { PartnerFormConfig } from "./allowlist.ts";

/** The evidence key stored on every partner call/text consent row (ruling on #2313). */
export const PARTNER_CONSENT_KEY = "partner_call_text_consent";

/** The Graph API fields the partner fetch returns (gh-2313 widened it beyond field_data). */
export interface FetchedPartnerLead {
  field_data?: LeadFieldDatum[];
  custom_disclaimer_responses?: CustomDisclaimerResponse[];
  created_time?: string;
  ad_id?: string;
  campaign_id?: string;
  platform?: string;
  form_id?: string;
}

/** Everything recordPartnerConsent needs to write one public.partner_lead_consents row. */
export interface PartnerConsentArgs {
  /** Always PARTNER_CONSENT_KEY. */
  consentKey: string;
  consentGiven: boolean;
  /** Verbatim from the allowlist entry (config), never composed in code. */
  consentText: string;
  formId: string;
  leadgenId: string;
  funnelId: string;
  /** The raw custom_disclaimer_responses array from Graph, kept as the response evidence. */
  disclaimerResponses: CustomDisclaimerResponse[] | null;
  phoneAsTyped: string | null;
  formPayload: Record<string, string>;
  adId: string | null;
  campaignId: string | null;
  createdTime: string | null;
}

export type PartnerConsentResult =
  | { status: "ok"; args: PartnerConsentArgs }
  | { status: "config_missing" }
  | { status: "not_given" };

/**
 * `formId` and `leadgenId` come from the signed webhook payload (already
 * trusted by the time this runs), not from the Graph fetch.
 */
export function buildPartnerConsentArgs(
  fetched: FetchedPartnerLead,
  config: PartnerFormConfig,
  formId: string,
  leadgenId: string,
): PartnerConsentResult {
  if (!config.consentKey || !config.consentText) return { status: "config_missing" };
  if (!getConsentGiven(fetched.custom_disclaimer_responses, config.consentKey)) {
    return { status: "not_given" };
  }
  const mapped = mapFieldData(fetched.field_data);
  return {
    status: "ok",
    args: {
      consentKey: PARTNER_CONSENT_KEY,
      consentGiven: true,
      consentText: config.consentText,
      formId,
      leadgenId,
      funnelId: config.funnelId,
      disclaimerResponses: Array.isArray(fetched.custom_disclaimer_responses)
        ? fetched.custom_disclaimer_responses
        : null,
      phoneAsTyped: mapped.phone,
      formPayload: fieldDataToPayload(fetched.field_data),
      adId: fetched.ad_id ?? null,
      campaignId: fetched.campaign_id ?? null,
      createdTime: fetched.created_time ?? null,
    },
  };
}
