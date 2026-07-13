/**
 * Unit + parity tests for the contractor Pre-Approval page (D-211 Phase 6).
 * Exercises the ported pure logic against contractor-pre-approval.html @ main:
 *   - init row-create + the init state machine (gating parity: ONLY status==='active'
 *     redirects; a pending contractor STAYS — NO pending->dashboard gate is invented)
 *   - Step 2 profile-basics validation, document gates, D-218 multi-license serialization,
 *     storage paths, the contractors UPDATE + 86e1p4pre create-fallback payloads
 *   - the create-hubspot-contact / send-support-email EF bodies (contracts UNCHANGED)
 *   - Step 3 IC 24-5-11 attestation payload + version stamps (Tier-3 VERBATIM) + the
 *     record-attestation parity body (the same payload the static page sends)
 *   - Step 4 template slot-key / path / contract_templates upsert / finish payload
 *   - the verbatim Tier-3 legal copy (attestation, indemnity, cancellation, fee, D-225)
 * Network/storage/EF calls live in page.tsx, not here.
 */

import { describe, it, expect } from 'vitest';
import {
  str, parseSignup, buildInitialContractorInsert, resolveInitialState,
  parseCounties, evaluateProfileBasics, wcSatisfied, coiSatisfied, licenseSatisfied, step2Complete,
  validateLicenseEntry, licenseEntrySummary, buildLicenseInsert,
  docPath, wce1Path, licenseDocPath, buildStep2ContractorUpdate, buildStep2FallbackCreate,
  buildHubspotContactBody, buildSupportEmailBody,
  ATTESTATION_TEXT_VERSION, CPA_VERSION, AGREEMENT_VERSION,
  buildAttestationPayload, step3Complete, buildStep3ContractorUpdate, buildRecordAttestationBody,
  validateTemplate, templateSlotKey, templateFilePath, buildContractTemplatesArray, buildFinishSubmitUpdate,
  REQUIRED_AGREEMENT_CHECKS, COUNTY_RE,
  type LicenseEntry,
} from '../utils';
import { PRE_APPROVAL_COPY, PROFILE_TRADES, TEMPLATE_TRADES, TEMPLATE_FUNDING_TYPES } from '../copy';

const ISO = '2026-06-17T12:00:00.000Z';

// ============================================================
// Signup parsing + initial row create
// ============================================================
describe('signup + initial contractor row', () => {
  it('parseSignup: tolerates null / malformed / valid', () => {
    expect(parseSignup(null)).toEqual({});
    expect(parseSignup('not json')).toEqual({});
    expect(parseSignup('123')).toEqual({}); // non-object JSON
    expect(parseSignup('{"company_name":"Acme","signer_title":"Owner"}')).toEqual({ company_name: 'Acme', signer_title: 'Owner' });
  });

  it('buildInitialContractorInsert: pending stub at step 1, phone only when present', () => {
    const base = buildInitialContractorInsert('u1', 'a@x.com', { company_name: 'Acme', contact_name: 'Pat', signer_title: 'Owner' });
    expect(base).toEqual({
      user_id: 'u1', email: 'a@x.com', company_name: 'Acme', contact_name: 'Pat',
      attestation_signer_title: 'Owner', status: 'pending_approval', onboarding_step: 1,
    });
    expect('phone' in base).toBe(false);
    expect(buildInitialContractorInsert('u1', 'a@x.com', { phone: '3175551234' }).phone).toBe('3175551234');
  });
});

