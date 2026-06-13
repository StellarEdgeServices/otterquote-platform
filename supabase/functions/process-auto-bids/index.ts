// supabase/functions/process-auto-bids/index.ts
// D-093 — Auto-bid for insurance full roof replacement
// Invoked by pg_cron every 5 minutes via net.http_post
// Idempotent: deduplication via existing quotes check per claim+contractor pair

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PLATFORM_FEE_PCT = 5.00; // Matches all production quotes (observed)
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAILGUN_API_KEY = Deno.env.get('MAILGUN_API_KEY') ?? '';
const MAILGUN_DOMAIN = Deno.env.get('MAILGUN_DOMAIN') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

interface Contractor {
  id: string;
  user_id: string;
  email: string | null;
  notification_emails: string[] | null;
  contact_name: string | null;
  service_counties: string[];
  auto_bid_value_adds: Record<string, unknown> | null;
  default_auto_renew: boolean;
}

interface Claim {
  id: string;
  rcv_amount: number;
  property_state: string | null;
}

interface ProcessResult {
  claims_evaluated: number;
  bids_submitted: number;
  errors: string[];
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Auth gate — accept CRON_SECRET via:
  //   (a) X-Cron-Secret header (pg_net pattern from send-home-profile-prompt)
  //   (b) Authorization: Bearer <CRON_SECRET> (configured cron pattern)
  //   (c) Authorization: Bearer <SERVICE_ROLE_KEY> (mark-job-complete / manual invocation)
  // If CRON_SECRET is not configured, fallback to service-role-key-only auth.
  const incomingCronSecret = req.headers.get('X-Cron-Secret');
  const authHeader = req.headers.get('Authorization') ?? '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  let authorized = false;
  if (!CRON_SECRET) {
    // Not configured — allow service-role-key Bearer only
    authorized = !!SUPABASE_SERVICE_ROLE_KEY && bearerToken === SUPABASE_SERVICE_ROLE_KEY;
  } else {
    authorized =
      (incomingCronSecret !== null && incomingCronSecret === CRON_SECRET) ||
      bearerToken === CRON_SECRET ||
      (!!SUPABASE_SERVICE_ROLE_KEY && bearerToken === SUPABASE_SERVICE_ROLE_KEY);
  }

