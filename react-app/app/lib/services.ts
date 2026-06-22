'use client';

/**
 * OtterQuote — Service Integration Helpers (typed port of js/services.js, D-211).
 *
 * Thin client-side wrappers over the shared `supabase` singleton (table
 * reads/writes) and/or supabase.functions.invoke('<edge-function>') against the
 * ALREADY-DEPLOYED Edge Functions. The actual calls to Mailgun (email), Twilio
 * (SMS), Stripe (payments), and DocuSign (e-sign) happen server-side inside those
 * Edge Functions so API keys never reach the browser.
 *
 * This is the homeowner-track Services LAYER — the dashboard uses only a subset,
 * but the full layer lands here so the help-* pages can reuse it. Behaviour
 * (payloads, guards, graceful Edge-Function-pending fallbacks) is preserved
 * verbatim from the static js/services.js; only the legacy global `sb`/`CONFIG`
 * references are replaced with the singleton + NEXT_PUBLIC_* config.
 */

import { supabase } from '@/lib/supabase';

// CONFIG.INGEST_EMAIL_DOMAIN in the static stack (js/config.js). Not a secret.
const INGEST_EMAIL_DOMAIN =
  process.env.NEXT_PUBLIC_INGEST_EMAIL_DOMAIN || 'claims.otterquote.com';

// ── Param / return shapes ──────────────────────────────────────────────────

export type AdjusterRequestType = 'estimate' | 'measurements' | 'both';

export interface SendAdjusterEmailParams {
  claim_id: string;
  adjuster_name: string;
  adjuster_email: string;
  homeowner_name: string;
  homeowner_phone: string;
  claim_number?: string;
  request_type?: AdjusterRequestType;
}

export interface SendAdjusterEmailResult {
  success: boolean;
  ingest_email: string;
  request_id: string;
  edge_function_pending?: boolean;
}

export interface SendSMSParams {
  to: string;
  message: string;
  user_id?: string;
  claim_id?: string;
  notification_type?: string;
}

export interface SendSMSResult {
  success: boolean;
  logged: boolean;
  sent: boolean;
}

export interface SendAdjusterFollowupParams {
  homeowner_phone: string;
  adjuster_name: string;
  adjuster_phone?: string | null;
  user_id?: string;
  claim_id?: string;
}

export interface CreateHoverPaymentIntentParams {
  claim_id: string;
  amount: number; // cents
  description?: string;
}

export interface CreateDeductiblePaymentIntentParams {
  claim_id: string;
  amount: number; // cents
  homeowner_name: string;
}

export interface PaymentIntentResult {
  client_secret: string | null;
  placeholder?: boolean;
}

export interface CreateContractEnvelopeParams {
  claim_id: string;
  homeowner_name: string;
  homeowner_email: string;
  contractor_name: string;
  contract_data?: Record<string, unknown>;
}

export interface CreateContractEnvelopeResult {
  envelope_id: string | null;
  signing_url: string | null;
  placeholder?: boolean;
}

export interface CreateHoverOrderParams {
  claim_id: string;
  user_id: string;
  address_line_1: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  homeowner_name: string;
  homeowner_email: string;
  homeowner_phone?: string | null;
  amount_charged: number;
  /** REQUIRED per D-205. Must be 2 (Roof Only) or 3 (Complete). No default. */
  deliverable_type_id: number;
  /** D-181: required — Stripe PaymentIntent for the Hover fee. */
  payment_intent_id?: string;
}

export interface CreateHoverOrderResult {
  order_id: string;
  capture_link: string | null;
  capture_request_id?: string;
  identifier?: string;
  pending_job_id?: string;
  placeholder?: boolean;
  message?: string;
}

export interface AdjusterRecord {
  id: string;
  adjuster_name: string;
  adjuster_email: string | null;
  adjuster_phone: string | null;
  carrier_id: string | null;
  [key: string]: unknown;
}

export interface FindOrCreateAdjusterParams {
  adjuster_name: string;
  adjuster_email?: string | null;
  adjuster_phone?: string | null;
  carrier_id?: string | null;
}

export interface CarrierProfile {
  id: string;
  carrier_name: string;
  [key: string]: unknown;
}

// ── Utility ──────────────────────────────────────────────────────────────

/**
 * Normalize a US phone number to E.164 format.
 * (317) 555-1234 → +13175551234
 */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return `+${digits}`;
}

// ── Mailgun — Adjuster Email (D-043, D-045, D-048) ──────────────────────────

