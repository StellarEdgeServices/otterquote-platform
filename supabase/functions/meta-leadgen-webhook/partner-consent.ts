// gh-2313 -- builds the call/text consent evidence a PARTNER Meta lead-form
// submission carries, BEFORE register_partner runs. The partner sibling of
// homeowner-consent.ts.
//
// RULING (Ben, CEO RUN 78, PR #2322 comment 5879500610, Tier A under R-015;
// basis D-299 as applied in 5810664798 and Dustin's "Replace, box optional" on
// #2121, 5879345560): consent to calls/texts is NEVER a condition of partner
// signup. Registration is not the regulated act; automated calls/texts are.
// So this module returns a result handler.ts acts on, and EVERY branch ends in
// register_partner:
//   - "ok"             -> the configured consent box is PRESENT in the response
//                         (ticked OR unticked). Write the evidence row with
//                         consent_given = true/false, then register.
//   - "no_box"         -> the box is absent from the response: register, store
//                         no row, log a warning.
//   - "config_missing" -> the allowlist entry has no consent_key/consent_text:
//                         no wording to store and none is invented; register,
//                         store no row, log a warning.
//   - "text_too_long"  -> the configured wording is over 2,000 chars. It is
//                         REJECTED (logged error, no row), never truncated:
//                         truncated wording would not be the verbatim text the
//                         partner saw. Register, store no row.
//
// Meta's real shape (PR #2322 review, issue #2325): custom_disclaimer_responses
// entries are `{ checkbox_key, is_checked: "1" }` -- is_checked is the STRING
// "1"/"0", not a boolean, and the key field is `checkbox_key`, not `id`/`name`.
// homeowner-consent.ts's getConsentGiven() reads `id|name` and only the literal
// boolean `true` (bug #2325, fixed separately, not touched here), so this
// module does its OWN parsing and does not reuse it.
//
// Pure, dependency-free (no supabase-js, no fetch) so the part LEGAL-READ needs
// verified is unit-testable without a Graph response or a database.

import { fieldDataToPayload, mapFieldData, type LeadFieldDatum } from "./field-mapping.ts";
import type { PartnerFormConfig } from "./allowlist.ts";

/** Consent wording is stored verbatim, so it is capped by REJECTING, never by slicing. */
export const MAX_CONSENT_TEXT_LENGTH = 2000;

/**
 * One entry of Meta's custom_disclaimer_responses. Real Meta payloads send
 * `{checkbox_key, is_checked: "1"}`; `id`/`name` are accepted as key aliases
 * (older fixtures and the homeowner shape), and is_checked may be a string,
 * number or boolean -- see parseIsChecked.
 */
export interface PartnerDisclaimerResponse {
  checkbox_key?: string;
  id?: string;
  name?: string;
  is_checked?: boolean | string | number;
}

export type ConsentBoxState = "ticked" | "unticked" | "absent";

/**
 * "1" / "0" / true / false (and 1 / 0). Anything else that is PRESENT
 * (garbage, "true", null) reads as unticked: consent is never inferred from
 * an unrecognised value.
 */
export function parseIsChecked(v: unknown): boolean {
  return v === true || v === "1" || v === 1;
}

/**
 * Finds the configured consent box (matched on checkbox_key, else id, else
 * name) and reports whether it is ticked, unticked, or absent from the
 * response. First matching entry wins.
 */
export function getPartnerConsentBoxState(
  responses: PartnerDisclaimerResponse[] | null | undefined,
  consentKey: string,
): ConsentBoxState {
  if (!Array.isArray(responses)) return "absent";
  for (const r of responses) {
    if (!r || typeof r !== "object") continue;
    if (r.checkbox_key === consentKey || r.id === consentKey || r.name === consentKey) {
      return parseIsChecked(r.is_checked) ? "ticked" : "unticked";
    }
  }
  return "absent";
}

/** The evidence key stored on every partner call/text consent row (ruling on #2313). */
export const PARTNER_CONSENT_KEY = "partner_call_text_consent";

/** The Graph API fields the partner fetch returns (gh-2313 widened it beyond field_data). */
export interface FetchedPartnerLead {
  field_data?: LeadFieldDatum[];
  custom_disclaimer_responses?: PartnerDisclaimerResponse[];
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
  /** true when the box was ticked; false when it was present but unticked. */
  consentGiven: boolean;
  /** Verbatim from the allowlist entry (config), never composed in code. */
  consentText: string;
  formId: string;
  leadgenId: string;
  funnelId: string;
  /** The raw custom_disclaimer_responses array from Graph, kept as the response evidence. */
  disclaimerResponses: PartnerDisclaimerResponse[] | null;
  phoneAsTyped: string | null;
  formPayload: Record<string, string>;
  adId: string | null;
  campaignId: string | null;
  createdTime: string | null;
}

export type PartnerConsentResult =
  | { status: "ok"; args: PartnerConsentArgs }
  | { status: "no_box" }
  | { status: "config_missing" }
  | { status: "text_too_long"; length: number };

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
  // Over-long wording is checked first: parseAllowlist drops the consent
  // config for it (flagging consentTextTooLong), so it would otherwise read
  // as config_missing and lose the loud error.
  if (config.consentTextTooLong) return { status: "text_too_long", length: config.consentTextTooLong };
  if (!config.consentKey || !config.consentText) return { status: "config_missing" };
  if (config.consentText.length > MAX_CONSENT_TEXT_LENGTH) {
    return { status: "text_too_long", length: config.consentText.length };
  }
  const box = getPartnerConsentBoxState(fetched.custom_disclaimer_responses, config.consentKey);
  if (box === "absent") return { status: "no_box" };
  const mapped = mapFieldData(fetched.field_data);
  return {
    status: "ok",
    args: {
      consentKey: PARTNER_CONSENT_KEY,
      consentGiven: box === "ticked",
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
