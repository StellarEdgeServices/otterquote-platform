/**
 * Homeowner bids data shapes (D-211 Phase 21 — H2, /bids).
 *
 * React port of the static bids.html "Your Bids" page. Like the dashboard
 * (and the shared use-claim-status hook), these interfaces describe only the
 * columns this page actually reads and are intentionally loose
 * ([key: string]: unknown) — the `quotes`/`claims`/`contractors` schema is
 * owned by SQL/migrations (out of scope here — Tier-3). `select('*')` returns
 * the full row at runtime; we cast to these shapes.
 *
 * NOTE on bid lifecycle vs. expiry: the `quotes` row carries BOTH `status`
 * (lifecycle: draft/submitted/selected/declined/expired) and `bid_status`
 * (the expiry-aware status the static page renders from). bids.html keys its
 * expired check on `bid_status === 'expired'`; the "expiring soon" state is
 * computed client-side from `expires_at`. We mirror that exactly.
 */

export type BidLifecycleStatus =
  | 'draft'
  | 'submitted'
  | 'selected'
  | 'declined'
  | 'expired'
  | string;

/** A bid (a `quotes` row) joined to its contractor for the claim. */
export interface BidRow {
  id: string;
  claim_id: string;
  contractor_id: string;
  total_price?: number | null;
  fee_amount?: number | null;
  fee_percentage?: number | null;
  /** Lifecycle status (award/decline). */
  status?: BidLifecycleStatus;
  /** Expiry-aware status the static page renders from ('expired' when lapsed). */
  bid_status?: BidLifecycleStatus;
  expires_at?: string | null;
  created_at?: string | null;
  start_date?: string | null;
  estimated_start_date?: string | null;
  estimated_completion_time?: string | null;
  scope_summary?: string | Record<string, unknown> | null;
  value_adds?: string | Record<string, unknown> | null;
  warranty_snapshot?: string | null;
  warranty_summary?: string | null;
  workmanship_warranty_years?: number | null;
  manufacturer_warranty_years?: number | null;
  per_trade_breakdown?: string | Record<string, unknown> | null;
  warranty_document_url?: string | null;
  [key: string]: unknown;
}

/** A `contractors` row as joined into the bid list (subset bids.html reads). */
export interface ContractorProfile {
  id: string;
  user_id?: string | null;
  company_name?: string | null;
  contact_name?: string | null;
  owner_photo_url?: string | null;
  about_us?: string | null;
  years_in_business?: number | null;
  service_area_description?: string | null;
  license_number?: string | null;
  verified?: boolean | null;
  rating?: number | null;
  review_count?: number | null;
  specialties?: string | string[] | null;
  website_url?: string | null;
  /** Resolved signed URL for owner_photo_url (filled client-side). */
  _resolvedPhotoUrl?: string | null;
  [key: string]: unknown;
}

/** The homeowner's claim row (subset this page reads). */
export interface BidsClaim {
  id: string;
  user_id: string;
  status?: string | null;
  property_address?: string | null;
  job_type?: string | null;
  trades?: string[] | null;
  has_measurements?: boolean | null;
  selected_contractor_id?: string | null;
  [key: string]: unknown;
}

/** Unread `bid_updated` notification surfaced as the "bids revised" banner. */
export interface BidNotification {
  id: string;
  message_preview?: string | null;
  created_at?: string | null;
}

/** A resolved comparison-grid cell. `key` drives identical-row dimming. */
export interface CompareCell {
  display: string;
  key: string;
  cls: 'cell-included' | 'cell-oop' | 'cell-excluded' | 'cell-na' | 'cell-accent' | '';
}
