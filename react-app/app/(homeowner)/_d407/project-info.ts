/**
 * D-407 shared project-information helpers (gh-3283 RCV page, gh-3285 Out-of-pocket).
 *
 * Pure functions only, so the "required fields missing means no advance" rule is
 * unit-testable without rendering. This file is byte-identical in the #3283 and
 * #3285 pull requests (identical add/add merges cleanly).
 *
 * Wording sources: the urgency options and the notes label are copied from the
 * existing static project-info-rcv.html / project-info-cash.html on main; field
 * labels are plain functional labels (no legal or money claim).
 */

import type { MaterialSelectionState } from '../help-materials/types';
import { buildClaimMaterialUpdate, isConfirmReady } from '../help-materials/utils';

export type Urgency = 'flexible' | '30_days' | '2_weeks' | 'asap';

/** Verbatim from project-info-rcv.html / project-info-cash.html (select#urgency). */
export const URGENCY_OPTIONS: { value: Urgency; label: string }[] = [
  { value: 'flexible', label: 'No rush \u2014 flexible timeline' },
  { value: '30_days', label: 'Within 30 days' },
  { value: '2_weeks', label: 'Within 2 weeks' },
  { value: 'asap', label: 'ASAP \u2014 urgent' },
];

export interface ContactInfo {
  fullName: string;
  phone: string;
  /** Read-only: the signed-in account email. */
  email: string;
  /** Read-only: claims.property_address (written by trade-selector, gh-2004). */
  address: string;
}

export interface ProjectInfoInput {
  urgency: Urgency;
  urgencyDeadline: string;
  urgencyReason: string;
  notes: string;
}

export type MissingField =
  | 'name'
  | 'phone'
  | 'address'
  | 'estimate'
  | 'measurement'
  | 'materials';

const blank = (v: unknown): boolean => typeof v !== 'string' || v.trim().length === 0;

/** Contact fields still missing. Email comes from the account, address from intake. */
export function missingContact(c: ContactInfo): MissingField[] {
  const out: MissingField[] = [];
  if (blank(c.fullName)) out.push('name');
  if (blank(c.phone)) out.push('phone');
  if (blank(c.address)) out.push('address');
  return out;
}

export function materialsReady(state: MaterialSelectionState): boolean {
  return isConfirmReady(state);
}

/** RCV page: contact + insurance estimate on file + a finished material selection. */
export function missingForRcv(args: {
  contact: ContactInfo;
  hasEstimate: boolean;
  material: MaterialSelectionState;
}): MissingField[] {
  const out = missingContact(args.contact);
  if (!args.hasEstimate) out.push('estimate');
  if (!materialsReady(args.material)) out.push('materials');
  return out;
}

/** Out-of-pocket page: contact + a measurement attached + a finished material selection. */
export function missingForOop(args: {
  contact: ContactInfo;
  hasMeasurement: boolean;
  material: MaterialSelectionState;
}): MissingField[] {
  const out = missingContact(args.contact);
  if (!args.hasMeasurement) out.push('measurement');
  if (!materialsReady(args.material)) out.push('materials');
  return out;
}

/**
 * The claims columns the project-information card writes. Mirrors the static
 * pages: optional text keys are added only when filled, so a blank box cannot
 * erase a saved value; deadline/reason only travel with 'asap'.
 */
export function buildProjectInfoUpdate(
  input: ProjectInfoInput,
  fullName: string,
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    homeowner_name: fullName.trim(),
    urgency: input.urgency,
    urgency_deadline: input.urgency === 'asap' ? input.urgencyDeadline.trim() || null : null,
    urgency_reason: input.urgency === 'asap' ? input.urgencyReason.trim() || null : null,
    updated_at: new Date().toISOString(),
  };
  if (input.notes.trim()) update.homeowner_notes = input.notes.trim();
  return update;
}

/**
 * RCV page write. Never writes policy_type (D-079: the homeowner's own answer is the
 * source of truth; main's project-info-rcv.html overwrote an "I'm not sure" with
 * 'rcv', which failed LEGAL-READ on #3295). job_type insurance_rcv is written only
 * when the STORED answer is 'rcv'; otherwise job_type is left as intake set it.
 */
export function buildRcvClaimUpdate(
  input: ProjectInfoInput,
  fullName: string,
  material: MaterialSelectionState,
  storedPolicyType?: string | null,
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    ...buildProjectInfoUpdate(input, fullName),
    funding_type: 'insurance',
    ...buildClaimMaterialUpdate(material),
  };
  if (storedPolicyType === 'rcv') update.job_type = 'insurance_rcv';
  return update;
}

/** Out-of-pocket: D-073 job type retail (same values project-info-cash.html writes). */
export function buildOopClaimUpdate(
  input: ProjectInfoInput,
  fullName: string,
  material: MaterialSelectionState,
): Record<string, unknown> {
  return {
    ...buildProjectInfoUpdate(input, fullName),
    job_type: 'retail',
    funding_type: 'cash',
    policy_type: null,
    ...buildClaimMaterialUpdate(material),
  };
}
