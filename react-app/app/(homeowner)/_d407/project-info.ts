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

/** Lowercase, drop punctuation (keep hyphens), split to tokens, drop a trailing "usa". */
function addressTokens(raw: string): string[] {
  const t = raw.toLowerCase().replace(/[^a-z0-9-]+/g, ' ').trim().split(' ').filter(Boolean);
  if (t[t.length - 1] === 'usa') t.pop();
  return t;
}

/** ZIP+4 and ZIP compare equal: only the 5-digit part is significant. */
function zipToken(t: string): string {
  return /^\d{5}-\d{4}$/.test(t) ? t.slice(0, 5) : t;
}

/**
 * Single-line property address for the read-only field (gh-3587).
 *
 * Root cause: claims.property_address is, by CEO ruling (PR #1998, trade-selector
 * fullAddress()), the full combined line "street, city, ST zip"; property_city /
 * property_state / property_zip are split copies of it. Older or other-source rows
 * can hold only the street line. So the street value may or may not already carry
 * the city/state/zip, and appending them blindly shows the address twice.
 *
 * Rule (token based, no regex address shapes): normalize street and fields to
 * lowercase tokens. If the street's tokens END with a prefix of [city, state, zip]
 * (on a component boundary), append only the remaining components in their original
 * display format. If all components are already at the end, or appear together
 * anywhere in the street, return the street untouched. A street that merely
 * resembles part of the address ("100 Carmel Dr", "12 Main St, NW") matches no
 * prefix and gets every component appended.
 */
export function formatPropertyAddress(c: {
  property_address?: string | null;
  property_city?: string | null;
  property_state?: string | null;
  property_zip?: string | null;
}): string {
  const street = (c.property_address ?? '').trim().replace(/[\s,]+$/, '');
  if (!street) return '';
  const city = (c.property_city ?? '').trim();
  const state = (c.property_state ?? '').trim();
  const zip = (c.property_zip ?? '').trim();

  const comps = [
    { kind: 'city', text: city, tokens: addressTokens(city) },
    { kind: 'state', text: state, tokens: addressTokens(state) },
    { kind: 'zip', text: zip, tokens: addressTokens(zip).map(zipToken) },
  ].filter((p) => p.tokens.length > 0);
  if (comps.length === 0) return street;

  const st = addressTokens(street).map(zipToken);
  const all = comps.flatMap((p) => p.tokens);
  const endsWith = (run: string[]) =>
    run.length <= st.length && run.every((t, i) => st[st.length - run.length + i] === t);
  const containsRun = (run: string[]) => {
    for (let i = 0; i + run.length <= st.length; i++) {
      if (run.every((t, j) => st[i + j] === t)) return true;
    }
    return false;
  };
  if (endsWith(all) || containsRun(all)) return street;

  // Longest prefix of the components (whole components only) the street already ends with.
  let have = 0;
  for (let n = 1; n <= comps.length; n++) {
    if (endsWith(comps.slice(0, n).flatMap((p) => p.tokens))) have = n;
  }
  const rest = comps.slice(have);
  if (rest.length === 0) return street;
  // City is its own ", " segment; state and zip share one ("IN 46077"). A zip that
  // follows a state the street already carries continues that segment with a space.
  const city1 = rest.find((p) => p.kind === 'city');
  const stateZip = rest.filter((p) => p.kind !== 'city').map((p) => p.text).join(' ');
  if (rest[0].kind === 'zip' && have > 0) return `${street} ${stateZip}`;
  return [street, city1?.text, stateZip].filter(Boolean).join(', ');
}

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
  | 'estimate_or_measurement'
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

/**
 * Out-of-pocket page: contact + a measurement attached + a finished material selection.
 * gh-3284 (Ben, #3284 6578290796): for a stored ACV answer (acceptEstimate) an insurance
 * estimate on file stands in for the measurement, so either one satisfies the gate.
 */
export function missingForOop(args: {
  contact: ContactInfo;
  hasMeasurement: boolean;
  material: MaterialSelectionState;
  hasEstimate?: boolean;
  acceptEstimate?: boolean;
}): MissingField[] {
  const out = missingContact(args.contact);
  if (args.acceptEstimate) {
    if (!args.hasMeasurement && !args.hasEstimate) out.push('estimate_or_measurement');
  } else if (!args.hasMeasurement) out.push('measurement');
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

/**
 * Out-of-pocket page write (D-079 / D-073). The homeowner's stored answer is never
 * overwritten:
 *   - stored policy 'acv'  -> job_type insurance_acv, funding_type insurance (what
 *     main's project-info-acv.html writes; ACV is TREATED as cash by D-346, not
 *     reclassified); policy_type is left as stored.
 *   - no stored policy and funding not insurance (a genuine out-of-pocket homeowner)
 *     -> job_type retail, funding_type cash, policy_type null (project-info-cash.html).
 *   - anything else (stored rcv/idk, or insurance funding with no policy answer)
 *     -> no classification keys at all; only project info and materials are written.
 */
export function buildOopClaimUpdate(
  input: ProjectInfoInput,
  fullName: string,
  material: MaterialSelectionState,
  storedPolicyType?: string | null,
  storedFundingType?: string | null,
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    ...buildProjectInfoUpdate(input, fullName),
    ...buildClaimMaterialUpdate(material),
  };
  if (storedPolicyType === 'acv') {
    update.job_type = 'insurance_acv';
    update.funding_type = 'insurance';
  } else if (!storedPolicyType && storedFundingType !== 'insurance') {
    update.job_type = 'retail';
    update.funding_type = 'cash';
    update.policy_type = null;
  }
  return update;
}