  if (!authorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const result: ProcessResult = { claims_evaluated: 0, bids_submitted: 0, errors: [] };

  try {
    // ── Step 1: Qualifying claims ─────────────────────────────────────────────
    // D-093: insurance full replacement roofing, bid-released, RCV amount present
    const { data: claims, error: claimsError } = await supabase
      .from('claims')
      .select('id, rcv_amount, property_state')
      .eq('funding_type', 'insurance')
      .eq('job_type', 'insurance_rcv')
      .eq('ready_for_bids', true)
      .not('roofing_bid_released_at', 'is', null)
      .not('rcv_amount', 'is', null)
      .gt('rcv_amount', 0);

    if (claimsError) {
      throw new Error(`Claims query failed: ${claimsError.message}`);
    }

    if (!claims || claims.length === 0) {
      return new Response(
        JSON.stringify({ ...result, message: 'No qualifying claims' }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // ── Step 2: Active contractors with auto-bid enabled for roofing ──────────
    const { data: contractors, error: contractorsError } = await supabase
      .from('contractors')
      .select('id, user_id, email, notification_emails, contact_name, service_counties, auto_bid_value_adds, default_auto_renew')
      .eq('auto_bid_enabled', true)
      .eq('status', 'active')
      .contains('trades', ['roofing'])
      .not('service_counties', 'is', null);

    if (contractorsError) {
      throw new Error(`Contractors query failed: ${contractorsError.message}`);
    }

    if (!contractors || contractors.length === 0) {
      return new Response(
        JSON.stringify({ ...result, message: 'No auto-bid contractors found' }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // ── Step 3: Match and bid ─────────────────────────────────────────────────
    for (const claim of claims as Claim[]) {
      result.claims_evaluated++;

      if (!claim.property_state) continue;

      // Fetch existing quotes for this claim (deduplication)
      const { data: existingQuotes } = await supabase
        .from('quotes')
        .select('contractor_id')
        .eq('claim_id', claim.id)
        .eq('trade_type', 'roofing');

      const alreadyBid = new Set(
        (existingQuotes ?? []).map((q: { contractor_id: string }) => q.contractor_id)
      );

      for (const contractor of contractors as Contractor[]) {
        // Dedup: skip if contractor already has any roofing quote for this claim
        if (alreadyBid.has(contractor.id)) continue;

        // Service area match: any county in claim's state
        // Claims carry property_state; contractors store "STATE:County" in service_counties.
        // State-level match is used until claims gain a property_county field (D-093).
        const inServiceArea = contractor.service_counties.some(
          (county) => county.startsWith(`${claim.property_state}:`)
        );
        if (!inServiceArea) continue;

        try {
          const rcvAmount = Number(claim.rcv_amount);
          const feeAmount = Math.round(rcvAmount * (PLATFORM_FEE_PCT / 100) * 100) / 100;
          const now = new Date().toISOString();

          // Insert auto-bid quote
          const { data: quote, error: quoteError } = await supabase
            .from('quotes')
            .insert({
              claim_id: claim.id,
              contractor_id: contractor.id,
              total_price: rcvAmount,
              fee_percentage: PLATFORM_FEE_PCT,
              fee_amount: feeAmount,
              fee_agreed: true,
              fee_agreed_at: now,
              status: 'submitted',
              trade_type: 'roofing',
              is_auto_bid: true,
              auto_renew: contractor.default_auto_renew ?? false,
              value_adds: contractor.auto_bid_value_adds ?? null,
              scope_summary: 'Auto-submitted bid — insurance full replacement roofing at RCV amount.',
              bid_status: 'active',
            })
            .select('id')
            .single();

          if (quoteError) {
            result.errors.push(
              `Quote insert failed — contractor ${contractor.id}, claim ${claim.id}: ${quoteError.message}`
            );
            continue;
          }

          // Mark as already-bid within this run (prevents double-bid if claim appears twice)
          alreadyBid.add(contractor.id);

          // Activity log
          await supabase.from('activity_log').insert({
            user_id: contractor.user_id,
            event_type: 'auto_bid_submitted',
            title: 'Auto-bid submitted on your behalf',
            metadata: {
              claim_id: claim.id,
              quote_id: quote!.id,
              total_price: rcvAmount,
              fee_amount: feeAmount,
            },
          });

          // Notification recipients: all notification_emails + primary email (deduped)
          const recipientSet = new Set<string>();
          for (const e of contractor.notification_emails ?? []) {
            if (e) recipientSet.add(e);
          }
          if (contractor.email) recipientSet.add(contractor.email);
          const recipients = [...recipientSet];

          // notifications table records
          for (const recipient of recipients) {
            await supabase.from('notifications').insert({
              user_id: contractor.user_id,
              claim_id: claim.id,
              channel: 'email',
              notification_type: 'auto_bid_submitted',
              recipient,
              message_preview: `Auto-bid submitted: $${rcvAmount.toLocaleString()} insurance roofing project`,
            });
          }

          // Mailgun email — send to primary email only
          const toEmail = contractor.email ?? recipients[0];
          if (MAILGUN_API_KEY && MAILGUN_DOMAIN && toEmail) {
            const name = contractor.contact_name ?? 'there';
            const html = buildEmailHtml(name, rcvAmount, feeAmount);

            const fd = new FormData();
            fd.append('from', `Otter Quotes <noreply@${MAILGUN_DOMAIN}>`);
            fd.append('to', toEmail);
            fd.append('subject', 'Otter Quotes: Auto-bid submitted on your behalf');
            fd.append('html', html);

            const mgRes = await fetch(
              `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
              {
                method: 'POST',
                headers: { Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}` },
                body: fd,
              }
            );

            if (!mgRes.ok) {
              const errText = await mgRes.text();
              result.errors.push(`Mailgun error for ${toEmail}: ${errText}`);
              // Non-fatal: bid is already committed; email failure doesn't roll back the bid
            }
          }

          result.bids_submitted++;

        } catch (err) {
          result.errors.push(
            `Unexpected error — contractor ${contractor.id}, claim ${claim.id}: ${String(err)}`
          );
        }
      }
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});

// ── Email template ────────────────────────────────────────────────────────────
function buildEmailHtml(name: string, rcvAmount: number, feeAmount: number): string {
  const fmtUSD = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  return `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
  <h2 style="color:#1a3c5e;">Auto-Bid Submitted ✓</h2>
  <p>Hi ${name},</p>
  <p>We automatically submitted a bid on your behalf for a new insurance roofing project.</p>
  <table style="border-collapse:collapse;width:100%;margin:16px 0;">
    <tr style="background:#f4f6f8;">
      <td style="padding:8px 12px;font-weight:bold;">Bid Amount</td>
      <td style="padding:8px 12px;">${fmtUSD(rcvAmount)}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-weight:bold;">Platform Fee (${PLATFORM_FEE_PCT}%)</td>
      <td style="padding:8px 12px;">${fmtUSD(feeAmount)}</td>
    </tr>
    <tr style="background:#f4f6f8;">
      <td style="padding:8px 12px;font-weight:bold;">Project Type</td>
      <td style="padding:8px 12px;">Insurance full replacement — roofing</td>
    </tr>
  </table>
  <p>
    <a href="https://otterquote.com/contractor-opportunities.html"
       style="display:inline-block;background:#f59e0b;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">
      View Project
    </a>
  </p>
  <p style="font-size:13px;color:#666;">
    To turn off auto-bidding, visit your
    <a href="https://otterquote.com/contractor-auto-bids.html">auto-bid settings</a>.
  </p>
  <p>— The Otter Quotes Team</p>
</body>
</html>
  `.trim();
}
