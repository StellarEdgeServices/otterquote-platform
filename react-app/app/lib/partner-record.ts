'use client';

import { supabase } from '@/lib/supabase';

/**
 * Partner (referral_agent) record resolution — D-211 (Phase 12, partner-dashboard).
 *
 * Factors the partner role-resolution out of the page so the next Partner page
 * (Phase 13 — refer-a-friend) can reuse it. Mirrors useContractorRecord, but the
 * partner resolution is referral_agents-TABLE-FIRST with the static page's
 * magic-link email-link fallback + the no-record decision:
 *
 *   1. Look up referral_agents by user_id.
 *   2. If none, look up by email where user_id IS NULL (the user just clicked a
 *      magic link and the record isn't linked yet). If found, LINK it (set
 *      user_id) and return it.
 *   3. Otherwise → { kind: 'no-record' } (the page bounces to the STATIC
 *      /partner-re.html signup chooser).
 *
 * This is a resolver, NOT a nav shell — the redirect decisions stay in the page
 * (consistent with the Phase-6 bare-page gating precedent). Network calls live
 * here; all branching logic the page renders on is the returned `kind`.
 *
 * The referral_agents UPDATE in step 2 reproduces the static init() byte-for-byte
 * (existing magic-link linking behavior) — it is NOT a Tier-3 change.
 */
export interface PartnerRecord {
  id: string;
  user_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  service_area?: string | null;
  website?: string | null;
  bio?: string | null;
  agent_type?: string | null;
  unique_code?: string | null;
  recruit_code?: string | null;
  recruited_by_id?: string | null;
  created_at?: string | null;
  payments_blocked?: boolean | null;
  w9_submitted_at?: string | null;
  w9_verified_at?: string | null;
  total_referrals?: number | null;
  total_commission_earned?: number | null;
  recruit_earnings?: number | null;
  [key: string]: unknown;
}

export type PartnerResolution =
  | { kind: 'ok'; partner: PartnerRecord }
  | { kind: 'no-record' };

/**
 * Resolve the current partner. See module docs for the referral_agents-table-first
 * order. Returns `{ kind: 'no-record' }` when neither a linked row (by user_id)
 * nor an unlinked row (by email) exists.
 */
export async function resolvePartnerRecord(
  userId: string,
  email: string,
): Promise<PartnerResolution> {
  // 1. Linked record (the common path).
  const { data: byUser, error: byUserError } = await supabase
    .from('referral_agents')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (byUser && !byUserError) {
    return { kind: 'ok', partner: byUser as PartnerRecord };
  }

  // 2. Unlinked record matched by email (just clicked the magic link) — link it.
  const { data: byEmail } = await supabase
    .from('referral_agents')
    .select('*')
    .eq('email', email)
    .is('user_id', null)
    .single();

  if (byEmail) {
    const rec = byEmail as PartnerRecord;
    // gh-2105 batch 4 -- class (c), NOT fixed: unreachable under current RLS. This branch cannot
    // run for a non-admin: the byEmail lookup above (.is('user_id', null)) runs as the partner and
    // no referral_agents SELECT policy exposes an unclaimed row (policies: user_id = auth.uid(),
    // is_admin_email(), recruits), so byEmail is always null here. Even if reached, UPDATE ...
    // RETURNING checks the existing row against the SELECT policies, so .select('id') would
    // return 0 rows, and the "Authenticated can claim unclaimed partner record" UPDATE policy is
    // unusable from this client for the same reason. A real linking path needs a separate fix (out of scope for this PR).
    // The guard below is defensive only: it never reports the record as linked unless a row came
    // back, and logs the failure.
    const { data: linkRows, error: linkErr } = await supabase
      .from('referral_agents')
      .update({ user_id: userId })
      .eq('id', rec.id)
      .select('id');
    if (linkErr || !Array.isArray(linkRows) || linkRows.length === 0) {
      console.error('[partner-record] magic-link user_id link failed:', linkErr ? linkErr.message : 'update_zero_rows: referral_agents (link user_id)');
      return { kind: 'ok', partner: rec };
    }
    return { kind: 'ok', partner: { ...rec, user_id: userId } };
  }

  // 3. No partner record at all.
  return { kind: 'no-record' };
}

/** Re-fetch the linked partner row by user_id (post-W-9-upload refresh). */
export async function fetchPartnerByUserId(userId: string): Promise<PartnerRecord | null> {
  const { data } = await supabase
    .from('referral_agents')
    .select('*')
    .eq('user_id', userId)
    .single();
  return (data as PartnerRecord) ?? null;
}