// ============================================================
// Gating parity — the init state machine (the heart of the brief)
// ============================================================
describe('resolveInitialState — gating parity (do NOT invent gates)', () => {
  it('status active -> redirect (the ONLY redirect)', () => {
    expect(resolveInitialState({ status: 'active', onboarding_step: 2 })).toEqual({ kind: 'active-redirect' });
  });

  it('a PENDING contractor is NOT bounced — they land on the wizard (the opposite of dashboard gate)', () => {
    expect(resolveInitialState({ status: 'pending_approval', onboarding_step: 1 })).toEqual({ kind: 'wizard', step: 2 });
    expect(resolveInitialState({ status: 'pending_approval', onboarding_step: 2 })).toEqual({ kind: 'wizard', step: 3 });
  });

  it('onboarding_step >= 4 -> submitted panel', () => {
    expect(resolveInitialState({ status: 'pending_approval', onboarding_step: 4 })).toEqual({ kind: 'submitted' });
    expect(resolveInitialState({ status: 'pending_approval', onboarding_step: 9 })).toEqual({ kind: 'submitted' });
  });

  it('step resolution mirrors Math.min(max(2,(step||1)+1),4)', () => {
    expect(resolveInitialState({ onboarding_step: 0 })).toEqual({ kind: 'wizard', step: 2 });
    expect(resolveInitialState({ onboarding_step: undefined })).toEqual({ kind: 'wizard', step: 2 });
    expect(resolveInitialState({ onboarding_step: 1 })).toEqual({ kind: 'wizard', step: 2 });
    expect(resolveInitialState({ onboarding_step: 2 })).toEqual({ kind: 'wizard', step: 3 });
    expect(resolveInitialState({ onboarding_step: 3 })).toEqual({ kind: 'wizard', step: 4 });
    expect(resolveInitialState(null)).toEqual({ kind: 'wizard', step: 2 });
  });
});

// ============================================================
// Step 2 — profile basics
// ============================================================
describe('profile basics validation', () => {
  it('parseCounties splits/trims/drops blanks', () => {
    expect(parseCounties('')).toEqual([]);
    expect(parseCounties('Marion-IN, Hamilton-IN ,, Boone-IN')).toEqual(['Marion-IN', 'Hamilton-IN', 'Boone-IN']);
  });

  it('COUNTY_RE accepts CountyName-StateCode incl. spaces/apostrophes; rejects bad formats', () => {
    expect(COUNTY_RE.test('Marion-IN')).toBe(true);
    expect(COUNTY_RE.test("St. Joseph-IN")).toBe(true);
    expect(COUNTY_RE.test("O'Brien-IA")).toBe(true);
    expect(COUNTY_RE.test('Marion')).toBe(false);
    expect(COUNTY_RE.test('Marion-Indiana')).toBe(false); // state must be 2 upper
    expect(COUNTY_RE.test('marion-in')).toBe(false);
  });

  it('phone needs >=10 digits; trades >=1; counties all valid', () => {
    const ok = evaluateProfileBasics('317-555-1234', ['roofing'], 'Marion-IN');
    expect(ok.phoneOk && ok.tradesOk && ok.countyOk).toBe(true);
    expect(evaluateProfileBasics('317555', ['roofing'], 'Marion-IN').phoneOk).toBe(false);
    expect(evaluateProfileBasics('3175551234', [], 'Marion-IN').tradesOk).toBe(false);
    expect(evaluateProfileBasics('3175551234', ['roofing'], 'Marion').countyOk).toBe(false);
    expect(evaluateProfileBasics('3175551234', ['roofing'], '').countyOk).toBe(false);
  });

  it('profile catalog matches the 4 static trade checkboxes', () => {
    expect(PROFILE_TRADES.map((t) => t.value)).toEqual(['roofing', 'siding', 'gutters', 'windows']);
  });
});

// ============================================================
// Step 2 — document gates
// ============================================================
describe('document gate checks', () => {
  it('coiSatisfied needs file + expiry', () => {
    expect(coiSatisfied(true, '2027-01-01')).toBe(true);
    expect(coiSatisfied(true, '')).toBe(false);
    expect(coiSatisfied(false, '2027-01-01')).toBe(false);
  });

  it('wcSatisfied: file branch needs file+expiry; exemption branch needs wce1+expiry; null is false', () => {
    expect(wcSatisfied('file', true, '2027-01-01', false, '')).toBe(true);
    expect(wcSatisfied('file', true, '', false, '')).toBe(false);
    expect(wcSatisfied('exemption', false, '', true, '2027-01-01')).toBe(true);
    expect(wcSatisfied('exemption', false, '', true, '')).toBe(false);
    expect(wcSatisfied(null, true, '2027-01-01', true, '2027-01-01')).toBe(false);
  });

  it('licenseSatisfied: entries OR no-license', () => {
    expect(licenseSatisfied(0, false)).toBe(false);
    expect(licenseSatisfied(1, false)).toBe(true);
    expect(licenseSatisfied(0, true)).toBe(true);
  });

  it('step2Complete requires profile + coi + wc + license', () => {
    const okProfile = { phoneOk: true, tradesOk: true, countyOk: true };
    expect(step2Complete(okProfile, true, true, true)).toBe(true);
    expect(step2Complete({ ...okProfile, countyOk: false }, true, true, true)).toBe(false);
    expect(step2Complete(okProfile, false, true, true)).toBe(false);
    expect(step2Complete(okProfile, true, false, true)).toBe(false);
    expect(step2Complete(okProfile, true, true, false)).toBe(false);
  });
});

