// gh-2154 P-5 — partner-form allowlist.
//
// PARTNER PATH ONLY (Kevin's Q comment on #2154): a Meta lead form is
// processed by this function ONLY when its form_id appears here. Every
// other form_id — including any future homeowner `leads` form (#2123,
// explicitly excluded from this build by Dustin) — is a logged skip, no
// write, 200 (Meta must get a 200 or it will retry the same lead forever).
//
// Format: a JSON object, form_id -> { agent_type, funnel_id, is_test? },
// held in the META_LEADGEN_FORM_ALLOWLIST env var (Supabase secret), the
// same "config in an env var, not a table" precedent P-4's kill switch used
// for its OWN on/off flag (kill-switch.ts) — the difference here is this is
// a small, ops-owned MAPPING rather than a boolean, so it lives in a secret
// rather than platform_settings: it names Meta form ids and funnel ids,
// which are not secrets themselves but do vary per ad campaign and change
// more often than a migration-gated table row should. See this build's
// report for the QUESTION of whether this should move to platform_settings
// instead once there is more than a handful of forms.
//
// is_test (Kevin's Q comment + Meta's Lead Ads Testing Tool docs): Meta does
// not document a reliable field on the leadgen webhook payload or the
// Graph API lead object that distinguishes a Testing-Tool lead from a real
// one (no `is_organic`-equivalent flag is documented for this). Per the
// task's fallback instruction, is_test is therefore part of the allowlist
// entry itself: a form_id used ONLY for testing is configured with
// `is_test: true` and every lead through it is marked p_is_test=true,
// exactly like a dedicated test form. A form_id shared between real and
// Testing Tool traffic cannot be told apart by this function — see
// QUESTIONS in the report.

export interface PartnerFormConfig {
  agentType: string;
  funnelId: string;
  isTest: boolean;
}

export type Allowlist = Record<string, PartnerFormConfig>;

// Mirrors register_partner()'s p_agent_type CHECK (see
// supabase/migrations/20260924160000_gh2154_p2_partner_attribution_activation.sql).
const VALID_AGENT_TYPES = new Set([
  "re_agent",
  "insurance_agent",
  "home_inspector",
  "customer",
  "adjuster",
  "other",
]);

/**
 * Parses META_LEADGEN_FORM_ALLOWLIST. Malformed JSON, a non-object top
 * level, or an entry missing a valid agent_type/funnel_id is dropped
 * (fails closed to "not allowlisted" for that entry, never throws).
 */
export function parseAllowlist(raw: string | undefined): Allowlist {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Allowlist = {};
  for (const [formId, cfgRaw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!formId || !cfgRaw || typeof cfgRaw !== "object") continue;
    const cfg = cfgRaw as Record<string, unknown>;
    const agentType = typeof cfg.agent_type === "string" ? cfg.agent_type : "";
    const funnelId = typeof cfg.funnel_id === "string" ? cfg.funnel_id : "";
    if (!VALID_AGENT_TYPES.has(agentType) || !funnelId) continue;
    out[formId] = { agentType, funnelId, isTest: cfg.is_test === true };
  }
  return out;
}

export function lookupForm(allowlist: Allowlist, formId: string | null | undefined): PartnerFormConfig | null {
  if (!formId) return null;
  return allowlist[formId] ?? null;
}
