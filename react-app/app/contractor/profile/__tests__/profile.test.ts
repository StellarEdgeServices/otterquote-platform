/**
 * Unit + parity tests for the contractor Profile page (D-211 Phase 4).
 * Exercises the ported pure logic against contractor-profile.html @ main: the D-192
 * service-area selector (Census URL + county parse + collect/populate + view summary),
 * display formatters, contract/PC template JSONB transforms, the field-mapping modal
 * helpers, D-204 manufacturer/cert extraction + badge bucketing, D-199 validation-result
 * helpers, and upload guards. Plus a gating-parity section pinning the CPA-only gate
 * (the static profile page has NO pending-approval gate). Network/storage/EF calls live
 * in the page + components, not here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  STATE_FIPS, STATE_NAMES, STATE_ABBRS, censusCountyUrl, parseCountyList,
  buildInitialServiceConfigs, collectServiceArea, collectServiceCountiesForSave, serviceAreaSummary,
  formatPhone, tradesDisplay, brandsDisplay, normalizeWebsiteHref, storagePathFromValue, fileNameFromUrl,
  safeFundingToken, contractSlotId, contractTemplatePath, findContractTemplate, upsertContractTemplate,
  setContractFieldMappings, CONTRACT_TEMPLATE_SLOTS, CONTRACT_TEMPLATE_GROUPS, slotFundingType,
  removeContractTemplate, assignExistingTemplate, availableAssignmentTargets,
  PC_TEMPLATE_SLOTS, pcSlotKey, pcTemplatePath, mergePcTemplate,
  manufacturersWithCert, certTiersFor, splitCertVerifications, certStatusStyle, certSourceLabel,
  isCertExpiringSoon, certLetterPath, validationCounts, missingAnchors, D199_FAIL_STATES,
  initialFieldMappingValues, collectFieldMappings, validatePdfUpload, validateIntroVideo, validateCertClaim,
} from '../utils';
import { DEFAULT_FIELD_MAPPINGS, AUTOFILL_FIELDS, d199StatusLabel, D199_STATUS_LABELS } from '../copy';
import { enforceCpaRedirect, CURRENT_CPA_VERSION } from '../../_shell/cpa-guard';
import { isPendingApproval } from '../../_shell/contractor-gating';

describe('D-192 Census county selector', () => {
  it('maps all 50 state abbreviations to a FIPS + name', () => {
    expect(STATE_ABBRS.length).toBe(50);
    expect(STATE_FIPS.IN).toBe('18');
    expect(STATE_NAMES.IN).toBe('Indiana');
    expect(STATE_ABBRS[0]).toBe('AK'); // sorted
  });
  it('builds the Census 2020 PL URL by FIPS (null for unknown)', () => {
    expect(censusCountyUrl('IN')).toBe('https://api.census.gov/data/2020/dec/pl?get=NAME&for=county:*&in=state:18');
    expect(censusCountyUrl('ZZ')).toBeNull();
  });
  it('parses + strips ", <state>" + sorts the county rows; tolerates junk', () => {
    expect(parseCountyList([['NAME', 's', 'c'], ['Marion County, Indiana', '18', '097'], ['Boone County, Indiana', '18', '011']]))
      .toEqual(['Boone County', 'Marion County']);
    expect(parseCountyList('nope')).toEqual([]);
    expect(parseCountyList([])).toEqual([]);
  });
  it('populate: single saved state takes the saved counties (specific); multi-state is entire', () => {
    expect(buildInitialServiceConfigs(['IN'], ['Boone County', 'Marion County']))
      .toEqual({ IN: { mode: 'specific', counties: ['Boone County', 'Marion County'] } });
    expect(buildInitialServiceConfigs(['IN', 'OH'], ['Boone County']))
      .toEqual({ IN: { mode: 'entire', counties: [] }, OH: { mode: 'entire', counties: [] } });
    expect(buildInitialServiceConfigs([], [])).toEqual({});
  });
  it('collect gathers states + only specific-mode counties; save persists counties only (D4)', () => {
    const cfg = { IN: { mode: 'specific' as const, counties: ['Boone County'] }, OH: { mode: 'entire' as const, counties: [] } };
    expect(collectServiceArea(cfg)).toEqual({ service_states: ['IN', 'OH'], service_counties: ['Boone County'] });
    expect(collectServiceCountiesForSave(cfg)).toEqual(['Boone County']);
  });
  it('view summary: fallback / full-state / counties+states', () => {
    expect(serviceAreaSummary([], [], 'Central IN')).toBe('Central IN');
    expect(serviceAreaSummary([], [], null)).toBe('—');
    expect(serviceAreaSummary(['IN'], [], null)).toBe('Indiana (full state)');
    expect(serviceAreaSummary(['IN'], ['Boone County'], null)).toBe('Boone County (IN)');
  });
});

describe('display formatters', () => {
  it('formatPhone', () => {
    expect(formatPhone('3175019215')).toBe('(317) 501-9215');
    expect(formatPhone('13175019215')).toBe('(317) 501-9215');
    expect(formatPhone('555')).toBe('555');
    expect(formatPhone('')).toBe('—');
    expect(formatPhone(null)).toBe('—');
  });
  it('tradesDisplay / brandsDisplay / normalizeWebsiteHref', () => {
    expect(tradesDisplay(['roofing', 'siding'])).toBe('Roofing, Siding');
    expect(tradesDisplay([])).toBe('—');
    expect(brandsDisplay(['GAF', 'OC'])).toBe('GAF, OC');
    expect(brandsDisplay(null)).toBe('—');
    expect(normalizeWebsiteHref('example.com')).toBe('https://example.com');
    expect(normalizeWebsiteHref('https://x.com')).toBe('https://x.com');
  });
  it('storage path + filename helpers', () => {
    expect(storagePathFromValue('https://x/storage/v1/object/public/contractor-templates/abc/r.pdf?token=1', 'contractor-templates')).toBe('abc/r.pdf');
    expect(storagePathFromValue('abc/r.pdf', 'contractor-templates')).toBe('abc/r.pdf');
    expect(fileNameFromUrl('a/b/roofing_retail_1.pdf?x=1')).toBe('roofing_retail_1.pdf');
  });
});

describe('Contract Templates (IMP-009) JSONB transforms', () => {
  it('8 slots; id/path tokenization handles parens + spaces', () => {
    expect(CONTRACT_TEMPLATE_SLOTS.length).toBe(8);
    expect(safeFundingToken('Insurance (full replacement)')).toBe('insurance_full_replacement');
    expect(contractSlotId('Roofing', 'Insurance (full replacement)')).toBe('template_roofing_insurance_full_replacement');
    expect(contractTemplatePath('CID', 'Roofing', 'Insurance (full replacement)', 9)).toBe('CID/roofing_insurance_full_replacement_9.pdf');
  });
  it('upsert replaces the matching slot; find + setFieldMappings target it', () => {
    let list = upsertContractTemplate([], 'Roofing', 'Retail', 'p1', 'a.pdf', 't1');
    list = upsertContractTemplate(list, 'Roofing', 'Retail', 'p2', 'b.pdf', 't2');
    expect(list.length).toBe(1);
    expect(findContractTemplate(list, 'Roofing', 'Retail')?.file_url).toBe('p2');
    const mapped = setContractFieldMappings(list, 'Roofing', 'Retail', { homeowner_name: 'Client' });
    expect(mapped[0].field_mappings?.homeowner_name).toBe('Client');
    expect(findContractTemplate(list, 'Siding', 'Retail')).toBeUndefined();
  });
});

describe('gh-590: two-dropdown format + multi-slot assignment', () => {
  it('slotFundingType resolves Retail directly; Insurance preserves the Roofing "(full replacement)" quirk', () => {
    expect(slotFundingType('Roofing', 'Retail')).toBe('Retail');
    expect(slotFundingType('Siding', 'Retail')).toBe('Retail');
    expect(slotFundingType('Roofing', 'Insurance')).toBe('Insurance (full replacement)');
    expect(slotFundingType('Siding', 'Insurance')).toBe('Insurance');
    expect(slotFundingType('Gutters', 'Insurance')).toBe('Insurance');
    expect(slotFundingType('Windows', 'Insurance')).toBe('Insurance');
  });

  it('CONTRACT_TEMPLATE_GROUPS is Retail-then-Insurance, derived from the same 8 slots (no drift)', () => {
    expect(CONTRACT_TEMPLATE_GROUPS.map((g) => g.contractType)).toEqual(['Retail', 'Insurance']);
    expect(CONTRACT_TEMPLATE_GROUPS[0].slots).toHaveLength(4);
    expect(CONTRACT_TEMPLATE_GROUPS[1].slots).toHaveLength(4);
    const flat = CONTRACT_TEMPLATE_GROUPS.flatMap((g) => g.slots);
    expect(flat).toHaveLength(CONTRACT_TEMPLATE_SLOTS.length);
    for (const s of CONTRACT_TEMPLATE_SLOTS) expect(flat).toContainEqual(s);
  });

  it('removeContractTemplate clears only the target slot, leaving other slots (incl. shared file_url) intact', () => {
    let list = upsertContractTemplate([], 'Roofing', 'Retail', 'shared.pdf', 'a.pdf', 't1');
    list = upsertContractTemplate(list, 'Siding', 'Retail', 'shared.pdf', 'a.pdf', 't1'); // multi-assigned
    list = upsertContractTemplate(list, 'Gutters', 'Retail', 'other.pdf', 'b.pdf', 't2');
    const afterRemove = removeContractTemplate(list, 'Roofing', 'Retail');
    expect(findContractTemplate(afterRemove, 'Roofing', 'Retail')).toBeUndefined();
    expect(findContractTemplate(afterRemove, 'Siding', 'Retail')?.file_url).toBe('shared.pdf'); // untouched
    expect(findContractTemplate(afterRemove, 'Gutters', 'Retail')?.file_url).toBe('other.pdf'); // untouched
    expect(afterRemove).toHaveLength(2);
  });

  it('assignExistingTemplate points a new slot at the SAME file_url; no-op if source slot is empty', () => {
    const list = upsertContractTemplate([], 'Roofing', 'Retail', 'p1.pdf', 'a.pdf', 't1');
    const assigned = assignExistingTemplate(list, 'Roofing', 'Retail', 'Siding', 'Retail', 't2');
    expect(assigned).toHaveLength(2);
    expect(findContractTemplate(assigned, 'Siding', 'Retail')?.file_url).toBe('p1.pdf');
    expect(findContractTemplate(assigned, 'Siding', 'Retail')?.field_mappings).toBeUndefined(); // never copied

    const noop = assignExistingTemplate([], 'Roofing', 'Retail', 'Siding', 'Retail', 't2');
    expect(noop).toEqual([]);
  });

  it('availableAssignmentTargets excludes the source slot and any already-occupied slot', () => {
    const list = upsertContractTemplate([], 'Roofing', 'Retail', 'p1.pdf', 'a.pdf', 't1');
    const targets = availableAssignmentTargets(list, 'Roofing', 'Retail');
    expect(targets).toHaveLength(7); // 8 total minus the source
    expect(targets.some((s) => s.trade === 'Roofing' && s.fundingType === 'Retail')).toBe(false);

    const list2 = upsertContractTemplate(list, 'Siding', 'Retail', 'p2.pdf', 'b.pdf', 't2');
    const targets2 = availableAssignmentTargets(list2, 'Roofing', 'Retail');
    expect(targets2).toHaveLength(6); // source + the now-occupied Siding/Retail both excluded
  });
});

describe('Project Confirmation Templates (D-161) JSONB map', () => {
  it('8 slots; slotKey + path + non-destructive merge', () => {
    expect(PC_TEMPLATE_SLOTS.length).toBe(8);
    expect(pcSlotKey('roofing', 'retail')).toBe('roofing/retail');
    expect(pcTemplatePath('CID', 'roofing', 'retail', 5)).toBe('CID/pc_roofing_retail_5.pdf');
    expect(mergePcTemplate({ 'siding/retail': { file_url: 'x' } }, 'roofing/retail', 'y', 'iso'))
      .toEqual({ 'siding/retail': { file_url: 'x' }, 'roofing/retail': { file_url: 'y', uploaded_at: 'iso' } });
  });
});

describe('field-mapping modal helpers', () => {
  it('11 default fields; initial prefers saved, else default label; collect trims', () => {
    expect(Object.keys(DEFAULT_FIELD_MAPPINGS).length).toBe(11);
    expect(AUTOFILL_FIELDS.length).toBe(11);
    expect(initialFieldMappingValues(undefined, DEFAULT_FIELD_MAPPINGS).homeowner_name).toBe('Name');
    expect(initialFieldMappingValues({ trade: 'R', funding_type: 'Retail', file_url: 'x', field_mappings: { homeowner_name: 'Client' } }, DEFAULT_FIELD_MAPPINGS).homeowner_name).toBe('Client');
    expect(collectFieldMappings({ homeowner_name: '  Client  ' }, DEFAULT_FIELD_MAPPINGS).homeowner_name).toBe('Client');
    expect(collectFieldMappings({}, DEFAULT_FIELD_MAPPINGS).property_address).toBe('Address:');
  });
});

describe('D-204 manufacturer certifications', () => {
  const opts = [
    { manufacturer: 'GAF', tier: 'Gold', cert_required: 'Master Elite' },
    { manufacturer: 'GAF', tier: 'Silver', cert_required: 'Master Elite' },
    { manufacturer: 'GAF', tier: 'Std', cert_required: null },
    { manufacturer: 'Owens Corning', tier: 'Plat', cert_required: 'Platinum Preferred' },
  ];
  it('manufacturers + tiers come only from cert_required rows, unique + sorted', () => {
    expect(manufacturersWithCert(opts)).toEqual(['GAF', 'Owens Corning']);
    expect(certTiersFor(opts, 'GAF')).toEqual(['Master Elite']);
    expect(certTiersFor(opts, '')).toEqual([]);
  });
  it('badge split + status style + source label + expiry', () => {
    const split = splitCertVerifications([
      { manufacturer: 'GAF', cert_name: 'ME', status: 'verified' },
      { manufacturer: 'OC', cert_name: 'PP', status: 'pending' },
    ]);
    expect(split.verified.length).toBe(1);
    expect(split.other.length).toBe(1);
    expect(certStatusStyle('rejected').tag).toBe('REJECTED');
    expect(certStatusStyle('???').tag).toBe('PENDING REVIEW');
    expect(certSourceLabel('public_lookup')).toBe('Verified via public lookup');
    expect(certSourceLabel('admin_review')).toBe('Verified by admin review');
    expect(isCertExpiringSoon(new Date(Date.now() + 10 * 86400000).toISOString())).toBe(true);
    expect(isCertExpiringSoon(new Date(Date.now() + 60 * 86400000).toISOString())).toBe(false);
    expect(isCertExpiringSoon(null)).toBe(false);
  });
  it('cert letter path sanitizes mfr/cert + lowercases ext', () => {
    expect(certLetterPath('U', 'GAF Inc.', 'Master Elite!', 'L.PDF', 7)).toBe('U/GAF_Inc___Master_Elite___7.pdf');
  });
});

describe('D-199 validation-result helpers', () => {
  it('counts, missing anchors, fail-state set, status labels', () => {
    expect(validationCounts({ requiredFoundCount: 9, requiredCount: 11 })).toEqual({ found: 9, total: 11 });
    expect(validationCounts({})).toBeNull();
    expect(validationCounts(null)).toBeNull();
    expect(missingAnchors({ anchors: [{ anchor: 'Name', found: true }, { anchor: 'Address:', found: false }] }).map((a) => a.anchor)).toEqual(['Address:']);
    expect(D199_FAIL_STATES).toEqual(['manual_mapping_pending', 'rejected']);
    expect(d199StatusLabel('auto_validated').cls).toBe('val-ok');
    expect(d199StatusLabel('rejected').icon).toBe('✗');
    expect(d199StatusLabel('totally_unknown').label).toBe('totally_unknown');
    expect(Object.keys(D199_STATUS_LABELS).length).toBe(7);
  });
});

describe('upload guards', () => {
  it('pdf / intro-video / cert-claim', () => {
    expect(validatePdfUpload({ type: 'application/pdf', size: 100, name: 'a.pdf' })).toBeNull();
    expect(validatePdfUpload({ type: 'image/png', size: 100, name: 'a.png' })).toBe('Please upload a PDF file.');
    expect(validatePdfUpload({ type: 'application/pdf', size: 11 * 1024 * 1024, name: 'a.pdf' })).toBe('File too large. Maximum 10MB.');
    expect(validateIntroVideo({ type: 'video/mp4', size: 100, name: 'v.mp4' })).toBeNull();
    expect(validateIntroVideo({ type: 'video/quicktime', size: 100, name: 'v.mov' })).toBeNull();
    expect(validateIntroVideo({ type: 'video/x-msvideo', size: 100, name: 'v.avi' })).toBe('Please upload an MP4 or MOV file.');
    expect(validateIntroVideo({ type: 'video/mp4', size: 201 * 1024 * 1024, name: 'v.mp4' })).toBe('File too large. Maximum 200 MB.');
    expect(validateCertClaim('GAF', 'ME', { type: 'application/pdf', size: 100, name: 'c.pdf' })).toBeNull();
    expect(validateCertClaim('', '', null)).toBe('Select a manufacturer and tier first.');
    expect(validateCertClaim('GAF', 'ME', null)).toBe('Attach your cert letter (PDF or image).');
  });
});

describe('gating parity — CPA-only, NO pending-approval gate', () => {
  function fakeStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
    } as unknown as Storage;
  }

  it('redirects when the CPA is stale (and not already bounced)', () => {
    const redirect = vi.fn();
    const out = enforceCpaRedirect({ cpa_version: 'old', agreement_accepted_at: '2026-01-01' }, redirect, '/contractor/dashboard', fakeStorage());
    expect(out).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/contractor/dashboard');
  });

  it('does NOT redirect when the CPA is current', () => {
    const redirect = vi.fn();
    const out = enforceCpaRedirect({ cpa_version: CURRENT_CPA_VERSION }, redirect, '/contractor/dashboard', fakeStorage());
    expect(out).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a PENDING contractor with a current CPA is NOT redirected (profile is pending-accessible)', () => {
    const pending = { status: 'pending_approval', cpa_version: CURRENT_CPA_VERSION };
    // Static parity: isPendingApproval is true, but the profile page never acts on it.
    expect(isPendingApproval(pending)).toBe(true);
    const redirect = vi.fn();
    const out = enforceCpaRedirect(pending, redirect, '/contractor/dashboard', fakeStorage());
    expect(out).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });
});