// ============================================================
// Step 2 — multi-license (D-218)
// ============================================================
describe('multi-license capture (D-218)', () => {
  it('validateLicenseEntry requires level, jurisdiction, number', () => {
    expect(validateLicenseEntry({ jurisdictionLevel: '', jurisdiction: 'IN', licenseNumber: '1' })).toMatch(/jurisdiction level/i);
    expect(validateLicenseEntry({ jurisdictionLevel: 'state', jurisdiction: '  ', licenseNumber: '1' })).toMatch(/jurisdiction/i);
    expect(validateLicenseEntry({ jurisdictionLevel: 'state', jurisdiction: 'Indiana', licenseNumber: ' ' })).toMatch(/license number/i);
    expect(validateLicenseEntry({ jurisdictionLevel: 'state', jurisdiction: 'Indiana', licenseNumber: 'RC123' })).toBeNull();
  });

  it('licenseEntrySummary uses the badge label + expiry/No-expiry', () => {
    const e: LicenseEntry = { id: 1, jurisdictionLevel: 'state', jurisdiction: 'Indiana', licenseNumber: 'RC123', expiryDate: '2027-01-01', verificationUrl: null };
    expect(licenseEntrySummary(e)).toContain('State');
    expect(licenseEntrySummary(e)).toContain('Indiana');
    expect(licenseEntrySummary(e)).toContain('License #RC123');
    expect(licenseEntrySummary(e)).toContain('exp 2027-01-01');
    expect(licenseEntrySummary({ ...e, expiryDate: null })).toContain('No expiry');
  });

  it('buildLicenseInsert maps jurisdiction->municipality + D-218 columns', () => {
    const row = buildLicenseInsert('c1', { jurisdiction: 'Hamilton County', licenseNumber: 'RC9', expiryDate: '2027-02-02', jurisdictionLevel: 'county', verificationUrl: 'https://verify' }, 'u1/licenses/9-x.pdf');
    expect(row).toEqual({
      contractor_id: 'c1', municipality: 'Hamilton County', license_number: 'RC9',
      license_document_url: 'u1/licenses/9-x.pdf', expiration_date: '2027-02-02',
      jurisdiction_level: 'county', verification_url: 'https://verify',
    });
    // optional fields collapse to null
    const row2 = buildLicenseInsert('c1', { jurisdiction: 'Indiana', licenseNumber: '', expiryDate: null, jurisdictionLevel: 'state', verificationUrl: null }, null);
    expect(row2.license_number).toBeNull();
    expect(row2.license_document_url).toBeNull();
    expect(row2.expiration_date).toBeNull();
    expect(row2.verification_url).toBeNull();
  });
});

// ============================================================
// Step 2 — storage paths + contractors update/create
// ============================================================
describe('storage paths', () => {
  it('docPath / wce1Path / licenseDocPath formats', () => {
    expect(docPath('u1', 'coi.pdf', 100)).toBe('u1/100-coi.pdf');
    expect(wce1Path('u1', 'cert.pdf', 100)).toBe('u1/wce1_cert_100_cert.pdf');
    expect(licenseDocPath('u1', 'lic.pdf', 100)).toBe('u1/licenses/100-lic.pdf');
  });
});