/**
 * Send an email to the adjuster requesting documents.
 * Creates an ingest email address for auto-reply capture.
 */
async function sendAdjusterEmail(
  params: SendAdjusterEmailParams,
): Promise<SendAdjusterEmailResult> {
  const {
    claim_id,
    adjuster_name,
    adjuster_email,
    homeowner_name,
    homeowner_phone,
    claim_number,
    request_type = 'estimate',
  } = params;

  // Generate unique ingest email address for this request
  const ingestId = crypto.randomUUID().split('-')[0]; // short unique ID
  const ingestEmail = `docs-${ingestId}@${INGEST_EMAIL_DOMAIN}`;

  // Build email subject
  let subject = `Request for Insurance Estimate`;
  if (request_type === 'measurements') subject = `Request for Property Measurements`;
  if (request_type === 'both') subject = `Request for Insurance Estimate & Measurements`;
  if (claim_number) subject += ` — ${homeowner_name}, Claim #${claim_number}`;
  else subject += ` — ${homeowner_name}`;

  // Build email body based on request type
  let body = `Hi ${adjuster_name},\n\n`;

  if (request_type === 'estimate' || request_type === 'both') {
    body += `I'm following up on my recent property inspection. Could you please send me a copy of my insurance estimate (scope of loss) at your earliest convenience?\n\n`;
  }

  if (request_type === 'measurements' || request_type === 'both') {
    body += `I would also appreciate any property measurements you have on file from the inspection, if available.\n\n`;
  }

  body += `You can reply directly to this email with the documents attached.\n\n`;
  body += `Thank you,\n${homeowner_name}\n${homeowner_phone}`;

  // Save the request to the database
  const { data: requestData, error: dbError } = await supabase
    .from('adjuster_email_requests')
    .insert({
      claim_id,
      to_email: adjuster_email,
      to_name: adjuster_name,
      request_type,
      ingest_email: ingestEmail,
    })
    .select()
    .single();

  if (dbError) throw dbError;

  // Update the claim with the ingest email
  await supabase
    .from('claims')
    .update({ ingest_email: ingestEmail })
    .eq('id', claim_id);

  // Call Edge Function to actually send via Mailgun (handles Mailgun API call +
  // setting reply-to to ingestEmail). Invoked via the authenticated session.
  try {
    const { error } = await supabase.functions.invoke('send-adjuster-email', {
      body: {
        to: adjuster_email,
        to_name: adjuster_name,
        subject,
        body,
        reply_to: ingestEmail,
        request_id: requestData.id,
      },
    });

    if (error) {
      console.warn('Edge function not yet deployed. Email request saved to database.', error);
      return {
        success: true, // Request saved even if email didn't send yet
        ingest_email: ingestEmail,
        request_id: requestData.id,
        edge_function_pending: true,
      };
    }

    return { success: true, ingest_email: ingestEmail, request_id: requestData.id };
  } catch (err) {
    // Edge function may not be deployed yet — that's OK, request is saved
    console.warn('Edge function call failed (may not be deployed):', err);
    return {
      success: true,
      ingest_email: ingestEmail,
      request_id: requestData.id,
      edge_function_pending: true,
    };
  }
}

// ── Twilio — SMS Notifications (D-060) ──────────────────────────────────────

/** Send an SMS notification. */
async function sendSMS(params: SendSMSParams): Promise<SendSMSResult> {
  const { to, message, user_id, claim_id, notification_type } = params;

  // Normalize phone to E.164
  const cleanPhone = normalizePhone(to);

  // Log the notification attempt
  const { data: logEntry } = await supabase
    .from('notifications')
    .insert({
      user_id,
      claim_id,
      channel: 'sms',
      notification_type,
      recipient: cleanPhone,
      message_preview: message.substring(0, 100),
    })
    .select()
    .single();

  // Call Edge Function to send via Twilio
  try {
    const { data, error } = await supabase.functions.invoke('send-sms', {
      body: {
        to: cleanPhone,
        message,
        notification_id: logEntry?.id,
      },
    });

    if (error) {
      console.warn('SMS Edge function not deployed yet.', error);
      return { success: true, logged: true, sent: false };
    }

    // Update notification log with Twilio SID
    if (logEntry && data?.sid) {
      await supabase
        .from('notifications')
        .update({ twilio_sid: data.sid, delivered: true })
        .eq('id', logEntry.id);
    }

    return { success: true, logged: true, sent: true };
  } catch (err) {
    console.warn('SMS send failed (edge function may not be deployed):', err);
    return { success: true, logged: true, sent: false };
  }
}

