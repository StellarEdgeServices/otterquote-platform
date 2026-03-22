/**
 * OtterQuote — Service Integration Helpers
 * Mailgun (email), Twilio (SMS), Stripe (payments), DocuSign (e-sign)
 *
 * NOTE: These are client-side helper functions that prepare data
 * for server-side Supabase Edge Functions. The actual API calls
 * to Mailgun, Twilio, Stripe, and DocuSign MUST happen server-side
 * to protect API keys. These helpers format the requests and call
 * Supabase Edge Functions as the intermediary.
 *
 * Edge Functions to create:
 *   - send-adjuster-email   (Mailgun)
 *   - send-sms              (Twilio)
 *   - create-payment-intent  (Stripe)
 *   - create-docusign-envelope (DocuSign)
 */

const Services = {

  // ================================================================
  // MAILGUN — Adjuster Email (D-043, D-045, D-048)
  // ================================================================

  /**
   * Send an email to the adjuster requesting documents.
   * Creates an ingest email address for auto-reply capture.
   *
   * @param {Object} params
   * @param {string} params.claim_id
   * @param {string} params.adjuster_name
   * @param {string} params.adjuster_email
   * @param {string} params.homeowner_name
   * @param {string} params.homeowner_phone
   * @param {string} params.claim_number (optional)
   * @param {string} params.request_type — 'estimate', 'measurements', or 'both'
   * @returns {Object} { success, ingest_email, request_id }
   */
  async sendAdjusterEmail(params) {
    const {
      claim_id, adjuster_name, adjuster_email,
      homeowner_name, homeowner_phone, claim_number,
      request_type = 'estimate'
    } = params;

    // Generate unique ingest email address for this request
    const ingestId = crypto.randomUUID().split('-')[0]; // short unique ID
    const ingestEmail = `docs-${ingestId}@${CONFIG.INGEST_EMAIL_DOMAIN}`;

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
    const { data: requestData, error: dbError } = await sb
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
    await sb
      .from('claims')
      .update({ ingest_email: ingestEmail })
      .eq('id', claim_id);

    // Call Edge Function to actually send via Mailgun
    // The Edge Function handles: Mailgun API call, setting reply-to to ingestEmail
    try {
      const { data, error } = await sb.functions.invoke('send-adjuster-email', {
        body: {
          to: adjuster_email,
          to_name: adjuster_name,
          subject,
          body,
          reply_to: ingestEmail,
          request_id: requestData.id,
        }
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
  },


  // ================================================================
  // TWILIO — SMS Notifications (D-060)
  // ================================================================

  /**
   * Send an SMS notification.
   *
   * @param {Object} params
   * @param {string} params.to — Phone number (E.164 format preferred)
   * @param {string} params.message — SMS body (160 chars recommended)
   * @param {string} params.user_id — For logging
   * @param {string} params.claim_id — For logging
   * @param {string} params.notification_type — e.g., 'bid_received', 'estimate_arrived'
   */
  async sendSMS(params) {
    const { to, message, user_id, claim_id, notification_type } = params;

    // Normalize phone to E.164
    const cleanPhone = this._normalizePhone(to);

    // Log the notification attempt
    const { data: logEntry } = await sb
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
      const { data, error } = await sb.functions.invoke('send-sms', {
        body: {
          to: cleanPhone,
          message,
          notification_id: logEntry?.id,
        }
      });

      if (error) {
        console.warn('SMS Edge function not deployed yet.', error);
        return { success: true, logged: true, sent: false };
      }

      // Update notification log with Twilio SID
      if (logEntry && data?.sid) {
        await sb
          .from('notifications')
          .update({ twilio_sid: data.sid, delivered: true })
          .eq('id', logEntry.id);
      }

      return { success: true, logged: true, sent: true };
    } catch (err) {
      console.warn('SMS send failed (edge function may not be deployed):', err);
      return { success: true, logged: true, sent: false };
    }
  },

  /**
   * Send a 48-hour follow-up text recommending the homeowner call their adjuster.
   */
  async sendAdjusterFollowup(params) {
    const { homeowner_phone, adjuster_name, adjuster_phone, user_id, claim_id } = params;

    const message = adjuster_phone
      ? `Hi! We haven't received your insurance documents yet. We'd recommend giving your adjuster ${adjuster_name} a call at ${adjuster_phone}. When you call, just say: "Hi, this is [your name]. I'm following up on my claim — could you send me my estimate and any measurements you have?" - OtterQuote`
      : `Hi! We haven't received your insurance documents yet. We'd recommend calling your adjuster ${adjuster_name} directly. Just ask for your estimate and any property measurements. - OtterQuote`;

    return this.sendSMS({
      to: homeowner_phone,
      message,
      user_id,
      claim_id,
      notification_type: 'adjuster_followup_call',
    });
  },


  // ================================================================
  // STRIPE — Payments (D-029, D-036)
  // ================================================================

  /**
   * Create a payment intent for Hover measurement purchase.
   *
   * @param {Object} params
   * @param {string} params.claim_id
   * @param {number} params.amount — In cents (e.g., 4900 for $49.00)
   * @param {string} params.description
   * @returns {Object} { client_secret } — For Stripe.js confirmPayment
   */
  async createHoverPaymentIntent(params) {
    const { claim_id, amount, description } = params;

    try {
      const { data, error } = await sb.functions.invoke('create-payment-intent', {
        body: {
          amount,
          currency: 'usd',
          description: description || 'Hover 3D Measurement Report',
          metadata: {
            claim_id,
            type: 'hover_measurement',
          },
        }
      });

      if (error) throw error;
      return data; // { client_secret }
    } catch (err) {
      console.warn('Stripe Edge function not deployed:', err);
      return { client_secret: null, placeholder: true };
    }
  },

  /**
   * Create a payment intent for deductible escrow collection.
   */
  async createDeductiblePaymentIntent(params) {
    const { claim_id, amount, homeowner_name } = params;

    try {
      const { data, error } = await sb.functions.invoke('create-payment-intent', {
        body: {
          amount,
          currency: 'usd',
          description: `Deductible escrow — ${homeowner_name}`,
          metadata: {
            claim_id,
            type: 'deductible_escrow',
          },
        }
      });

      if (error) throw error;
      return data;
    } catch (err) {
      console.warn('Stripe Edge function not deployed:', err);
      return { client_secret: null, placeholder: true };
    }
  },


  // ================================================================
  // DOCUSIGN — E-Signatures (D-032)
  // ================================================================

  /**
   * Create a DocuSign envelope for contract signing.
   *
   * @param {Object} params
   * @param {string} params.claim_id
   * @param {string} params.homeowner_name
   * @param {string} params.homeowner_email
   * @param {string} params.contractor_name
   * @param {Object} params.contract_data — Fields to auto-populate
   * @returns {Object} { envelope_id, signing_url }
   */
  async createContractEnvelope(params) {
    const { claim_id, homeowner_name, homeowner_email, contractor_name, contract_data } = params;

    try {
      const { data, error } = await sb.functions.invoke('create-docusign-envelope', {
        body: {
          claim_id,
          signer: {
            name: homeowner_name,
            email: homeowner_email,
          },
          contractor_name,
          contract_data,
        }
      });

      if (error) throw error;
      return data; // { envelope_id, signing_url }
    } catch (err) {
      console.warn('DocuSign Edge function not deployed:', err);
      return { envelope_id: null, signing_url: null, placeholder: true };
    }
  },


  // ================================================================
  // HOVER — Measurement Orders (D-036, D-047)
  // ================================================================

  /**
   * Create a Hover measurement order and get the photo capture link.
   *
   * @param {Object} params
   * @param {string} params.claim_id
   * @param {string} params.user_id
   * @param {string} params.address
   * @param {number} params.amount_charged — In dollars
   * @returns {Object} { hover_link, order_id }
   */
  async createHoverOrder(params) {
    const { claim_id, user_id, address, amount_charged } = params;

    // Save order to database
    const { data: order, error } = await sb
      .from('hover_orders')
      .insert({
        claim_id,
        user_id,
        status: 'pending',
        amount_charged,
      })
      .select()
      .single();

    if (error) throw error;

    // Call Edge Function to create Hover job via API
    try {
      const { data: hoverData, error: hoverError } = await sb.functions.invoke('create-hover-order', {
        body: {
          order_id: order.id,
          address,
          claim_id,
        }
      });

      if (hoverError) {
        console.warn('Hover Edge function not deployed:', hoverError);
        return {
          order_id: order.id,
          hover_link: null,
          placeholder: true,
          message: 'Hover API integration pending. Order saved.',
        };
      }

      // Update order with Hover job ID and link
      await sb
        .from('hover_orders')
        .update({
          hover_job_id: hoverData.job_id,
          hover_link: hoverData.capture_link,
          status: 'photos_submitted',
        })
        .eq('id', order.id);

      return {
        order_id: order.id,
        hover_link: hoverData.capture_link,
        hover_job_id: hoverData.job_id,
      };
    } catch (err) {
      console.warn('Hover API call failed:', err);
      return { order_id: order.id, hover_link: null, placeholder: true };
    }
  },


  // ================================================================
  // UTILITY
  // ================================================================

  /**
   * Normalize a US phone number to E.164 format.
   * (317) 555-1234 → +13175551234
   */
  _normalizePhone(phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
    return `+${digits}`;
  },

  /**
   * Generate a carrier-specific help message based on carrier_profiles data.
   */
  async getCarrierHelp(carrier_id) {
    if (!carrier_id) return null;
    const { data, error } = await sb
      .from('carrier_profiles')
      .select('*')
      .eq('id', carrier_id)
      .single();
    if (error) return null;
    return data;
  },

  /**
   * Look up or create an adjuster record (D-046 — auto-fill for repeat adjusters).
   */
  async findOrCreateAdjuster(params) {
    const { adjuster_name, adjuster_email, adjuster_phone, carrier_id } = params;

    // Try to find existing adjuster
    let query = sb.from('adjusters').select('*');

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
      const updates = {};
      if (adjuster_phone && !existing.adjuster_phone) updates.adjuster_phone = adjuster_phone;
      if (adjuster_name && existing.adjuster_name !== adjuster_name) updates.adjuster_name = adjuster_name;

      if (Object.keys(updates).length > 0) {
        await sb.from('adjusters').update(updates).eq('id', existing.id);
      }

      return existing;
    }

    // Create new adjuster
    const { data: newAdj, error } = await sb
      .from('adjusters')
      .insert({ adjuster_name, adjuster_email, adjuster_phone, carrier_id })
      .select()
      .single();

    if (error) {
      console.warn('Could not create adjuster record:', error);
      return null;
    }

    return newAdj;
  },
};