describe('Step 2 contractors update + fallback create', () => {
  it('file WC branch writes wc_cert_* and onboarding_step 2', () => {
    const u = buildStep2ContractorUpdate({
      coiFileUrl: 'u1/1-coi.pdf', coiExpiry: '2027-01-01', phone: '3175551234', trades: ['roofing'], counties: ['Marion-IN'],
      wcChoice: 'file', wcCertFileRef: 'u1/1-wc.pdf', wcCertExpiry: '2027-02-02T00:00:00.000Z', noLicense: false,
    }, ISO);
    expect(u).toMatchObject({
      coi_file_url: 'u1/1-coi.pdf', coi_expires_at: '2027-01-01', coi_uploaded_at: ISO,
      phone: '3175551234', trades: ['roofing'], service_counties: ['Marion-IN'],
      wc_cert_file_ref: 'u1/1-wc.pdf', wc_cert_expiry: '2027-02-02T00:00:00.000Z', wc_cert_uploaded_at: ISO,
      onboarding_step: 2, updated_at: ISO,
    });
    expect('license_path' in u).toBe(false);
  });

  it('exemption branch also writes wc_cert_* (D-213 stores the real WCE-1 file, not the sentinel)', () => {
    const u = buildStep2ContractorUpdate({
      coiFileUrl: 'c', coiExpiry: '2027-01-01', phone: 'p', trades: ['t'], counties: ['Marion-IN'],
      wcChoice: 'exemption', wcCertFileRef: 'u1/wce1_cert_1_x.pdf', wcCertExpiry: '2027-02-02T00:00:00.000Z', noLicense: false,
    }, ISO);
    expect(u.wc_cert_file_ref).toBe('u1/wce1_cert_1_x.pdf');
    expect(u.wc_cert_file_ref).not.toBe('WCE-1-EXEMPT');
  });

  it('no-license sets the license_path not_provided sentinel', () => {
    const u = buildStep2ContractorUpdate({
      coiFileUrl: 'c', coiExpiry: '2027-01-01', phone: 'p', trades: ['t'], counties: ['Marion-IN'],
      wcChoice: 'file', wcCertFileRef: 'w', wcCertExpiry: null, noLicense: true,
    }, ISO);
    expect(u.license_path).toBe('not_provided');
  });

  it('fallback create folds signup stub under the step-2 update (86e1p4pre)', () => {
    const upd = { coi_file_url: 'c', onboarding_step: 2 };
    const c = buildStep2FallbackCreate('u1', 'a@x.com', { company_name: 'Acme', signer_title: 'Owner' }, upd);
    expect(c).toMatchObject({ user_id: 'u1', email: 'a@x.com', company_name: 'Acme', attestation_signer_title: 'Owner', status: 'pending_approval', coi_file_url: 'c', onboarding_step: 2 });
  });
});

// ============================================================
// Step 2 — EF bodies (contracts UNCHANGED)
// ============================================================
describe('EF request bodies (UNCHANGED contracts)', () => {
  it('create-hubspot-contact: contractor mode', () => {
    expect(buildHubspotContactBody('a@x.com', 'c1')).toEqual({ mode: 'contractor', email: 'a@x.com', contractor_id: 'c1' });
  });

  it('send-support-email: admin-routed (NO to_email -> never the open-relay override path)', () => {
    const b = buildSupportEmailBody({ company_name: 'Acme' }, 'a@x.com');
    expect(b).toEqual({
      from_name: 'Acme', from_email: 'a@x.com',
      subject: 'New Contractor Application — Documents Received',
      message: 'Contractor has submitted required insurance and documentation. Ready for verification.',
    });
    expect('to_email' in b).toBe(false);
    // from_name falls back to contact_name then 'New Applicant'
    expect(buildSupportEmailBody({ contact_name: 'Pat' }, 'a@x.com').from_name).toBe('Pat');
    expect(buildSupportEmailBody({}, 'a@x.com').from_name).toBe('New Applicant');
  });
});