/**
 * Send a 48-hour follow-up text recommending the homeowner call their adjuster.
 */
async function sendAdjusterFollowup(
  params: SendAdjusterFollowupParams,
): Promise<SendSMSResult> {
  const { homeowner_phone, adjuster_name, adjuster_phone, user_id, claim_id } = params;

  const message = adjuster_phone
    ? `Hi! We haven't received your insurance documents yet. We'd recommend giving your adjuster ${adjuster_name} a call at ${adjuster_phone}. When you call, just say: "Hi, this is [your name]. I'm following up on my claim — could you send me my estimate and any measurements you have?" - OtterQuote`
    : `Hi! We haven't received your insurance documents yet. We'd recommend calling your adjuster ${adjuster_name} directly. Just ask for your estimate and any property measurements. - OtterQuote`;

  return sendSMS({
    to: homeowner_phone,
    message,
    user_id,
    claim_id,
    notification_type: 'adjuster_followup_call',
  });
}

// ── Stripe — Payments (D-029, D-036) ────────────────────────────────────────

/** Create a payment intent for Hover measurement purchase. */
async function createHoverPaymentIntent(
  params: CreateHoverPaymentIntentParams,
): Promise<PaymentIntentResult> {
  const { claim_id, amount, description } = params;

  try {
    const { data, error } = await supabase.functions.invoke('create-payment-intent', {
      body: {
        amount,
        currency: 'usd',
        description: description || 'Hover Complete Property Data File',
        metadata: {
          claim_id,
          type: 'hover_measurement',
        },
      },
    });

    if (error) throw error;
    return data as PaymentIntentResult; // { client_secret }
  } catch (err) {
    console.warn('Stripe Edge function not deployed:', err);
    return { client_secret: null, placeholder: true };
  }
}

/** Create a payment intent for deductible escrow collection. */
async function createDeductiblePaymentIntent(
  params: CreateDeductiblePaymentIntentParams,
): Promise<PaymentIntentResult> {
  const { claim_id, amount, homeowner_name } = params;

  try {
    const { data, error } = await supabase.functions.invoke('create-payment-intent', {
      body: {
        amount,
        currency: 'usd',
        description: `Deductible escrow — ${homeowner_name}`,
        metadata: {
          claim_id,
          type: 'deductible_escrow',
        },
      },
    });

    if (error) throw error;
    return data as PaymentIntentResult;
  } catch (err) {
    console.warn('Stripe Edge function not deployed:', err);
    return { client_secret: null, placeholder: true };
  }
}

// ── DocuSign — E-Signatures (D-032) ─────────────────────────────────────────

/** Create a DocuSign envelope for contract signing. */
async function createContractEnvelope(
  params: CreateContractEnvelopeParams,
): Promise<CreateContractEnvelopeResult> {
  const { claim_id, homeowner_name, homeowner_email, contractor_name, contract_data } = params;

  try {
    const { data, error } = await supabase.functions.invoke('create-docusign-envelope', {
      body: {
        claim_id,
        signer: {
          name: homeowner_name,
          email: homeowner_email,
        },
        contractor_name,
        contract_data,
      },
    });

    if (error) throw error;
    return data as CreateContractEnvelopeResult; // { envelope_id, signing_url }
  } catch (err) {
    console.warn('DocuSign Edge function not deployed:', err);
    return { envelope_id: null, signing_url: null, placeholder: true };
  }
}

// ── Hover — Measurement Orders (D-036, D-047) ───────────────────────────────

/**
 * Create a Hover measurement order and get the photo capture link.
 * Uses OAuth-authenticated capture-requests API (v2) via the create-hover-order EF.
 */
