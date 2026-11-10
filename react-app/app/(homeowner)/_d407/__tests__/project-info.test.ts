import { describe, it, expect } from 'vitest';
import {
  buildOopClaimUpdate,
  buildRcvClaimUpdate,
  formatPropertyAddress,
  missingContact,
  missingForOop,
  missingForRcv,
  type ContactInfo,
  type ProjectInfoInput,
} from '../project-info';
import { initialSelectionState } from '../../help-materials/utils';
import type { MaterialSelectionState } from '../../help-materials/types';

const contact: ContactInfo = { fullName: 'Jane Doe', phone: '317-555-0100', email: 'j@example.com', address: '1 Main St' };
const info: ProjectInfoInput = { urgency: 'flexible', urgencyDeadline: '', urgencyReason: '', notes: '' };
const done: MaterialSelectionState = { ...initialSelectionState(), category: 'shingles', shingleType: '3-tab' };

describe('required fields (negative controls)', () => {
  it('RCV: everything present -> nothing missing', () => {
    expect(missingForRcv({ contact, hasEstimate: true, material: done })).toEqual([]);
  });
  it('RCV: each required item missing is reported, so the page cannot advance', () => {
    expect(missingForRcv({ contact: { ...contact, fullName: ' ' }, hasEstimate: true, material: done })).toEqual(['name']);
    expect(missingForRcv({ contact: { ...contact, phone: '' }, hasEstimate: true, material: done })).toEqual(['phone']);
    expect(missingForRcv({ contact: { ...contact, address: '' }, hasEstimate: true, material: done })).toEqual(['address']);
    expect(missingForRcv({ contact, hasEstimate: false, material: done })).toEqual(['estimate']);
    expect(missingForRcv({ contact, hasEstimate: true, material: initialSelectionState() })).toEqual(['materials']);
  });
  it('OOP: measurement is required', () => {
    expect(missingForOop({ contact, hasMeasurement: false, material: done })).toEqual(['measurement']);
    expect(missingForOop({ contact, hasMeasurement: true, material: done })).toEqual([]);
    // gh-3284: an estimate stands in for the measurement only when acceptEstimate (stored ACV) is set
    expect(missingForOop({ contact, hasMeasurement: false, hasEstimate: true, material: done })).toEqual(['measurement']);
    expect(missingForOop({ contact, hasMeasurement: false, hasEstimate: true, acceptEstimate: true, material: done })).toEqual([]);
    expect(missingForOop({ contact, hasMeasurement: true, hasEstimate: false, acceptEstimate: true, material: done })).toEqual([]);
    expect(missingForOop({ contact, hasMeasurement: false, hasEstimate: false, acceptEstimate: true, material: done })).toEqual(['estimate_or_measurement']);
  });
  it('contact check alone', () => {
    expect(missingContact({ ...contact, fullName: '', phone: '' })).toEqual(['name', 'phone']);
  });
});

describe('RCV write never overwrites the stored policy answer (D-079)', () => {
  it.each([null, undefined, 'idk', 'acv', 'rcv'])('policy_type is never in the update (stored=%s)', (stored) => {
    const u = buildRcvClaimUpdate(info, 'Jane Doe', done, stored);
    expect('policy_type' in u).toBe(false);
    expect(u.funding_type).toBe('insurance');
  });
  it('job_type insurance_rcv only when the stored answer is rcv', () => {
    expect(buildRcvClaimUpdate(info, 'J', done, 'rcv').job_type).toBe('insurance_rcv');
    for (const s of [null, undefined, 'idk', 'acv']) {
      expect('job_type' in buildRcvClaimUpdate(info, 'J', done, s)).toBe(false);
    }
  });
  it('carries the material selection and contact name', () => {
    const u = buildRcvClaimUpdate(info, ' Jane Doe ', done, 'rcv');
    expect(u.has_material_selection).toBe(true);
    expect(u.shingle_type).toBe('3-tab');
    expect(u.homeowner_name).toBe('Jane Doe');
  });
});

describe('project info write', () => {
  it('deadline and reason only travel with asap; blank notes never erase', () => {
    const asap = buildOopClaimUpdate({ urgency: 'asap', urgencyDeadline: '2026-12-01', urgencyReason: 'closing', notes: '' }, 'J', done);
    expect(asap.urgency_deadline).toBe('2026-12-01');
    expect('homeowner_notes' in asap).toBe(false);
    const flex = buildOopClaimUpdate({ ...info, urgencyDeadline: '2026-12-01', urgencyReason: 'x' }, 'J', done);
    expect(flex.urgency_deadline).toBeNull();
    expect(flex.job_type).toBe('retail');
    expect(flex.policy_type).toBeNull();
  });
});