// ============================================================
// Step 3 — attestation (Tier-3 VERBATIM)
// ============================================================
describe('IC 24-5-11 attestation (Tier-3 verbatim version + payload)', () => {
  it('locked version strings — byte-for-byte with the static page', () => {
    expect(ATTESTATION_TEXT_VERSION).toBe('ic-24511-v1-2026-04');
    expect(CPA_VERSION).toBe('v1-2026-04');
    expect(AGREEMENT_VERSION).toBe('v1-2026-04');
  });

  it('the 3 required agreement checks (TCPA optional)', () => {
    expect(REQUIRED_AGREEMENT_CHECKS).toEqual(['agreeToPartnerAgreement', 'agreeToCancellationPolicy', 'agreeToAttestation']);
    expect(step3Complete(true, true, true)).toBe(true);
    expect(step3Complete(true, true, false)).toBe(false);
    expect(step3Complete(false, true, true)).toBe(false);
  });

  it('buildAttestationPayload mirrors submitStep3 (platform + cancellation acks)', () => {
    expect(buildAttestationPayload('UA/1', ISO)).toEqual({
      text_version: 'ic-24511-v1-2026-04', accepted: true, accepted_client_ts: ISO,
      user_agent: 'UA/1', platform_agreement_ack: true, cancellation_policy_ack: true,
    });
  });

  it('buildStep3ContractorUpdate stamps cpa/attestation/agreement + sms gated on TCPA', () => {
    const a = buildAttestationPayload('UA', ISO);
    const withSms = buildStep3ContractorUpdate({ contact_name: 'Pat', attestation_signer_title: 'Owner' }, a, true, ISO);
    expect(withSms).toMatchObject({
      cpa_accepted_at: ISO, cpa_version: 'v1-2026-04',
      attestation_signer_name: 'Pat', attestation_signer_title: 'Owner',
      attestation_text_version: 'ic-24511-v1-2026-04', attestation_accepted_at: ISO,
      ic_24511_attestation: a, sms_consent_ts: ISO,
      agreement_accepted_at: ISO, agreement_version: 'v1-2026-04', onboarding_step: 3, updated_at: ISO,
    });
    expect(buildStep3ContractorUpdate({}, a, false, ISO).sms_consent_ts).toBeNull();
  });

  it('record-attestation body is the static (mismatched, non-fatal) payload — NO attestation_type', () => {
    const b = buildRecordAttestationBody('c1', ISO);
    expect(b).toEqual({ contractor_id: 'c1', text_version: 'ic-24511-v1-2026-04', accepted_at: ISO, accepted_client_ts: ISO });
    // The EF's documented contract requires attestation_type; the static page (and this port)
    // deliberately do NOT send it (the authoritative record is the contractors UPDATE).
    expect('attestation_type' in b).toBe(false);
  });
});

// ============================================================
// Step 4 — contract template
// ============================================================
describe('contract template (D-209)', () => {
  it('validateTemplate: trade+funding, PDF type, <=10MB', () => {
    expect(validateTemplate('', 'Retail', { type: 'application/pdf', size: 1 })).toMatch(/trade and funding/i);
    expect(validateTemplate('Roofing', 'Retail', null)).toMatch(/select a PDF/i);
    expect(validateTemplate('Roofing', 'Retail', { type: 'image/png', size: 1 })).toMatch(/upload a PDF/i);
    expect(validateTemplate('Roofing', 'Retail', { type: 'application/pdf', size: 11 * 1024 * 1024 })).toMatch(/10MB/i);
    expect(validateTemplate('Roofing', 'Retail', { type: 'application/pdf', size: 1024 })).toBeNull();
  });

  it('templateSlotKey lowercases, spaces->_, strips parens', () => {
    expect(templateSlotKey('Roofing', 'Retail')).toBe('roofing/retail');
    expect(templateSlotKey('Siding', 'Insurance (full replacement)')).toBe('siding/insurance_full_replacement');
  });

  it('templateFilePath = contractorId/slotKey.pdf', () => {
    expect(templateFilePath('c1', 'roofing/retail')).toBe('c1/roofing/retail.pdf');
  });

  it('buildContractTemplatesArray replaces same trade+funding, else appends', () => {
    const existing = [{ trade: 'Roofing', funding_type: 'Retail', path: 'old.pdf', uploaded_at: 'old' }];
    const appended = buildContractTemplatesArray(existing, 'Siding', 'Retail', 'new.pdf', ISO);
    expect(appended).toHaveLength(2);
    const replaced = buildContractTemplatesArray(existing, 'Roofing', 'Retail', 'new.pdf', ISO);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toEqual({ trade: 'Roofing', funding_type: 'Retail', path: 'new.pdf', uploaded_at: ISO });
    expect(buildContractTemplatesArray(null, 'Roofing', 'Retail', 'p.pdf', ISO)).toHaveLength(1);
  });

  it('buildFinishSubmitUpdate sets pending_approval + step 4', () => {
    const u = buildFinishSubmitUpdate([], ISO);
    expect(u).toEqual({ contract_templates: [], status: 'pending_approval', onboarding_step: 4, updated_at: ISO });
  });

  it('template catalogs match the static selectors', () => {
    expect(TEMPLATE_TRADES).toEqual(['Roofing', 'Siding', 'Gutters', 'Windows']);
    expect(TEMPLATE_FUNDING_TYPES).toEqual(['Insurance (full replacement)', 'Retail']);
  });
});

