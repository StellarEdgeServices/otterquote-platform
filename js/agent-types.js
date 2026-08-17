/**
 * OtterQuote — Agent-Type Label Maps (single source of truth)
 *
 * gh-914: partner/referral agent-type label maps had 16 independent
 * declarations across 14 files (#851's class — a hardcoded partner-role
 * array duplicated three ways — one layer up, on the *display strings*
 * rather than the role list itself). This file is the ONE place static
 * HTML pages declare agent-type display strings; every page below loads
 * it and reads AgentTypes.* instead of hand-copying a local map.
 *
 * The React app's equivalent source is react-app/app/lib/agent-types.ts.
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
 * FOUR maps, not one flat object — each serves a distinct UI purpose, and
 * three of the four ('adjuster'/'other'/'customer' specifically) disagreed
 * on the actual displayed string before this refactor. Forcing all sixteen
 * declarations into a single map would silently change visible copy on most
 * partner/admin surfaces at once, which gh-914's own prohibitions bar doing
 * unilaterally. Dustin's gh-914 ruling (issue #914, "A-ANSWER" comment,
 * 2026-08-17) resolved the PARTNER_DISPLAY_LABELS disagreement explicitly:
 * adjuster -> 'Insurance Adjuster', other/customer -> 'Otter Quotes Partner'.
 * That same ruling named a fourth string, 'Roofing Contractor', as part of
 * the "formal set" it was consolidating to — no agent_type value maps to it
 * (not in the DB CHECK constraint above, not in any of the 16 source
 * declarations this refactor read). It is NOT applied anywhere in this file;
 * flagged back to the Bridge rather than guessed at silently.
 *
 * ADMIN_DROPDOWN_LABELS and ADMIN_BADGE are deliberately left distinct from
 * PARTNER_DISPLAY_LABELS rather than folded into it: admin-referrals.html's
 * correction dropdown and compact table badge are the surfaces where an
 * admin must be able to tell 'other' and 'customer' apart to correct a
 * mis-classified partner (gh-865) — collapsing both to the same friendly
 * string there would make two of the six options indistinguishable, a
 * functional regression, not just a cosmetic one. Their content is
 * unchanged from the pre-refactor source (never disputed).
 */

/**
 * CHOOSER_LABELS — the "confirm/pick your type" dropdown a visitor sees
 * during signup (confirmAgentType() on partner-re/insurance/inspectors/
 * adjusters/other.html and inspector-landing.html; the five shared entries
 * in recruit.html's CHOOSER_OPTIONS). No 'customer' key — a homeowner
 * referred for their own project doesn't pick a partner type here, they get
 * a distinct full-sentence chooser entry instead (recruit.html only).
 * Unchanged content: all seven prior copies already agreed byte-for-byte,
 * so this set was never in dispute.
 */
var AGENT_TYPE_CHOOSER_LABELS = {
  re_agent: 'Real Estate Agent',
  insurance_agent: 'Insurance Agent',
  home_inspector: 'Home Inspector',
  adjuster: 'Insurance Adjuster',
  other: 'Other'
};

/**
 * PARTNER_DISPLAY_LABELS — the friendly "here is your account type" badge
 * shown to a partner about themselves or their recruits (partner-dashboard.html's
 * own-badge + recruits-table type column, partner-profile.html's public
 * badge, and the React partner dashboard's equivalents). Resolved per
 * Dustin's gh-914 ruling — see file header.
 */
var AGENT_TYPE_PARTNER_DISPLAY_LABELS = {
  re_agent: 'Real Estate Agent',
  insurance_agent: 'Insurance Agent',
  home_inspector: 'Home Inspector',
  adjuster: 'Insurance Adjuster',
  customer: 'Otter Quotes Partner',
  other: 'Otter Quotes Partner'
};

/**
 * ADMIN_DROPDOWN_LABELS — admin-referrals.html's openAgentTypeEditor()
 * partner-type correction dropdown (gh-865) and its React admin mirror.
 * Unchanged content — see file header for why this stays separate from
 * PARTNER_DISPLAY_LABELS.
 */
var AGENT_TYPE_ADMIN_DROPDOWN_LABELS = {
  re_agent: 'Real Estate Agent',
  insurance_agent: 'Insurance Agent',
  home_inspector: 'Home Inspector',
  customer: 'Customer',
  adjuster: 'Insurance Adjuster',
  other: 'Other'
};

/**
 * ADMIN_BADGE — admin-referrals.html's typeBadge() compact table badge
 * (label + CSS modifier class per type) and its React admin mirror.
 * Unchanged content.
 */
var AGENT_TYPE_ADMIN_BADGE = {
  re_agent: { label: 'Real Estate Agent', className: 'badge-type-re' },
  insurance_agent: { label: 'Insurance', className: 'badge-type-ins' },
  home_inspector: { label: 'Inspector', className: 'badge-type-insp' },
  customer: { label: 'Customer', className: 'badge-type-cust' },
  adjuster: { label: 'Adjuster', className: 'badge-type-ins' },
  other: { label: 'Other', className: 'badge-type-cust' }
};

window.AgentTypes = {
  CHOOSER_LABELS: AGENT_TYPE_CHOOSER_LABELS,
  PARTNER_DISPLAY_LABELS: AGENT_TYPE_PARTNER_DISPLAY_LABELS,
  ADMIN_DROPDOWN_LABELS: AGENT_TYPE_ADMIN_DROPDOWN_LABELS,
  ADMIN_BADGE: AGENT_TYPE_ADMIN_BADGE
};
