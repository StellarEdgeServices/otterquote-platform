/**
 * OtterQuote E2E Test Seed Script
 *
 * Creates (or verifies) test accounts and a fresh test claim on the staging
 * Supabase project. Must be run before `npm test`.
 *
 * Usage:
 *   npm run seed
 *
 * What it creates:
 *   - Test homeowner auth user (email: test-homeowner@otterquote-internal.test)
 *   - Test homeowner profile row (is_test = true)
 *   - Test contractor auth user (email: test-contractor@otterquote-internal.test)
 *   - Test contractor profile row (is_test = true)
 *   - Test contractor business record in contractors table (status = active)
 *   - Multi-role test account (contractors + active referral_agents row on
 *     the same user, gh-817/#643 regression fixture)
 *   - Fresh test claim in bidding status with pre-populated mock data
 *
 * Idempotent: auth users and profiles are upserted (not re-created on repeat runs).
 * Claims are deleted and re-created fresh each run.
 *
 * Output: writes .test-state.json with UUIDs needed by test specs.
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { config as loadEnv } from 'dotenv';
import { runIntegrityGuard } from './integrity-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env.test') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL =
  process.env.BASE_URL || 'https://staging--jade-alpaca-b82b5e.netlify.app';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    '\n❌ Missing env vars. Copy .env.test.example → .env.test and fill in:\n' +
      '   SUPABASE_URL\n   SUPABASE_SERVICE_ROLE_KEY\n'
  );
  process.exit(1);
}

// gh-1028: production-target guard. Before #1000 (2026-08-17) this script's
// SUPABASE_URL pointed at the production project (yeszghaspzwwstvsrioa) for
// ~2.5 months — every seed/teardown cycle wrote real activity_log rows and,
// intermittently, real quotes rows into prod, misdiagnosed as bot activity
// in #945. #1000 repointed CI's SUPABASE_URL secret to the dedicated test
// project; this guard makes a repeat of that misconfiguration (a stale local
// .env.test, a reverted CI secret, a new workflow copy-pasted without the
// fix) fail loudly here instead of silently seeding/tearing down against
// real user data again.
const PRODUCTION_PROJECT_REF = 'yeszghaspzwwstvsrioa';
if (SUPABASE_URL.includes(PRODUCTION_PROJECT_REF)) {
  console.error(
    '\n❌ SUPABASE_URL points at the PRODUCTION project ' +
      `(${PRODUCTION_PROJECT_REF}). Refusing to seed/teardown test data ` +
      'there — see gh-1028 and gh-689/#1000. Point SUPABASE_URL at the ' +
      'dedicated E2E test project instead.\n'
  );
  process.exit(1);
}

// @supabase/supabase-js eagerly resolves a WebSocket constructor for its
// Realtime client at construction time, even when no channel is ever opened.
// On Node < 22 (no native WebSocket global) and with the `ws` package removed
// (#658, CVE-2026-48779), that resolution throws before this script can run
// at all. This script never calls `.channel()`/`.subscribe()`, so a stub
// that is constructed-but-never-invoked satisfies the eager check without
// reintroducing `ws`.
class NoRealtimeTransportStub {
  constructor() {
    throw new Error(
      'Realtime transport unavailable: this client never opens a realtime channel.'
    );
  }
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: NoRealtimeTransportStub },
});

const HOMEOWNER_EMAIL = 'test-homeowner@otterquote-internal.test';
const CONTRACTOR_EMAIL = 'test-contractor@otterquote-internal.test';
const STATE_FILE = resolve(__dirname, '..', '.test-state.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findOrCreateUser(email, role) {
  // Strategy: attempt createUser first — avoids an expensive listUsers full-scan
  // on large projects (6K+ auth users + Disk IO throttle = timeout). On 422
  // ("User already registered") fall back to a targeted email-filtered request
  // against the auth admin REST endpoint. Fixes: 86e1nxn4x.
  const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true, // skip OTP verification for test accounts
    user_metadata: { role },
  });

  if (!createErr) {
    console.log(`  ✅ Created ${role}: ${email} (${createData.user.id})`);
    return createData.user.id;
  }

  // 422 = "User already registered" — look up the existing user via a targeted
  // email-filtered admin REST request (avoids O(n_users) listUsers full-scan).
  if (createErr.status !== 422) {
    throw new Error(`createUser(${email}) failed: ${createErr.message}`);
  }

  const lookupUrl =
    `${SUPABASE_URL}/auth/v1/admin/users` +
    `?filter=${encodeURIComponent(email)}&page=1&per_page=1`;
  const lookupResp = await fetch(lookupUrl, {
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
    },
  });
  if (!lookupResp.ok) {
    throw new Error(
      `getUserByEmail(${email}) HTTP ${lookupResp.status}: ${await lookupResp.text()}`
    );
  }
  const body = await lookupResp.json();
  const existing = body.users?.[0];
  if (!existing) {
    throw new Error(
      `getUserByEmail(${email}): user not found after 422 on createUser`
    );
  }
  console.log(`  ✅ Existing ${role}: ${email} (${existing.id})`);
  return existing.id;
}

// ─── gh-1584: real validation artefacts for seeded contractor_templates ──────
//
// Root cause (#1584): this script used to insert contractor_templates rows
// with status:'auto_validated' and NO validation_result, plus a shared
// ci-test/placeholder.pdf path. bid_can_submit treats auto_validated as "may
// bid" — a row with that status and no validation artefact is exactly the
// fail-quiet shape #1313 is about, and the shared placeholder path broke
// create-docusign-envelope's tag scan in #1504. Fix (part 1 of 2 — the
// schema CHECK constraint that would enforce this is #1313 Tier 3B, tracked
// separately, NOT added here): give every seeded row (a) a real per-contractor
// tagged PDF and (b) a validation_result shaped exactly like the one the live
// validator writes, marked `seeded: true` so it is never mistaken for one the
// validator actually produced.

/**
 * BoldSign Text Tag builder — must match
 * supabase/functions/validate-contract-template/index.ts's `tag()` exactly,
 * since these strings are the literal anchors the live scan looks for.
 */
