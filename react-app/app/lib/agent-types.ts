/**
 * Agent-Type Label Maps (single source of truth) — React app side.
 *
 * gh-914: partner/referral agent-type label maps had 16 independent
 * declarations across 14 files. This module is the ONE place the React app
 * declares agent-type display strings; every consumer below imports from
 * here instead of hand-copying a local map.
 *
 * The static-HTML equivalent source is js/agent-types.js at the repo root.
 * tools/agent_type_labels_check.py — chained into scripts/ci-file-integrity.py,
 * which runs as the "Null-Byte & Size Sanity Check" CI job (this lane's push
 * credential cannot edit workflow files directly, gh-634/#873) — asserts the
 * two files' maps agree and fails if a new local agent-type label map
 * appears anywhere else in the repo.
 *
 * referral_agents.agent_type is constrained to exactly six values by
 * referral_agents_agent_type_check (supabase/migrations/20260101000000_v000_baseline_schema.sql):
 * 're_agent', 'insurance_agent', 'home_inspector', 'customer', 'adjuster',
 * 'other'. Every map below is keyed from that set (CHOOSER_LABELS omits
 * 'customer' — see its own comment for why).
 *
 * FOUR maps, not one flat object — see js/agent-types.js's file header for
 * the full rationale (mirrored here so this file is self-explanatory without
 * cross-referencing the static one). Short version: three of the four values
 * ('adjuster'/'other'/'customer') disagreed on the actual displayed string
 * before this refactor, and Dustin's gh-914 ruling (issue #914, "A-ANSWER"
 * comment, 2026-08-17) resolved PARTNER_DISPLAY_LABELS specifically:
 * adjuster -> 'Insurance Adjuster', other/customer -> 'Otter Quotes Partner'.
 * That ruling also named 'Roofing Contractor' as part of the "formal set" —
 * no agent_type value maps to it (not in the DB CHECK constraint, not in any
 * of the 16 source declarations read for this refactor). NOT applied here;
 * flagged back to the Bridge rather than guessed at silently.
 *
 * ADMIN_DROPDOWN_LABELS and ADMIN_BADGE stay distinct from
 * PARTNER_DISPLAY_LABELS: the admin correction dropdown and compact table
 * badge (admin-referrals.html / app/admin/referrals) are the surfaces where
 * an admin must be able to tell 'other' and 'customer' apart to correct a
 * mis-classified partner (gh-865) — collapsing both to the same friendly
 * string there would make two of the six options indistinguishable.
 */

export type AgentType =
  | 're_agent'
  | 'insurance_agent'
  | 'home_inspector'
  | 'customer'
  | 'adjuster'
  | 'other';

export interface AgentTypeBadge {
  label: string;
  className: string;
}

/**
 * The "confirm/pick your type" chooser set — no 'customer' key. Mirrors
 * js/agent-types.js's AGENT_TYPE_CHOOSER_LABELS exactly. Not currently
 * consumed by any React page (the signup choosers are all static HTML), but
 * kept in the single-source module so a future React signup surface doesn't
 * reintroduce a local copy.
 */
export const CHOOSER_LABELS: Record<Exclude<AgentType, 'customer'>, string> = {
  re_agent: 'Real Estate Agent',
  insurance_agent: 'Insurance Agent',
  home_inspector: 'Home Inspector',
  adjuster: 'Insurance Adjuster',
  other: 'Other',
};

/**
 * The friendly "here is your account type" badge — partner's own dashboard
 * badge + recruits-table type column. Mirrors js/agent-types.js's
 * AGENT_TYPE_PARTNER_DISPLAY_LABELS exactly.
 */
export const PARTNER_DISPLAY_LABELS: Record<AgentType, string> = {
  re_agent: 'Real Estate Agent',
  insurance_agent: 'Insurance Agent',
  home_inspector: 'Home Inspector',
  adjuster: 'Insurance Adjuster',
  customer: 'Otter Quotes Partner',
  other: 'Otter Quotes Partner',
};

/**
 * admin-referrals.html's openAgentTypeEditor() correction dropdown. Mirrors
 * js/agent-types.js's AGENT_TYPE_ADMIN_DROPDOWN_LABELS exactly.
 */
export const ADMIN_DROPDOWN_LABELS: Record<AgentType, string> = {
  re_agent: 'Real Estate Agent',
  insurance_agent: 'Insurance Agent',
  home_inspector: 'Home Inspector',
  customer: 'Customer',
  adjuster: 'Insurance Adjuster',
  other: 'Other',
};

/**
 * admin-referrals.html's typeBadge() compact table badge (label + CSS
 * modifier class per type). Mirrors js/agent-types.js's AGENT_TYPE_ADMIN_BADGE
 * exactly.
 */
export const ADMIN_BADGE: Record<AgentType, AgentTypeBadge> = {
  re_agent: { label: 'Real Estate Agent', className: 'badge-type-re' },
  insurance_agent: { label: 'Insurance', className: 'badge-type-ins' },
  home_inspector: { label: 'Inspector', className: 'badge-type-insp' },
  customer: { label: 'Customer', className: 'badge-type-cust' },
  adjuster: { label: 'Adjuster', className: 'badge-type-ins' },
  other: { label: 'Other', className: 'badge-type-cust' },
};
