/**
 * Homeowner dashboard data shapes (D-211).
 *
 * The shared use-claim-status hook types ClaimData generically; the homeowner
 * `claims` row carries many more columns (status enum, *_bid_released_at, the
 * D-181 hover fields, etc.). These interfaces describe the columns this page
 * actually reads. They are intentionally loose ([key: string]: unknown) because
 * `select('*')` returns the full row and the schema is owned by SQL/migrations
 * (out of scope here — Tier-3).
 */

export type HomeownerClaimStatus =
  | 'draft'
  | 'active'
  | 'waitlisted'
  | 'contract_signed'
  | 'completed'
  | string;

export interface HomeownerClaim {
  id: string;
  user_id: string;
  status: HomeownerClaimStatus;
  property_state?: string | null;
  ready_for_bids?: boolean | null;
  has_estimate?: boolean | null;
  has_measurements?: boolean | null;
  has_material_selection?: boolean | null;
  funding_type?: string | null;
  trades?: string[] | null;
  completion_date?: string | null;
  estimated_start_date?: string | null;
  property_address?: string | null;
  selected_contractor_id?: string | null;
  ingest_email?: string | null;
  [key: string]: unknown;
}

export interface HomeownerProfile {
  id: string;
  full_name?: string | null;
  phone?: string | null;
  address_street?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_zip?: string | null;
  role?: string | null;
  [key: string]: unknown;
}

export interface HoverOrder {
  id: string;
  claim_id: string;
  status: string;
  capture_link?: string | null;
  capturing_user_email?: string | null;
  resend_count?: number | null;
  last_resend_at?: string | null;
  hover_job_id?: string | null;
  [key: string]: unknown;
}

/** D-181 — display-only rebate state. No charge logic on this page. */
export interface HoverRebateOrder {
  id: string;
  homeowner_charge_amount?: number | null;
  homeowner_stripe_payment_intent_id?: string | null;
  rebate_due?: boolean | null;
  rebate_paid_at?: string | null;
  [key: string]: unknown;
}

export interface ClaimMessage {
  id: string;
  sender_id: string;
  sender_role: string;
  body: string;
  created_at: string;
  profiles?: { full_name?: string | null } | null;
  [key: string]: unknown;
}

export interface CarrierOption {
  id: string;
  name: string;
}