function boldsignTag(fieldType, signerIndex, required, label, fieldId) {
  return `{{${fieldType}|${signerIndex}|${required ? '*' : ' '}|${label}|${fieldId}}}`;
}
const CONTRACTOR_IDX = 1;
const HOMEOWNER_IDX = 2;

// Mirrors the v3 anchor manifest (D-274, approved 2026-08-13) in
// supabase/functions/validate-contract-template/index.ts — required/optional
// anchor lists for the 4 slots this script seeds only. If that MANIFEST is
// ever superseded (a v4), this copy must be updated to match or these seeded
// templates validate against a shape the live validator no longer produces.
const SEED_MANIFEST_SLOTS = {
  roofing: {
    retail: {
      requiredCount: 13,
      required: [
        { anchor: boldsignTag('sign', HOMEOWNER_IDX, true, 'Homeowner Signature', 'homeowner_signature'), mechanism: 'boldsign_tag', field: 'Homeowner signature', tabType: 'sign', source: 'HICA' },
        { anchor: boldsignTag('date', HOMEOWNER_IDX, true, 'Homeowner Sign Date', 'homeowner_signature_date'), mechanism: 'boldsign_tag', field: 'Homeowner sign date', tabType: 'date', source: 'HICA' },
        { anchor: boldsignTag('sign', CONTRACTOR_IDX, true, 'Contractor Signature', 'contractor_signature'), mechanism: 'boldsign_tag', field: 'Contractor signature', tabType: 'sign', source: 'HICA' },
        { anchor: boldsignTag('date', CONTRACTOR_IDX, true, 'Contractor Sign Date', 'contractor_signature_date'), mechanism: 'boldsign_tag', field: 'Contractor sign date', tabType: 'date', source: 'HICA' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Customer Name', 'customer_name'), mechanism: 'boldsign_tag', field: 'Customer name', tabType: 'text', source: 'Party identification' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Property Address', 'customer_address'), mechanism: 'boldsign_tag', field: 'Property address', tabType: 'text', source: 'Property identification' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Contract Price', 'contract_price'), mechanism: 'boldsign_tag', field: 'Total contract amount', tabType: 'text', source: 'Financial term' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Job Description', 'job_description'), mechanism: 'boldsign_tag', field: 'Job description / See Exhibit A', tabType: 'text', source: 'Scope reference (D-186)' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Material Type', 'material_type'), mechanism: 'boldsign_tag', field: 'Shingle product/brand', tabType: 'text', source: 'Material commitment' },
        { anchor: "Manufacturer's Warranty:", mechanism: 'label_text', field: 'Auto-filled from D-202 manifest', tabType: 'text', source: 'D-202' },
        { anchor: 'Workmanship Warranty:', mechanism: 'label_text', field: 'Contractor workmanship years', tabType: 'text', source: 'Workmanship commitment' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Decking Per Sheet', 'decking_per_sheet'), mechanism: 'boldsign_tag', field: 'Per-sheet decking replacement price', tabType: 'text', source: 'Roofing contingency' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Start Date', 'estimated_start'), mechanism: 'boldsign_tag', field: 'Estimated start date', tabType: 'text', source: 'Scheduling commitment' },
      ],
      optional: ['City/Zip:', 'Phone', 'Email:', 'Single Manufacture', 'Shingle Type:', 'Shingle Color:', 'Drip Edge Color:', 'Vents', 'Satellite', 'Skylights', 'Full Redeck:', 'Permit Fee:', 'Dumpster Fee:', 'Contractor:', 'Contractor Phone:', 'Contractor Email:', 'Contractor Address:', 'License #:', 'Structures:', 'Structure Names:', 'Valley Type:', 'Bad Decking:', 'Project Notes:'],
    },
    insurance: {
      requiredCount: 14,
      required: [
        { anchor: boldsignTag('sign', HOMEOWNER_IDX, true, 'Homeowner Signature', 'homeowner_signature'), mechanism: 'boldsign_tag', field: 'Homeowner signature', tabType: 'sign', source: 'HICA' },
        { anchor: boldsignTag('date', HOMEOWNER_IDX, true, 'Homeowner Sign Date', 'homeowner_signature_date'), mechanism: 'boldsign_tag', field: 'Homeowner sign date', tabType: 'date', source: 'HICA' },
        { anchor: boldsignTag('sign', CONTRACTOR_IDX, true, 'Contractor Signature', 'contractor_signature'), mechanism: 'boldsign_tag', field: 'Contractor signature', tabType: 'sign', source: 'HICA' },
        { anchor: boldsignTag('date', CONTRACTOR_IDX, true, 'Contractor Sign Date', 'contractor_signature_date'), mechanism: 'boldsign_tag', field: 'Contractor sign date', tabType: 'date', source: 'HICA' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Customer Name', 'customer_name'), mechanism: 'boldsign_tag', field: 'Customer name', tabType: 'text', source: 'Party identification' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Property Address', 'customer_address'), mechanism: 'boldsign_tag', field: 'Property address', tabType: 'text', source: 'Property identification' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Contract Price', 'contract_price'), mechanism: 'boldsign_tag', field: 'Total contract amount (RCV-based)', tabType: 'text', source: 'Financial term' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Insurance Company', 'insurance_company'), mechanism: 'boldsign_tag', field: 'Insurance carrier', tabType: 'text', source: 'Insurance-specific' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Claim Number', 'claim_number'), mechanism: 'boldsign_tag', field: 'Carrier claim number', tabType: 'text', source: 'Insurance-specific' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Deductible', 'deductible'), mechanism: 'boldsign_tag', field: 'Homeowner deductible amount', tabType: 'text', source: 'Financial term' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Material Type', 'material_type'), mechanism: 'boldsign_tag', field: 'Shingle product/brand', tabType: 'text', source: 'Material commitment' },
        { anchor: "Manufacturer's Warranty:", mechanism: 'label_text', field: 'Auto-filled from D-202 manifest', tabType: 'text', source: 'D-202' },
        { anchor: 'Workmanship Warranty:', mechanism: 'label_text', field: 'Contractor workmanship years', tabType: 'text', source: 'Workmanship commitment' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Decking Per Sheet', 'decking_per_sheet'), mechanism: 'boldsign_tag', field: 'Per-sheet decking replacement price', tabType: 'text', source: 'Roofing contingency' },
      ],
      optional: ['City/Zip:', 'Phone', 'Email:', 'Single Manufacture', 'Shingle Type:', 'Shingle Color:', 'Drip Edge Color:', 'Vents', 'Satellite', 'Skylights', 'Full Redeck:', 'Permit Fee:', 'Dumpster Fee:', 'Contractor:', 'Contractor Phone:', 'Contractor Email:', 'Contractor Address:', 'License #:', 'Structures:', 'Structure Names:', 'Valley Type:', 'Bad Decking:', 'Project Notes:', 'Non-Recoverable Dep:', 'Work Not Done:', 'Description:'],
    },
  },
  siding: {
    retail: {
      requiredCount: 13,
      required: [
        { anchor: boldsignTag('sign', HOMEOWNER_IDX, true, 'Homeowner Signature', 'homeowner_signature'), mechanism: 'boldsign_tag', field: 'Homeowner signature', tabType: 'sign', source: 'HICA' },
        { anchor: boldsignTag('date', HOMEOWNER_IDX, true, 'Homeowner Sign Date', 'homeowner_signature_date'), mechanism: 'boldsign_tag', field: 'Homeowner sign date', tabType: 'date', source: 'HICA' },
        { anchor: boldsignTag('sign', CONTRACTOR_IDX, true, 'Contractor Signature', 'contractor_signature'), mechanism: 'boldsign_tag', field: 'Contractor signature', tabType: 'sign', source: 'HICA' },
        { anchor: boldsignTag('date', CONTRACTOR_IDX, true, 'Contractor Sign Date', 'contractor_signature_date'), mechanism: 'boldsign_tag', field: 'Contractor sign date', tabType: 'date', source: 'HICA' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Customer Name', 'customer_name'), mechanism: 'boldsign_tag', field: 'Customer name', tabType: 'text', source: 'Party identification' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Property Address', 'customer_address'), mechanism: 'boldsign_tag', field: 'Property address', tabType: 'text', source: 'Property identification' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Contract Price', 'contract_price'), mechanism: 'boldsign_tag', field: 'Total contract amount', tabType: 'text', source: 'Financial term' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Job Description', 'job_description'), mechanism: 'boldsign_tag', field: 'Job description / See Exhibit A', tabType: 'text', source: 'Scope reference (D-186)' },
        { anchor: 'Siding Product:', mechanism: 'label_text', field: 'Siding product/brand', tabType: 'text', source: 'Material commitment' },
        { anchor: "Manufacturer's Warranty:", mechanism: 'label_text', field: 'Auto-filled from D-202 manifest', tabType: 'text', source: 'D-202' },
        { anchor: 'Workmanship Warranty:', mechanism: 'label_text', field: 'Contractor workmanship years', tabType: 'text', source: 'Workmanship commitment' },
        { anchor: 'Wall Substrate:', mechanism: 'label_text', field: 'Per-sheet sheathing replacement contingency', tabType: 'text', source: 'Siding contingency' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Start Date', 'estimated_start'), mechanism: 'boldsign_tag', field: 'Estimated start date', tabType: 'text', source: 'Scheduling commitment' },
      ],
      optional: ['City/Zip:', 'Phone', 'Email:', 'Siding Color:', 'Siding Profile:', 'Trim Color:', 'Trim Material:', 'Contractor:', 'Contractor Phone:', 'Contractor Email:', 'Contractor Address:', 'License #:', 'Project Notes:'],
    },
    insurance: {
      requiredCount: 14,
      required: [
        { anchor: boldsignTag('sign', HOMEOWNER_IDX, true, 'Homeowner Signature', 'homeowner_signature'), mechanism: 'boldsign_tag', field: 'Homeowner signature', tabType: 'sign', source: 'HICA' },
        { anchor: boldsignTag('date', HOMEOWNER_IDX, true, 'Homeowner Sign Date', 'homeowner_signature_date'), mechanism: 'boldsign_tag', field: 'Homeowner sign date', tabType: 'date', source: 'HICA' },
        { anchor: boldsignTag('sign', CONTRACTOR_IDX, true, 'Contractor Signature', 'contractor_signature'), mechanism: 'boldsign_tag', field: 'Contractor signature', tabType: 'sign', source: 'HICA' },
        { anchor: boldsignTag('date', CONTRACTOR_IDX, true, 'Contractor Sign Date', 'contractor_signature_date'), mechanism: 'boldsign_tag', field: 'Contractor sign date', tabType: 'date', source: 'HICA' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Customer Name', 'customer_name'), mechanism: 'boldsign_tag', field: 'Customer name', tabType: 'text', source: 'Party identification' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Property Address', 'customer_address'), mechanism: 'boldsign_tag', field: 'Property address', tabType: 'text', source: 'Property identification' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Contract Price', 'contract_price'), mechanism: 'boldsign_tag', field: 'Total contract amount (RCV-based)', tabType: 'text', source: 'Financial term' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Insurance Company', 'insurance_company'), mechanism: 'boldsign_tag', field: 'Insurance carrier', tabType: 'text', source: 'Insurance-specific' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Claim Number', 'claim_number'), mechanism: 'boldsign_tag', field: 'Carrier claim number', tabType: 'text', source: 'Insurance-specific' },
        { anchor: boldsignTag('text', CONTRACTOR_IDX, true, 'Deductible', 'deductible'), mechanism: 'boldsign_tag', field: 'Homeowner deductible amount', tabType: 'text', source: 'Financial term' },
        { anchor: 'Siding Product:', mechanism: 'label_text', field: 'Siding product/brand', tabType: 'text', source: 'Material commitment' },
        { anchor: "Manufacturer's Warranty:", mechanism: 'label_text', field: 'Auto-filled from D-202 manifest', tabType: 'text', source: 'D-202' },
        { anchor: 'Workmanship Warranty:', mechanism: 'label_text', field: 'Contractor workmanship years', tabType: 'text', source: 'Workmanship commitment' },
        { anchor: 'Wall Substrate:', mechanism: 'label_text', field: 'Per-sheet sheathing replacement contingency', tabType: 'text', source: 'Siding contingency' },
      ],
      optional: ['City/Zip:', 'Phone', 'Email:', 'Start Date:', 'Siding Color:', 'Siding Profile:', 'Trim Color:', 'Trim Material:', 'Description:', 'Non-Recoverable Dep:', 'Work Not Done:', 'Contractor:', 'Contractor Phone:', 'Contractor Email:', 'Contractor Address:', 'License #:', 'Project Notes:'],
    },
  },
};