async function createHoverOrder(
  params: CreateHoverOrderParams,
): Promise<CreateHoverOrderResult> {
  const {
    claim_id,
    user_id,
    address_line_1,
    address_city,
    address_state,
    address_zip,
    homeowner_name,
    homeowner_email,
    homeowner_phone,
    amount_charged,
    deliverable_type_id,
    payment_intent_id, // D-181: required — Stripe PaymentIntent for the Hover fee
  } = params;

  if (!payment_intent_id) {
    throw new Error('Missing payment_intent_id — Hover payment must complete before ordering (D-181).');
  }
  // D-205: deliverable_type_id is required and must be 2 or 3. Fail loud at the client too.
  if (deliverable_type_id !== 2 && deliverable_type_id !== 3) {
    throw new Error('Missing or invalid deliverable_type_id — must be 2 (Roof Only) or 3 (Complete) per D-205.');
  }

  // Save order to database first
  const { data: order, error } = await supabase
    .from('hover_orders')
    .insert({
      claim_id,
      user_id,
      status: 'pending',
      amount_charged,
      deliverable_type_id,
      capturing_user_email: homeowner_email,
      capturing_user_phone: homeowner_phone || null,
    })
    .select()
    .single();

  if (error) throw error;

  // Call Edge Function to create Hover capture request via OAuth API
  try {
    const { data: hoverData, error: hoverError } = await supabase.functions.invoke(
      'create-hover-order',
      {
        body: {
          order_id: order.id,
          claim_id,
          address_line_1,
          address_city,
          address_state,
          address_zip,
          homeowner_name,
          homeowner_email,
          homeowner_phone,
          deliverable_type_id,
          payment_intent_id, // D-181
        },
      },
    );

    if (hoverError) {
      console.warn('Hover order creation failed:', hoverError);
      return {
        order_id: order.id,
        capture_link: null,
        placeholder: true,
        message: 'Hover order creation failed. Please try again.',
      };
    }

    return {
      order_id: order.id,
      capture_link: hoverData.capture_link,
      capture_request_id: hoverData.capture_request_id,
      identifier: hoverData.identifier,
      pending_job_id: hoverData.pending_job_id,
    };
  } catch (err) {
    console.warn('Hover API call failed:', err);
    return { order_id: order.id, capture_link: null, placeholder: true };
  }
}

// ── Lookups (D-046) ─────────────────────────────────────────────────────────

/** Generate a carrier-specific help message based on carrier_profiles data. */
async function getCarrierHelp(carrier_id: string | null): Promise<CarrierProfile | null> {
  if (!carrier_id) return null;
  const { data, error } = await supabase
    .from('carrier_profiles')
    .select('*')
    .eq('id', carrier_id)
    .single();
  if (error) return null;
  return data as CarrierProfile;
}

/** Look up or create an adjuster record (D-046 — auto-fill for repeat adjusters). */
async function findOrCreateAdjuster(
  params: FindOrCreateAdjusterParams,
): Promise<AdjusterRecord | null> {
  const { adjuster_name, adjuster_email, adjuster_phone, carrier_id } = params;

  // Try to find existing adjuster
  let query = supabase.from('adjusters').select('*');

  if (adjuster_email) {
    query = query.eq('adjuster_email', adjuster_email);
  } else if (adjuster_name && carrier_id) {
    query = query.eq('adjuster_name', adjuster_name).eq('carrier_id', carrier_id);
  } else {
    return null;
  }

  const { data: existing } = await query.maybeSingle();

  if (existing) {
    // Update with any new info
    const updates: Record<string, unknown> = {};
    if (adjuster_phone && !existing.adjuster_phone) updates.adjuster_phone = adjuster_phone;
    if (adjuster_name && existing.adjuster_name !== adjuster_name) updates.adjuster_name = adjuster_name;

    if (Object.keys(updates).length > 0) {
      await supabase.from('adjusters').update(updates).eq('id', existing.id);
    }

    return existing as AdjusterRecord;
  }

  const { data: newAdj, error } = await supabase
    .from('adjusters')
    .insert({
      adjuster_name,
      adjuster_email: adjuster_email || null,
      adjuster_phone: adjuster_phone || null,
      carrier_id: carrier_id || null,
    })
    .select()
    .single();

  if (error) throw error;
  return newAdj as AdjusterRecord;
}

/**
 * Aggregate object mirroring the static `Services` global, so help-* pages can
 * call `Services.<method>(...)` exactly as before. Individual functions are also
 * exported by name for ergonomic imports.
 */
export const Services = {
  sendAdjusterEmail,
  sendSMS,
  sendAdjusterFollowup,
  createHoverPaymentIntent,
  createDeductiblePaymentIntent,
  createContractEnvelope,
  createHoverOrder,
  getCarrierHelp,
  findOrCreateAdjuster,
  _normalizePhone: normalizePhone,
};

export {
  sendAdjusterEmail,
  sendSMS,
  sendAdjusterFollowup,
  createHoverPaymentIntent,
  createDeductiblePaymentIntent,
  createContractEnvelope,
  createHoverOrder,
  getCarrierHelp,
  findOrCreateAdjuster,
  normalizePhone,
};
