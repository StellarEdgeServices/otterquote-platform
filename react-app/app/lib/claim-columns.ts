// [gh-2881 / D-390] Homeowner-typed text on public.claims (homeowner_notes, urgency_reason, project_confirmation) is NOT selectable by the browser role
// (supabase/migrations_drafts/gh2881_claims_private_text_column_grants.sql). A browser read of a claim therefore names its columns, and the claim's
// owner reads the three private columns through the claim_private_text() RPC. This list is every public.claims column except those three, as of
// 2026-10-19 (read from information_schema). Typed as '*' on purpose (the callers were `select('*')`): supabase-js then keeps returning loosely typed rows exactly as before; a plain string makes it return GenericStringError. A column added to claims later must be added here AND granted to authenticated.
// tests/gh2881-claims-no-star-select.mjs keeps this list identical to the literal inlined in the static pages.
export const CLAIM_PUBLIC_COLUMNS =
  'id, user_id, claim_number, status, created_at, updated_at, carrier_id, adjuster_id, adjuster_name, adjuster_email, adjuster_phone, ingest_email, material_category, shingle_type, impact_class, designer_product, designer_manufacturer, metal_type, metal_material, color_brand, color_name, color_selected_at, color_addendum_signed, hover_order_id, hover_status, hover_paid, hover_rebated, has_estimate, has_measurements, has_material_selection, ready_for_bids, bids_submitted_at, selected_contractor_id, contract_signed_at, docusign_envelope_id, deductible_amount, deductible_collected, deductible_stripe_id, platform_fee_charged, platform_fee_amount, platform_fee_stripe_id, estimate_filename, measurements_filename, date_of_loss, damage_type, job_type, rcv_amount, acv_amount, roof_squares, repair_squares, existing_shingle_brand, existing_shingle_product, existing_shingle_color, urgency, urgency_deadline, referral_code, referral_id, policy_type, funding_type, trades, repair_type, repair_description, repair_shingle_count, roof_age_years, material_id_method, material_id_status, itel_order_id, itel_status, ai_id_confidence, trade_intents, color_confirmation_envelope_id, contract_sent_at, contract_signed_by, selected_bid_amount, deductible_collected_at, homeowner_name, contract_declined_at, contract_voided_at, color_confirmed_at, property_address, ingest_email_address, parsed_line_items, contractor_scope_summary, loss_sheet_parsed_at, project_confirmation_envelope_id, referral_source, referral_agent_id, contractor_switched_at, contractor_switch_count, siding_bid_released_at, roofing_bid_released_at, gutters_bid_released_at, windows_bid_released_at, bid_window_expires_at, bid_window_notified_at, property_state, switch_reason_survey, completion_date, video_url, profile_prompt_sent_at, is_test, carrier_name, hover_measurements, project_confirmation_signed_at, referrer_updates_opt_out, measurement_shape, live_charge_authorized_at, live_charge_authorized_by, loss_sheet_reviewed_at, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid, first_touch_landing_path, first_touch_referrer, first_touch_at, property_city, property_zip, signed_contract_price, signed_price_raw, signed_price_verdict, signed_price_reason, signed_price_checked_at, out_of_state_alerted_at, contractor_released_at' as unknown as '*';

export interface ClaimPrivateText {
  homeowner_notes: string | null;
  urgency_reason: string | null;
  project_confirmation: Record<string, unknown> | null;
}

// deno-lint-ignore no-explicit-any
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };

/** The owner's read of the three private columns. Returns null when the RPC errors or returns no row (the caller treats that as "not loaded"). */
export async function fetchClaimPrivateText(client: RpcClient, claimId: string): Promise<ClaimPrivateText | null> {
  try {
    const { data, error } = await client.rpc('claim_private_text', { p_claim_id: claimId });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return row ? (row as ClaimPrivateText) : null;
  } catch {
    return null;
  }
}