/**
 * Mints a real access token for a test user, server-side, without a browser
 * redirect round-trip — same generateLink technique tests/e2e/helpers/auth.ts
 * uses for magic-link login, followed by verifyOtp to redeem it directly.
 *
 * Deliberately runs on a THROWAWAY client, not the shared `supabase` admin
 * client: supabase-js auto-switches every subsequent request on a client to
 * whichever session auth.verifyOtp()/signIn*() last established on it, and
 * every other step in this script depends on `supabase.from(...)` running as
 * the service role with RLS bypassed. Contaminating that client's session
 * would silently break every seed step after this one.
 */
async function mintUserAccessToken(email) {
  const tokenClient = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: NoRealtimeTransportStub },
  });
  const { data: linkData, error: linkErr } = await tokenClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    throw new Error(
      `mintUserAccessToken(${email}): generateLink failed: ${linkErr?.message || 'no hashed_token in response'}`
    );
  }
  const { data: otpData, error: otpErr } = await tokenClient.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  });
  if (otpErr || !otpData?.session?.access_token) {
    throw new Error(
      `mintUserAccessToken(${email}): verifyOtp failed: ${otpErr?.message || 'no session in response'}`
    );
  }
  return otpData.session.access_token;
}

/**
 * Fetches the #1313 pre-tagged starter PDF for one trade/funding_type slot
 * from validate-contract-template's `starter: true` path. Generated FROM the
 * live v3 manifest server-side, so it always carries every marker that slot's
 * validator scan requires and can never itself drift from the real thing —
 * only the SEED_MANIFEST_SLOTS description of it (above) can drift.
 */