// ============================================================
// Verbatim Tier-3 legal copy (byte-for-byte with the static page)
// ============================================================
describe('verbatim Tier-3 legal copy', () => {
  const A = PRE_APPROVAL_COPY.step3.attestation;
  it('attestation heading + intro + e-sign line', () => {
    expect(A.heading).toBe('Contractor Attestation & Indemnity');
    expect(A.intro).toBe('Otter Quotes is a contractor matching and payments platform. By accepting below, you personally and on behalf of the business attest that:');
    expect(A.esignLine).toBe('Electronic acceptance constitutes your signature under the E-SIGN Act and UETA.');
  });

  it('attestation bullets (4) incl. CGL $1M/$2M, IC 24-5-11, joint-and-several indemnity', () => {
    expect(A.bullets).toHaveLength(4);
    expect(A.bullets[0]).toBe('You hold all licenses required in every jurisdiction where you work.');
    expect(A.bullets[1]).toBe('You carry CGL insurance of at least $1M/$2M with Stellar Edge Services, LLC as additional insured.');
    expect(A.bullets[2]).toBe('You will comply with Indiana Code 24-5-11 on every Indiana project and all equivalent laws in other states.');
    expect(A.bullets[3]).toContain('joint and several');
    expect(A.bullets[3]).toContain('survives termination');
    expect(A.bullets[3]).toContain('Stellar Edge Services, LLC');
  });

  it('attestation acceptance checkbox label is verbatim', () => {
    expect(A.checkLabel).toBe('I am authorized to bind the business. I attest to the licensing, insurance, IC 24-5-11 compliance, and joint-and-several indemnity obligations above. I intend this electronic acceptance to be my signature.');
  });

  it('partner agreement: 5% fee disclosure + sign-via-DocuSign', () => {
    const p = PRE_APPROVAL_COPY.step3.partnerAgreement;
    expect(p.heading).toBe('Contractor Partner Agreement');
    expect(p.bodyPost).toContain('platform fee is 5% of your accepted bid amount for all job types');
    expect(p.checkLabel).toContain('platform fee structure');
  });

  it('cancellation policy: 3-day switch + sole-remedy clause', () => {
    const c = PRE_APPROVAL_COPY.step3.cancellation;
    expect(c.heading).toBe('Homeowner Cancellation Policy');
    expect(c.body).toContain('up to 3 days before their scheduled installation date');
    expect(c.bodyStrong).toBe('A platform fee refund is your sole remedy if a homeowner exercises this right.');
  });

  it('TCPA SMS consent is optional + STOP to unsubscribe', () => {
    expect(PRE_APPROVAL_COPY.step3.tcpa.checkLabel).toContain('Reply STOP to unsubscribe');
    expect(PRE_APPROVAL_COPY.step3.tcpa.checkLabel).toContain('Optional');
  });

  it('D-225 submitted panel copy is verbatim', () => {
    expect(PRE_APPROVAL_COPY.submitted.title).toBe('Application Submitted!');
    expect(PRE_APPROVAL_COPY.submitted.body).toBe("We're finishing up the platform and are bringing on contractors before we open to homeowners. You don't pay anything until you get a customer. We'll text you as soon as opportunities are available.");
  });

  it('COI card names Stellar Edge Services, LLC as additional insured', () => {
    expect(PRE_APPROVAL_COPY.step2.coi.subtitle).toContain('Stellar Edge Services, LLC as additional insured');
  });
});

describe('str coercion', () => {
  it('null/undefined -> empty string', () => {
    expect(str(null)).toBe('');
    expect(str(undefined)).toBe('');
    expect(str(5)).toBe('5');
  });
});
