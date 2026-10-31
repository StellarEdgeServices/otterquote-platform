import { describe, it, expect } from 'vitest';
import {
  buildOopClaimUpdate,
  buildRcvClaimUpdate,
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
