/**
 * Homeowner help-estimate (H7) data shapes — D-211.
 * The claims/carrier rows are owned by SQL (Tier-3, out of scope); these
 * interfaces describe only the columns this page reads. Loose by design.
 */

export type TriageSection = 'triage' | 'findit' | 'email' | 'explainer' | 'success';

export interface HelpEstimateClaim {
  id: string;
  claim_number?: string | null;
  carrier_id?: string | null;
  adjuster_name?: string | null;
  adjuster_email?: string | null;
  adjuster_phone?: string | null;
  [key: string]: unknown;
}

export interface HelpEstimateProfile {
  id: string;
  full_name?: string | null;
  phone?: string | null;
  [key: string]: unknown;
}

/** A carrier-specific search tip, rendered as SAFE JSX (never innerHTML). */
export type CarrierTip =
  | { kind: 'portal'; carrierName: string; url: string }
  | { kind: 'email'; email: string }
  | { kind: 'phone'; phone: string }
  | { kind: 'days'; carrierName: string; days: number }
  | { kind: 'text'; text: string };

export interface CarrierTips {
  title: string;
  tips: CarrierTip[];
}
