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

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const HOMEOWNER_EMAIL = 'test-homeowner@otterquote-internal.test';
const CONTRACTOR_EMAIL = 'test-contractor@otterquote-internal.test';
const STATE_FILE = resolve(__dirname, '..', '.test-state.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findOrCreateUser(email, role) {
  // Supabase admin.listUsers paginates at 1000 max — fine for our use case
  const { data: listData, error: listErr } =
    await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);

  const existing = listData?.users?.find((u) => u.email === email);
  if (existing) {
    console.log(`  ✅ Existing ${role}: ${email} (${existing.id})`);
    return existing.id;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true, // skip OTP verification for test accounts
    user_metadata: { role },
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  console.log(`  ✅ Created ${role}: ${email} (${data.user.id})`);
  return data.user.id;
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

  const templatesPayload = [
    { contractor_id: contractorId, trade: 'roofing', funding_type: 'insurance', status: 'auto_validated', pdf_storage_path: 'ci-test/placeholder.pdf' },
    { contractor_id: contractorId, trade: 'roofing', funding_type: 'retail',    status: 'auto_validated', pdf_storage_path: 'ci-test/placeholder.pdf' },
    { contractor_id: contractorId, trade: 'siding',  funding_type: 'retail',    status: 'auto_validated', pdf_storage_path: 'ci-test/placeholder.pdf' },
    { contractor_id: contractorId, trade: 'siding',  funding_type: 'insurance', status: 'auto_validated', pdf_storage_path: 'ci-test/placeholder.pdf' },
  ];
  const { error: tmplErr } = await supabase.from('contractor_templates').insert(templatesPayload);
  if (tmplErr) throw new Error(`Contractor templates insert failed: ${tmplErr.message}`);
  console.log(`  ✅ Contractor templates seeded (roofing/insurance, roofing/retail, siding/retail, siding/insurance)`);

  // ── 6. Fresh test claim ──────────────────────────────────────────────────
  console.log('6. Test claim (delete old, create fresh)...');
  // Delete previous test claims to ensure a clean state each run
  await supabase.from('claims').delete().eq('user_id', homeownerUserId);

  const { data: claim, error: claimErr } = await supabase
    .from('claims')
    .insert({
      user_id: homeownerUserId,
      status: 'bidding',
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
  // Delete previous retail siding test claims
  await supabase.from('claims').delete().eq('user_id', homeownerUserId).eq('job_type', 'retail');

  const { data: retailClaim, error: retailClaimErr } = await supabase
    .from('claims')
    .insert({
      user_id: homeownerUserId,
      status: 'bidding',
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
      amount_charged: 15000, // Hover measurement + design fee (E2E injected)
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
  console.log(`  Homeowner:  ${HOMEOWNER_EMAIL}`);
  console.log(`  Contractor: ${CONTRACTOR_EMAIL} → contractors.id ${contractorId}`);
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
