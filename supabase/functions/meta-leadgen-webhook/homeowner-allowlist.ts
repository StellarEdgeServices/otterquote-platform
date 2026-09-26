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
// Format: JSON object, form_id -> { funnel_id, is_test? }, held in the
// META_LEADGEN_HOMEOWNER_FORM_ALLOWLIST env var (Supabase secret) -- same
// "config in an env var, not a table" precedent as allowlist.ts's own
// META_LEADGEN_FORM_ALLOWLIST, and the same is_test rationale (Meta
// documents no reliable Testing-Tool flag on the webhook payload or the
// Graph API lead object -- see allowlist.ts's header for the citation).
//
// A form_id present in BOTH allowlists is not possible in practice (Meta
// form ids are unique per form), but if it ever happened, handler.ts checks
// the PARTNER allowlist first -- see handler.ts's routing comment.

export interface HomeownerFormConfig {
  funnelId: string;
  isTest: boolean;
}

export type HomeownerAllowlist = Record<string, HomeownerFormConfig>;

/**
 * Parses META_LEADGEN_HOMEOWNER_FORM_ALLOWLIST. Malformed JSON, a
 * non-object top level, or an entry missing a non-empty funnel_id is
 * dropped (fails closed to "not allowlisted" for that entry, never
 * throws) -- same posture as allowlist.ts's parseAllowlist.
 */
export function parseHomeownerAllowlist(raw: string | undefined): HomeownerAllowlist {
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
    out[formId] = { funnelId, isTest: cfg.is_test === true };
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
