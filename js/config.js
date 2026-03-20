/**
 * ClaimShield v2 — Global Configuration
 * All environment-specific values in one place.
 */

const CONFIG = {
  // ── Supabase ──
  SUPABASE_URL:  'https://yeszghaspzwwstvsrioa.supabase.co',
  SUPABASE_ANON: 'sb_publishable_mKmYIsRMc6dCG8ZrGGbyyw_l_MOTwZP',

  // ── Google Analytics 4 ──
  GA4_ID: 'G-JNQ6XR3LX2',

  // ── Mailgun (inbound email parsing) ──
  MAILGUN_DOMAIN:  'sandboxd2b099fad357409b845e5f4c5e8bd74e.mailgun.org',
  MAILGUN_API_URL: 'https://api.mailgun.net',
  INGEST_EMAIL_DOMAIN: 'claims.stellaredgeservices.com', // Production domain — sandbox for now
  // NOTE: MAILGUN_API_KEY is server-side only (Edge Functions), never exposed in frontend

  // ── Twilio (SMS notifications) ──
  TWILIO_PHONE:  '18448753412',
  // NOTE: TWILIO_SID and TWILIO_TOKEN are server-side only (Edge Functions)

  // ── Stripe (payments: Hover fees, deductible escrow, contractor platform fees) ──
  STRIPE_PK:     'pk_test_51TCI2b13Mi7XlVLDhmwxNDIZ2XlB8gAVH1Jrl8lXMeERygrEMaI8u4glEhKGWcFGQ5zLBeTrueEu8xwLEb76DQfW00kay1eXi0',
  // NOTE: STRIPE_SECRET_KEY is server-side only (Edge Functions)

  // ── DocuSign (e-signatures) ──
  DOCUSIGN_INTEGRATION_KEY: '43f4a7d5-f1bf-45ec-8a97-264e3d473e42',
  DOCUSIGN_ACCOUNT_ID:      '0b57b777-5c6e-4650-80d3-14152257ca82',
  DOCUSIGN_BASE_URI:        'https://na3.docusign.net',
  // NOTE: DOCUSIGN_USER_ID is server-side only (Edge Functions)

  // ── Hover ──
  // Pending API partner approval
  HOVER_API_KEY:  'PLACEHOLDER_hover_api_key',
  HOVER_API_URL:  'https://api.hover.to/v1',

  // ── Platform Settings ──
  PLATFORM_FEE_PERCENT: 5,         // Starting at 5%, target 10%, test 15%
  MAX_CONTRACTORS_PER_LEAD: 6,     // D-030
  CONTRACTOR_CONTACT_HOURS: 48,    // D-024
  CANCELLATION_DAYS_BEFORE: 3,     // D-041

  // ── Site Info ──
  SITE_NAME: 'ClaimShield',
  SITE_URL:  'https://stellaredgeservices.com',
  SUPPORT_EMAIL: 'support@stellaredgeservices.com',
};

// ── Initialize Supabase Client ──
let sb;
if (typeof supabase !== 'undefined') {
  sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON);
}