describe('OOP write never reclassifies a stored answer (D-079 / D-073)', () => {
  it('NEGATIVE CONTROL: stored acv stays insurance_acv / insurance, policy_type untouched', () => {
    const u = buildOopClaimUpdate(info, 'J', done, 'acv', 'insurance');
    expect(u.job_type).toBe('insurance_acv');
    expect(u.funding_type).toBe('insurance');
    expect('policy_type' in u).toBe(false);
  });
  it('genuine out-of-pocket (no stored policy, cash funding) stays cash / retail', () => {
    for (const [pol, fund] of [[null, 'cash'], [undefined, null], [null, undefined]] as const) {
      const u = buildOopClaimUpdate(info, 'J', done, pol, fund);
      expect(u.job_type).toBe('retail');
      expect(u.funding_type).toBe('cash');
      expect(u.policy_type).toBeNull();
    }
  });
  it('other stored answers (rcv, idk, insurance with no policy) get no classification keys', () => {
    for (const [pol, fund] of [['rcv', 'insurance'], ['idk', 'insurance'], [null, 'insurance']] as const) {
      const u = buildOopClaimUpdate(info, 'J', done, pol, fund);
      for (const k of ['job_type', 'funding_type', 'policy_type']) expect(k in u).toBe(false);
    }
  });
});

describe('formatPropertyAddress (gh-3587)', () => {
  const z = { property_city: 'Zionsville', property_state: 'IN', property_zip: '46077' };
  const noZip = { property_city: 'Zionsville', property_state: 'IN', property_zip: '' };
  const noCity = { property_city: '', property_state: 'IN', property_zip: '46077' };
  const cases: [string, string, Record<string, string>, string][] = [
    // already a full address: shown once, never re-appended
    ['full address', '1 Test Lane, Zionsville, IN 46077', z, '1 Test Lane, Zionsville, IN 46077'],
    ['full address, original duplicate bug', '1 Test Lane, Zionsville, IN 46077', z, '1 Test Lane, Zionsville, IN 46077'],
    ['missing zip field', '1 Test Lane, Zionsville, IN', noZip, '1 Test Lane, Zionsville, IN'],
    ['missing city field', '1 Test Lane, Zionsville, IN 46077', noCity, '1 Test Lane, Zionsville, IN 46077'],
    ['ZIP+4', '1 Test Lane, Zionsville, IN 46077-1234', z, '1 Test Lane, Zionsville, IN 46077-1234'],
    ['no comma before state', '1 Test Lane, Zionsville IN 46077', z, '1 Test Lane, Zionsville IN 46077'],
    ['no commas at all', '1 Test Lane Zionsville IN 46077', z, '1 Test Lane Zionsville IN 46077'],
    ['trailing comma', '1 Test Lane, Zionsville, IN 46077,', z, '1 Test Lane, Zionsville, IN 46077'],
    ['trailing ", USA"', '1 Test Lane, Zionsville, IN 46077, USA', z, '1 Test Lane, Zionsville, IN 46077, USA'],
    ['trailing "USA" without comma', '1 Test Lane, Zionsville, IN 46077 USA', z, '1 Test Lane, Zionsville, IN 46077 USA'],
    ['comma between state and zip', '1 Test Lane, Zionsville, IN, 46077', z, '1 Test Lane, Zionsville, IN, 46077'],
    ['extra spaces and case', '  1 Test Lane ,  zionsville ,  in   46077 , usa ', z, '1 Test Lane ,  zionsville ,  in   46077 , usa'],
    ['reviewer example (dirty street)', '1 Test Lane, Zionsville, IN 46077, Zionsville, IN', z, '1 Test Lane, Zionsville, IN 46077, Zionsville, IN'],
    // street plus a partial tail: append only what is missing
    ['city-only tail', '1 Test Lane, Zionsville', z, '1 Test Lane, Zionsville, IN 46077'],
    ['city and state tail, zip field present', '1 Test Lane, Zionsville, IN', z, '1 Test Lane, Zionsville, IN 46077'],
    // street-only: compose from the fields present
    ['street only', '1 Test Lane', z, '1 Test Lane, Zionsville, IN 46077'],
    ['street only, no zip', '1 Test Lane', noZip, '1 Test Lane, Zionsville, IN'],
    ['street only, no city', '1 Test Lane', noCity, '1 Test Lane, IN 46077'],
    // street text that merely resembles part of the address keeps everything
    ['Carmel Dr in Carmel', '100 Carmel Dr', { property_city: 'Carmel', property_state: 'IN', property_zip: '46032' }, '100 Carmel Dr, Carmel, IN 46032'],
    ['street with NW suffix', '12 Main St, NW', { property_city: 'Carmel', property_state: 'IN', property_zip: '46032' }, '12 Main St, NW, Carmel, IN 46032'],
    ['street name equals state letters', '46032 In Ave', { property_city: 'Carmel', property_state: 'IN', property_zip: '46032' }, '46032 In Ave, Carmel, IN 46032'],
  ];
  it.each(cases)('%s', (_n, street, loc, expected) => {
    expect(formatPropertyAddress({ property_address: street, ...loc })).toBe(expected);
  });
  it('empty street returns empty string', () => {
    expect(formatPropertyAddress({ property_address: ' ', ...z })).toBe('');
  });
});