async function fetchStarterTemplate(accessToken, trade, fundingType) {
  const url = `${SUPABASE_URL}/functions/v1/validate-contract-template`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: SERVICE_KEY,
    },
    body: JSON.stringify({ starter: true, trade, funding_type: fundingType }),
  });
  const text = await resp.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { rawText: text };
  }
  if (!resp.ok || !body.pdf_base64) {
    throw new Error(
      `fetchStarterTemplate(${trade}/${fundingType}) HTTP ${resp.status}: ` +
        (body.error || body.rawText || 'no pdf_base64 in response')
    );
  }
  return { pdfBase64: body.pdf_base64, manifestVersion: body.manifestVersion };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  OtterQuote E2E Seed  →  ' + BASE_URL);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── 1. Test homeowner auth user ───────────────────────────────────────────
  console.log('1. Test homeowner auth user...');
  const homeownerUserId = await findOrCreateUser(HOMEOWNER_EMAIL, 'homeowner');

  // ── 2. Test homeowner profile ────────────────────────────────────────────
  console.log('2. Test homeowner profile (profiles table)...');
  const { error: hpErr } = await supabase.from('profiles').upsert(
    {
      id: homeownerUserId,
      full_name: 'Test Homeowner',
      email: HOMEOWNER_EMAIL,
      phone: '317-555-0100',
      address_street: '100 E Test St',
      address_city: 'Zionsville',
      address_state: 'IN',
      address_zip: '46077',
      role: 'homeowner',
      is_test: true,
    },
    { onConflict: 'id' }
  );
  if (hpErr) throw new Error(`Homeowner profile upsert failed: ${hpErr.message}`);
  console.log('  ✅ Homeowner profile upserted (is_test=true)');

  // ── 3. Test contractor auth user ─────────────────────────────────────────
  console.log('3. Test contractor auth user...');
  const contractorUserId = await findOrCreateUser(CONTRACTOR_EMAIL, 'contractor');

  // ── 4. Test contractor profile ───────────────────────────────────────────
  console.log('4. Test contractor profile (profiles table)...');
  const { error: cpErr } = await supabase.from('profiles').upsert(
    {
      id: contractorUserId,
      full_name: 'Test Contractor',
      email: CONTRACTOR_EMAIL,
      phone: '317-555-0200',
      role: 'contractor',
      is_test: true,
    },
    { onConflict: 'id' }
  );
  if (cpErr) throw new Error(`Contractor profile upsert failed: ${cpErr.message}`);
  console.log('  ✅ Contractor profile upserted (is_test=true)');

  // ── 5. Test contractor business record ───────────────────────────────────
  console.log('5. Test contractor record (contractors table)...');
  const { data: existingC } = await supabase
    .from('contractors')
    .select('id')
    .eq('user_id', contractorUserId)
    .maybeSingle();

  const contractorPayload = {
    user_id: contractorUserId,
    status: 'active', // bypass admin approval gate — test account only
    is_test: true, // #543: excluded from homeowner-facing matching (notify-contractors)
    company_name: 'Test Roofing Co (E2E)',
    contact_name: 'Test Contractor',
    email: CONTRACTOR_EMAIL,
    phone: '317-555-0200',
    trades: ['roofing', 'siding'],
    service_counties: ['IN:*'], // serves all of Indiana (D-192 format)
    address_state: 'IN',
    years_in_business: 5,
    has_general_liability: true,
    has_workers_comp: true,
    agreement_accepted_at: new Date().toISOString(),
    agreement_version: 'v1-2026-04',
    cpa_accepted_at: new Date().toISOString(),
    cpa_version: 'v1-2026-04',
    attestation_accepted_at: new Date().toISOString(),
    attestation_signer_name: 'Test Contractor',
    attestation_signer_title: 'Owner',
    onboarding_step: 4,
    // D-170 COI gate — bid-form checks coi_file_url + coi_expires_at (future date)
    coi_file_url: 'https://staging--jade-alpaca-b82b5e.netlify.app/test-coi-placeholder.pdf',
    coi_expires_at: '2027-12-31',
    coi_uploaded_at: new Date().toISOString(),
    coi_insurer: 'E2E Test Insurance Co',
    coi_policy_number: 'TEST-E2E-00001',
  };

  let contractorId;
  if (existingC) {
    contractorId = existingC.id;
    const { error: cuErr } = await supabase
      .from('contractors')
      .update(contractorPayload)
      .eq('id', contractorId);
    if (cuErr) throw new Error(`Contractor update failed: ${cuErr.message}`);
    console.log(`  ✅ Updated contractor record (${contractorId})`);
  } else {
    const { data: newC, error: ccErr } = await supabase
      .from('contractors')
      .insert(contractorPayload)
      .select('id')
      .single();
    if (ccErr) throw new Error(`Contractor insert failed: ${ccErr.message}`);
    contractorId = newC.id;
    console.log(`  ✅ Created contractor record (${contractorId})`);
  }

  // ── 5b. Contractor templates (D-199 bid-can-submit gate) ──────────────────
  console.log('5b. Contractor templates (bid-can-submit gate)...');
  // Delete any existing test contractor templates and re-insert validated ones.
  // Without these, the bid_can_submit RPC returns can_submit=false and the
  // bid form blocks submission with a window.confirm() before the form submits.
  await supabase.from('contractor_templates').delete().eq('contractor_id', contractorId);

  // gh-1584: each seeded row gets a real per-contractor tagged PDF (the #1313
  // starter, generated from the live manifest) and a validation_result shaped
  // exactly like the one the live validator writes — not the bare
  // status:'auto_validated' + shared ci-test/placeholder.pdf this used to
  // insert with no validation artefact at all. See the block comment above
  // mintUserAccessToken/fetchStarterTemplate for why.
  const contractorAccessToken = await mintUserAccessToken(CONTRACTOR_EMAIL);
  const templateSlots = [
    { trade: 'roofing', funding_type: 'insurance' },
    { trade: 'roofing', funding_type: 'retail' },
    { trade: 'siding', funding_type: 'retail' },
    { trade: 'siding', funding_type: 'insurance' },
  ];

  const templatesPayload = [];
  for (const { trade, funding_type: fundingType } of templateSlots) {
    const { pdfBase64, manifestVersion } = await fetchStarterTemplate(
      contractorAccessToken,
      trade,
      fundingType
    );
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    // Canonical slot path (<contractor_id>/<trade>/<funding>.pdf) — the same
    // path shape create-docusign-envelope and a real contractor upload use,
    // per the validator's own "slot path is canonical" comment.
    const storagePath = `${contractorId}/${trade}/${fundingType}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('contractor-templates')
      .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) {
      throw new Error(
        `Seeded template PDF upload failed (${trade}/${fundingType}): ${uploadErr.message}`
      );
    }

    const slot = SEED_MANIFEST_SLOTS[trade][fundingType];
    const anchors = slot.required.map((req) => ({
      anchor: req.anchor,
      mechanism: req.mechanism,
      field: req.field,
      tabType: req.tabType,
      source: req.source,
      found: true,
      manualOverride: false,
      manualOverrideValue: null,
    }));
    const optional = slot.optional.map((anchor) => ({ anchor, found: false }));

    templatesPayload.push({
      contractor_id: contractorId,
      trade,
      funding_type: fundingType,
      status: 'auto_validated',
      pdf_storage_path: storagePath,
      validation_result: {
        manifestVersion: manifestVersion || 'v3',
        trade,
        funding_type: fundingType,
        requiredCount: slot.requiredCount,
        requiredFoundCount: slot.required.length,
        allRequiredFound: true,
        anchors,
        optional,
        missingMarkers: [],
        filledProposal: { detected: false, signals: [] },
        // Unedited starter carries the placeholder block, not a real notice —
        // matches what cancellationNoticeState() would report against it.
        cancellationNotice: 'placeholder',
        assistApplied: null,
        validatedAt: new Date().toISOString(),
        // Distinguishes this from a validation_result the live validator
        // actually produced — the whole point of this fix (#1584).
        seeded: true,
      },
    });
  }

  const { error: tmplErr } = await supabase.from('contractor_templates').insert(templatesPayload);
  if (tmplErr) throw new Error(`Contractor templates insert failed: ${tmplErr.message}`);
  console.log(`  ✅ Contractor templates seeded (roofing/insurance, roofing/retail, siding/retail, siding/insurance) — real tagged PDFs + validation_result (seeded:true)`);

  // ── 5c. D-210 dedicated test contractor ──────────────────────────────────
  // Isolated from the main flow-A contractor so D-210 beforeAll/afterAll status
  // flips never race with A8 (or any other spec) on concurrent CI runs.
  console.log('5c. D-210 document gate contractor (dedicated, starts pending_approval)...');
  const D210_CONTRACTOR_EMAIL = 'test-contractor-d210@otterquote-internal.test';
  const d210ContractorUserId = await findOrCreateUser(D210_CONTRACTOR_EMAIL, 'contractor');

  const { error: d210ProfErr } = await supabase.from('profiles').upsert(
    {
      id: d210ContractorUserId,
      full_name: 'Test D210 Contractor',
      email: D210_CONTRACTOR_EMAIL,
      phone: '317-555-0201',
      role: 'contractor',
      is_test: true,
    },
    { onConflict: 'id' }
  );
  if (d210ProfErr) throw new Error(`D210 contractor profile upsert failed: ${d210ProfErr.message}`);

  const { data: existingD210C } = await supabase
    .from('contractors')
    .select('id')
    .eq('user_id', d210ContractorUserId)
    .maybeSingle();

  const d210Payload = {
    user_id: d210ContractorUserId,
    status: 'pending_approval',
    is_test: true, // #543: excluded from homeowner-facing matching (notify-contractors)
    company_name: 'Test D210 Roofing Co (E2E)',
    contact_name: 'Test D210 Contractor',
    email: D210_CONTRACTOR_EMAIL,
    phone: '317-555-0201',
    trades: ['roofing'],
    service_counties: ['IN:*'],
    address_state: 'IN',
    years_in_business: 5,
    has_general_liability: true,
    has_workers_comp: true,
    agreement_accepted_at: new Date().toISOString(),
    agreement_version: 'v1-2026-04',
    cpa_accepted_at: new Date().toISOString(),
    cpa_version: 'v1-2026-04',
    attestation_accepted_at: new Date().toISOString(),
    attestation_signer_name: 'Test D210 Contractor',
    attestation_signer_title: 'Owner',
    onboarding_step: 1,
    coi_file_url: 'https://staging--jade-alpaca-b82b5e.netlify.app/test-coi-placeholder.pdf',
    coi_expires_at: '2027-12-31',
    coi_uploaded_at: new Date().toISOString(),
    coi_insurer: 'E2E Test Insurance Co',
    coi_policy_number: 'TEST-E2E-D210-00001',
  };

  let d210ContractorId;
  if (existingD210C) {
    d210ContractorId = existingD210C.id;
    const { error: d210UpdErr } = await supabase
      .from('contractors')
      .update(d210Payload)
      .eq('id', d210ContractorId);
    if (d210UpdErr) throw new Error(`D210 contractor update failed: ${d210UpdErr.message}`);
    console.log(`  ✅ Updated D210 contractor record (${d210ContractorId})`);
  } else {
    const { data: newD210C, error: d210InsErr } = await supabase
      .from('contractors')
      .insert(d210Payload)
      .select('id')
      .single();
    if (d210InsErr) throw new Error(`D210 contractor insert failed: ${d210InsErr.message}`);
    d210ContractorId = newD210C.id;
    console.log(`  ✅ Created D210 contractor record (${d210ContractorId})`);
  }

  // ── 5d. Clean up orphaned D-210 contractor rows ──────────────────────────
  // Multiple seed runs can create duplicate D-210 auth users if the previous
  // user was deleted from auth.users but its contractors row was not cleaned up.
  // Delete any D-210 email contractors rows that are NOT the current valid one.
  console.log('5d. Cleaning up orphaned D-210 contractor rows...');
  const { error: orphanErr } = await supabase
    .from('contractors')
    .delete()
    .like('email', 'test-contractor-d210@%')
    .neq('id', d210ContractorId);
  if (orphanErr) {
    console.warn(`  ⚠️  Orphaned D-210 cleanup warning: ${orphanErr.message}`);
  } else {
    console.log('  ✅ Orphaned D-210 contractor rows cleaned up');
  }

  // ── 5e. Multi-role test account (gh-817/#643 regression fixture) ─────────
  // Mirrors the real-world bug pattern exactly: one auth user holding BOTH a
  // contractors row AND an active referral_agents row (the shape that broke
  // partner-surface role resolution — see js/auth.js getRole()). Dedicated
  // account, not reused from the single-role contractor/homeowner fixtures
  // above, so a regression here can't be masked by state left over from
  // another spec.
  console.log('5e. Multi-role test account (contractor + referral_agents)...');
  const MULTIROLE_EMAIL = 'test-multirole@otterquote-internal.test';
  const multiRoleUserId = await findOrCreateUser(MULTIROLE_EMAIL, 'contractor');

  const { error: mrProfErr } = await supabase.from('profiles').upsert(
    {
      id: multiRoleUserId,
      full_name: 'Test Multirole',
      email: MULTIROLE_EMAIL,
      phone: '317-555-0300',
      role: 'contractor',
      is_test: true,
    },
    { onConflict: 'id' }
  );
  if (mrProfErr) throw new Error(`Multi-role profile upsert failed: ${mrProfErr.message}`);

  const { data: existingMRC } = await supabase
    .from('contractors')
    .select('id')
    .eq('user_id', multiRoleUserId)
    .maybeSingle();

  // pending_approval, not active — matches the real dual-role account
  // (dustinstohler1@gmail.com) that surfaced this bug; the fix must not
  // depend on contractor-approval status to resolve the partner branch.
  const multiRoleContractorPayload = {
    user_id: multiRoleUserId,
    status: 'pending_approval',
    is_test: true,
    company_name: 'Test Multirole Roofing (E2E)',
    contact_name: 'Test Multirole',
    email: MULTIROLE_EMAIL,
    phone: '317-555-0300',
    trades: ['roofing'],
    service_counties: ['IN:*'],
    address_state: 'IN',
  };

  let multiRoleContractorId;
  if (existingMRC) {
    multiRoleContractorId = existingMRC.id;
    const { error: mrcUpdErr } = await supabase
      .from('contractors')
      .update(multiRoleContractorPayload)
      .eq('id', multiRoleContractorId);
    if (mrcUpdErr) throw new Error(`Multi-role contractor update failed: ${mrcUpdErr.message}`);
  } else {
    const { data: newMRC, error: mrcInsErr } = await supabase
      .from('contractors')
      .insert(multiRoleContractorPayload)
      .select('id')
      .single();
    if (mrcInsErr) throw new Error(`Multi-role contractor insert failed: ${mrcInsErr.message}`);
    multiRoleContractorId = newMRC.id;
  }

  const { data: existingMRA } = await supabase
    .from('referral_agents')
    .select('id')
    .eq('user_id', multiRoleUserId)
    .maybeSingle();

  const multiRoleAgentPayload = {
    user_id: multiRoleUserId,
    agent_type: 'home_inspector',
    first_name: 'Test',
    last_name: 'Multirole',
    email: MULTIROLE_EMAIL,
    status: 'active',
    unique_code: 'e2etestmultirole',
    is_test: true,
  };

  let multiRoleAgentId;
  if (existingMRA) {
    multiRoleAgentId = existingMRA.id;
    const { error: mraUpdErr } = await supabase
      .from('referral_agents')
      .update(multiRoleAgentPayload)
      .eq('id', multiRoleAgentId);
    if (mraUpdErr) throw new Error(`Multi-role referral_agents update failed: ${mraUpdErr.message}`);
  } else {
    const { data: newMRA, error: mraInsErr } = await supabase
      .from('referral_agents')
      .insert(multiRoleAgentPayload)
      .select('id')
      .single();
    if (mraInsErr) throw new Error(`Multi-role referral_agents insert failed: ${mraInsErr.message}`);
    multiRoleAgentId = newMRA.id;
  }
  console.log(`  ✅ Multi-role test account ready: contractors.id ${multiRoleContractorId}, referral_agents.id ${multiRoleAgentId}`);

  // ── 6. Fresh test claim ──────────────────────────────────────────────────
  console.log('6. Test claim (delete old, create fresh)...');
  // hover_orders.claim_id has a FK to claims — must delete hover_orders first
  // or the claims DELETE silently fails and claims accumulate across runs.
  //
  // #689: these pre-deletes previously discarded their errors entirely. A
  // single claim with a NO ACTION FK child (e.g. fee_acceptances from an
  // interrupted run) makes Postgres reject the WHOLE delete statement
  // atomically — every historical claim then persists invisibly, which is
  // exactly how 4 stragglers from 2026-08-11 survived 4 days of green runs.
  // Warn loudly (non-fatal: a blocked historical straggler must not brick
  // every CI run — run-scoped teardown owns this run's cleanup; stragglers
  // get an R-109-gated manual sweep).
  const { error: preHoErr } = await supabase
    .from('hover_orders')
    .delete()
    .eq('user_id', homeownerUserId);
  if (preHoErr) {
    console.warn(`  ⚠️ Pre-seed hover_orders delete BLOCKED (rows will accumulate): ${preHoErr.message}`);
  }
  const { error: preClErr } = await supabase
    .from('claims')
    .delete()
    .eq('user_id', homeownerUserId);
  if (preClErr) {
    console.warn(`  ⚠️ Pre-seed claims delete BLOCKED (stragglers persist, see #689): ${preClErr.message}`);
  }

  const { data: claim, error: claimErr } = await supabase
    .from('claims')
    .insert({
      user_id: homeownerUserId,
      status: 'bidding',
      is_test: true, // #564: E2E claims are born test-world — visible/notifiable to test contractors only
      property_address: '100 E Test St, Zionsville, IN 46077',
      property_state: 'IN',
      homeowner_name: 'Test Homeowner',
      job_type: 'insurance_rcv',
      funding_type: 'insurance',
      trades: ['roofing'],
      damage_type: 'roof',
      material_category: 'shingle',
      shingle_type: 'architectural',
      impact_class: 'none',
      rcv_amount: 15000,
      acv_amount: 12000,
      roof_squares: 24,
      has_estimate: true,
      has_measurements: true,
      has_material_selection: true,
      ready_for_bids: true,
      bids_submitted_at: new Date().toISOString(),
      roofing_bid_released_at: new Date().toISOString(),
      homeowner_notes:
        '[E2E TEST CLAIM — automated test account only, please do not bid]',
      urgency: 'flexible',
    })
    .select('id')
    .single();

  if (claimErr) {
    throw new Error(`Test claim creation failed: ${claimErr.message}`);
  }
  const testClaimId = claim.id;
  console.log(`  ✅ Test claim created (${testClaimId})`);


  // ── 6b. Fresh retail siding test claim (D-164 design gate) ─────────────
  console.log('6b. Retail siding test claim (design gate verification)...');
  // Delete previous retail siding test claims (#689: same loud-warn treatment
  // as the step-6 pre-deletes — a FK-blocked delete must be visible in logs)
  const { error: preRetailErr } = await supabase
    .from('claims')
    .delete()
    .eq('user_id', homeownerUserId)
    .eq('job_type', 'retail');
  if (preRetailErr) {
    console.warn(`  ⚠️ Pre-seed retail claims delete BLOCKED (stragglers persist, see #689): ${preRetailErr.message}`);
  }

  const { data: retailClaim, error: retailClaimErr } = await supabase
    .from('claims')
    .insert({
      user_id: homeownerUserId,
      status: 'bidding',
      is_test: true, // #564: E2E claims are born test-world — visible/notifiable to test contractors only
      property_address: '100 E Test St, Zionsville, IN 46077',
      property_state: 'IN',
      homeowner_name: 'Test Homeowner',
      job_type: 'retail',
      funding_type: 'cash',
      trades: ['siding'],
      damage_type: null,
      material_category: null,
      siding_bid_released_at: null, // Gate is LOCKED until design completes
      has_estimate: true,
      has_measurements: true,
      has_material_selection: true,
      ready_for_bids: false, // Bid release is gated on design completion
      homeowner_notes: '[E2E TEST CLAIM — retail siding design gate verification, please do not bid]',
      urgency: 'flexible',
    })
    .select('id')
    .single();

  if (retailClaimErr) {
    throw new Error(`Retail siding claim creation failed: ${retailClaimErr.message}`);
  }
  const testRetailClaimId = retailClaim.id;
  console.log(`  ✅ Retail siding test claim created (${testRetailClaimId})`);

  // ── 6c. Create completed hover_orders row with mock material_list ────────
  // This simulates homeowner completing Hover 3D design + material selection.
  // D-164: material_list must have all four fields (manufacturer, profile, color, trim)
  // so the design gate logic can verify completeness.
  console.log('6c. Completed hover_orders with material_list (design gate)...');

  const mockMaterialList = [
    {
      name: 'James Hardie Artisan Dutch Lap',
      listItemGroupName: 'James Hardie Siding',
      color: 'Boothbay Blue',
      quantity: 12.5,
      calculatedQuantity: 12.5,
      quantityUnits: 'squares',
      unitCost: 425.00,
      totalCost: 5312.50,
      type: 'MATERIAL',
      tradeType: 'SIDING',
    },
    {
      name: 'Aluminum Corner Trim',
      listItemGroupName: 'Trim & Fascia',
      color: null,
      quantity: 200,
      calculatedQuantity: 200,
      quantityUnits: 'linear feet',
      unitCost: 12.50,
      totalCost: 2500.00,
      type: 'MATERIAL',
      tradeType: 'SIDING',
    },
    {
      name: 'Siding Installation Labor',
      listItemGroupName: 'Labor',
      quantity: 12.5,
      calculatedQuantity: 12.5,
      quantityUnits: 'squares',
      unitCost: 325.00,
      totalCost: 4062.50,
      type: 'LABOR',
      tradeType: 'SIDING',
    },
  ];

  const { data: hoverOrder, error: hoverOrderErr } = await supabase
    .from('hover_orders')
    .insert({
      claim_id: testRetailClaimId,
      user_id: homeownerUserId,
      status: 'complete',
      stripe_payment_id: 'e2e-injected-retail-siding',
      homeowner_stripe_payment_intent_id: null,
      amount_charged: 15, // RoofScope measurement + design fee, dollars not cents (E2E injected)
      rebate_due: false,
      hover_job_id: 999999, // Fake job ID for E2E — not queried in test
      material_list: mockMaterialList,
      measurements_json: {
        structures: [
          {
            areas: {
              wall: 1250, // 12.5 squares = 1250 sq ft
            },
          },
        ],
      },
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (hoverOrderErr) {
    throw new Error(`Hover order creation failed: ${hoverOrderErr.message}`);
  }
  console.log(`  ✅ Completed hover_orders row created with material_list`);

  // ── 6d. Verify contractor is in expected seed state ──────────────────────
  console.log('6d. Verifying contractor seed state...');
  const { data: verifyC, error: verifyErr } = await supabase
    .from('contractors')
    .select('status, onboarding_step')
    .eq('id', contractorId)
    .single();
  if (verifyErr) throw new Error(`Contractor verification failed: ${verifyErr.message}`);
  if (verifyC.status !== 'active' || verifyC.onboarding_step !== 4) {
    throw new Error(
      `Contractor state mismatch after seed: expected status=active onboarding_step=4, ` +
      `got status=${verifyC.status} onboarding_step=${verifyC.onboarding_step}`
    );
  }
  console.log('  ✅ Contractor verified: status=active, onboarding_step=4');

  // ── 6e. Integrity guard (gh-1584) — make the bad shape loud, not silent ──
  //
  // #1584's root cause was a contractor_templates row that reached
  // status='auto_validated' — bid_can_submit's "may bid" gate — with no
  // validation_result: a shape nothing stopped, so it sat undetected for
  // weeks. The DB-level CHECK constraint that would forbid it outright is
  // explicitly out of scope here (Tier 3B, tracked on #1313); this is the
  // seed-side half this issue closes on — assert, after the seed has
  // finished writing, that the bad shape is not present, and throw loudly
  // if it is, instead of completing silently on top of it.
  //
  // Runs LAST (after every other seed step, not immediately after 5b's own
  // insert) and reads the WHOLE contractor_templates table on this
  // project, not just the four rows 5b just inserted. Both are deliberate:
  // nothing else in this script writes to contractor_templates (only 5b's
  // delete + insert do), so a full-table read here is equivalent in
  // coverage to one right after 5b, but placing it last also means the
  // guard fires after everything the seed does is done, matching "the seed
  // has completed" rather than "one particular step of it succeeded." The
  // PRODUCTION_PROJECT_REF guard at the top of this file (gh-1028) already
  // guarantees SUPABASE_URL here can only be the dedicated E2E test
  // project, never prod, so a full-table read is safe — and it catches
  // drift from ANY source (a future edit to this script, a manually
  // inserted fixture, a different code path entirely), not only the rows
  // this exact insert produced. A check narrowed to templatesPayload's own
  // rows would stay green even if some other row in the table were still
  // in the bad shape — precisely the local-looks-fine-globally-isn't gap
  // #1584 is about.
  // NOTE: `Run E2E Tests` carries `continue-on-error: true` in CI (gh-1261,
  // CEO ruling 2026-08-26) — a thrown error here will NOT fail that job. The
  // banner runIntegrityGuard prints to stderr on failure is the only thing
  // standing between this and a silent pass in CI; grep the seed step's log
  // for "INTEGRITY GUARD FAILED" rather than relying on the job's own
  // pass/fail status.
  //
  // gh-1602: the predicate + fail-closed query handling live in
  // integrity-guard.mjs specifically so they can be unit-tested (see
  // integrity-guard.test.mjs) against a constructed bad row, independent of
  // this script's own env-var/Supabase-client setup.
  console.log('6e. Integrity guard: no auto_validated row without validation_result...');
  await runIntegrityGuard(() =>
    supabase
      .from('contractor_templates')
      .select('id, contractor_id, trade, funding_type, pdf_storage_path, created_at, validation_result')
      .eq('status', 'auto_validated')
  );
  console.log('  ✅ Integrity guard passed: no auto_validated rows without validation_result');

  // ── 7. Write .test-state.json ────────────────────────────────────────────
  // runId: deterministic per seed run — YYYYMMDD-HHmmss + first 8 chars of
  // testClaimId (without dashes). Unique enough for artifact storage paths.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const runId =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${testClaimId.replace(/-/g, '').slice(0, 8)}`;

  const state = {
    homeownerUserId,
    homeownerEmail: HOMEOWNER_EMAIL,
    contractorUserId,
    contractorId,
    contractorEmail: CONTRACTOR_EMAIL,
    d210ContractorId,
    d210ContractorEmail: D210_CONTRACTOR_EMAIL,
    multiRoleUserId,
    multiRoleEmail: MULTIROLE_EMAIL,
    multiRoleContractorId,
    multiRoleAgentId,
    testClaimId,
    testRetailClaimId,
    baseUrl: BASE_URL,
    runId,
    seededAt: now.toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅ Seed complete');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Homeowner:         ${HOMEOWNER_EMAIL}`);
  console.log(`  Contractor:        ${CONTRACTOR_EMAIL} → contractors.id ${contractorId}`);
  console.log(`  D210 Contractor:   ${D210_CONTRACTOR_EMAIL} → contractors.id ${d210ContractorId}`);
  console.log(`  Multi-role:        ${MULTIROLE_EMAIL} → contractors.id ${multiRoleContractorId}, referral_agents.id ${multiRoleAgentId}`);
  console.log(`  Test claim (insurance): ${testClaimId}`);
  console.log(`  Test claim (retail siding): ${testRetailClaimId}`);
  console.log(`  State file: .test-state.json\n`);
}

// Allow use as Playwright globalSetup (default export) AND direct invocation
export default seed;

// Direct invocation: `node seed/seed.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed().catch((e) => {
    console.error('\n❌ Seed failed:', e.message);
    process.exit(1);
  });
}
