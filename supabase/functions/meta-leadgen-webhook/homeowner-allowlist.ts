// gh-2154 P-5 / #2123 (HO-2) — homeowner-form allowlist, the `leads` sibling
// of allowlist.ts's partner-form allowlist. Kept as a SEPARATE structure
// (separate env var, separate parse function, separate lookup) rather than
// widening PartnerFormConfig/Allowlist, for two reasons stated on #2154's
// Kevin's Q comment and repeated on #2123: (1) the partner path must stay
// byte-identical -- widening its shared type/parse function is a change to
// code the partner path also runs through, even if behaviourally inert; (2)
// a homeowner form has no agent_type (VALID_AGENT_TYPES has no "homeowner"
// member, and never should -- that set mirrors register_partner()'s
// p_agent_type CHECK, a table this insert never touches).
//
// Format: JSON object, form_id -> { funnel_id, is_test?, consent_key,
// consent_text, privacy_url }, held in the
// META_LEADGEN_HOMEOWNER_FORM_ALLOWLIST env var (Supabase secret) -- same
// "config in an env var, not a table" precedent as allowlist.ts's own
// META_LEADGEN_FORM_ALLOWLIST, and the same is_test rationale (Meta
// documents no reliable Testing-Tool flag on the webhook payload or the
// Graph API lead object -- see allowlist.ts's header for the citation).
//
// consent_key/consent_text/privacy_url (REVIEW FAIL 5849223003 defects 4/5,
// D-299/D-332) are REQUIRED per entry, not optional: an entry missing any of
// them is dropped entirely (the form is treated as not allowlisted, logged
// as a config error) rather than allowed through with unknown consent
// evidence or no privacy link. This fails closed the same way a missing
// funnel_id already did -- see parseHomeownerAllowlist below.
//   - consent_key: identifies which of the Meta form's custom disclaimer
//     checkboxes is the call/text consent one -- matched against Meta's
//     custom_disclaimer_responses[].id or .name (see homeowner-consent.ts).
//   - consent_text: the exact D-299-approved disclaimer text as rendered on
//     that Meta form, versioned -- stored verbatim as the evidence row's
//     consent_text.
//   - privacy_url: the Meta form's configured Privacy Policy link, which
//     D-332 requires to be https://otterquote.com/privacy.html (checked at
//     config-review time, not enforceable in code beyond requiring the
//     field be present -- see this build's PR body).
//
// A form_id present in BOTH allowlists is not possible in practice (Meta
// form ids are unique per form), but if it ever happened, handler.ts checks
// the PARTNER allowlist first -- see handler.ts's routing comment.

export interface HomeownerFormConfig {
  funnelId: string;
  isTest: boolean;
  consentKey: string;
  consentText: string;
  privacyUrl: string;
}

export type HomeownerAllowlist = Record<string, HomeownerFormConfig>;

/**
 * Parses META_LEADGEN_HOMEOWNER_FORM_ALLOWLIST. Malformed JSON, a
 * non-object top level, or an entry missing a non-empty funnel_id,
 * consent_key, consent_text, or privacy_url is dropped (fails closed to
 * "not allowlisted" for that entry, never throws) -- same posture as
 * allowlist.ts's parseAllowlist. A dropped entry that had a funnel_id (i.e.
 * looked like a real attempt, not just garbage) is reported through the
 * optional `log` callback as a config error, per REVIEW FAIL 5849223003
 * defect 4/5.
 */
export function parseHomeownerAllowlist(
  raw: string | undefined,
  log?: (message: string) => void,
): HomeownerAllowlist {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: HomeownerAllowlist = {};
  for (const [formId, cfgRaw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!formId || !cfgRaw || typeof cfgRaw !== "object") continue;
    const cfg = cfgRaw as Record<string, unknown>;
    const funnelId = typeof cfg.funnel_id === "string" ? cfg.funnel_id.trim() : "";
    if (!funnelId) continue;

    const consentKey = typeof cfg.consent_key === "string" ? cfg.consent_key.trim() : "";
    // REVIEW FAIL 5849684429 nit (optional, taken): capped at 2,000 chars,
    // matching Arm F's own consent_text cap (record-lead-details/handler.ts's
    // safeSlice(..., 2000)) -- config-supplied and already trusted, but this
    // keeps the two consent-evidence writers to the same bound rather than
    // relying on the DB column's own limit to catch an oversized value.
    const consentTextRaw = typeof cfg.consent_text === "string" ? cfg.consent_text.trim() : "";
    const consentText = consentTextRaw.length > 2000 ? consentTextRaw.slice(0, 2000) : consentTextRaw;
    const privacyUrl = typeof cfg.privacy_url === "string" ? cfg.privacy_url.trim() : "";
    if (!consentKey || !consentText || !privacyUrl) {
      log?.(
        `meta-leadgen-webhook: homeowner allowlist entry form_id=${formId} dropped -- ` +
          `missing required consent_key/consent_text/privacy_url (D-299/D-332 config error)`,
      );
      continue;
    }
    // REVIEW FAIL 5849684429 nit (optional, taken): D-332 requires the HO-2
    // Meta form's Privacy Policy link to be https://otterquote.com/privacy.html
    // -- enforced here in code (fail closed) rather than only at config
    // review time, so a mistyped/wrong privacy_url can never allowlist a
    // form.
    if (privacyUrl !== "https://otterquote.com/privacy.html") {
      log?.(
        `meta-leadgen-webhook: homeowner allowlist entry form_id=${formId} dropped -- ` +
          `privacy_url is not the otterquote.com privacy page (D-332 config error)`,
      );
      continue;
    }

    out[formId] = { funnelId, isTest: cfg.is_test === true, consentKey, consentText, privacyUrl };
  }
  return out;
}

export function lookupHomeownerForm(
  allowlist: HomeownerAllowlist,
  formId: string | null | undefined,
): HomeownerFormConfig | null {
  if (!formId) return null;
  return allowlist[formId] ?? null;
}
