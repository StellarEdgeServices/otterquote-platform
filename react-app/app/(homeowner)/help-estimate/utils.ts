import type { CarrierProfile } from '@/lib/services';
import type { CarrierTip, CarrierTips } from './types';

export interface EmailPreview {
  to: string;
  fromName: string;
  subject: string;
  body: string;
}

const PLACEHOLDER_NAME = '[Adjuster Name]';
const PLACEHOLDER_EMAIL = '[adjuster@email.com]';

/**
 * Live email preview (mirrors help-estimate.html updateEmailPreview, lines
 * 959-994). Display-only; the bound subject/body actually sent are built
 * server-side by Services.sendAdjusterEmail. Pure.
 */
export function buildEmailPreview(input: {
  adjusterName: string;
  adjusterEmail: string;
  homeownerName: string;
  homeownerPhone: string;
  claimNumber: string;
  alsoMeasurements: boolean;
}): EmailPreview {
  const adjName = input.adjusterName || PLACEHOLDER_NAME;
  const adjEmail = input.adjusterEmail || PLACEHOLDER_EMAIL;
  const homeownerName = input.homeownerName || 'the homeowner';
  const to =
    adjEmail !== PLACEHOLDER_EMAIL ? `${adjName} <${adjEmail}>` : 'Enter adjuster info above';

  let subject = input.alsoMeasurements
    ? 'Request for Insurance Estimate & Measurements'
    : 'Request for Insurance Estimate';
  subject += input.claimNumber
    ? ` — ${homeownerName}, Claim #${input.claimNumber}`
    : ` — ${homeownerName}`;

  let body = `Hi ${adjName},\n\n`;
  body += `I'm following up on my recent property inspection. Could you please send me a copy of my insurance estimate (scope of loss) at your earliest convenience?\n\n`;
  if (input.alsoMeasurements) {
    body += `I would also appreciate any property measurements you have on file from the inspection, if available.\n\n`;
  }
  body += `You can reply directly to this email with the documents attached.\n\n`;
  body += `Thank you,\n${homeownerName}`;
  if (input.homeownerPhone) body += `\n${input.homeownerPhone}`;

  return { to, fromName: homeownerName, subject, body };
}

/** Send-enable rule (mirrors validateEmailForm): name non-empty AND email has '@' and '.'. Pure. */
export function isEmailFormValid(name: string, email: string): boolean {
  const n = name.trim();
  const e = email.trim();
  return n.length > 0 && e.includes('@') && e.includes('.');
}

export function requestTypeFor(alsoMeasurements: boolean): 'both' | 'estimate' {
  return alsoMeasurements ? 'both' : 'estimate';
}

/**
 * Build carrier-specific tips from a carrier_profiles row as STRUCTURED
 * descriptors, rendered safely as JSX by <CarrierTipsBlock> (the static page
 * used innerHTML with interpolated fields — this is the page-local hardening
 * fold-in, brief 3b/4).
 *
 * FIELD RECONCILE (verified against sql/v0-base-schema.sql:146-160 and
 * sql/v15-carrier-adjuster-kb.sql): the real columns are carrier_name,
 * claims_portal_url, claims_email, claims_phone, process_notes,
 * special_instructions, typical_estimate_days. The static page read
 * carrierData.name — that column does NOT exist; the correct field is
 * carrier_name. Omit any absent field rather than render undefined.
 */
export function buildCarrierTips(carrier: CarrierProfile | null): CarrierTips | null {
  if (!carrier) return null;
  const carrierName = (carrier.carrier_name as string) || 'Your Carrier';
  const tips: CarrierTip[] = [];

  const portal = carrier.claims_portal_url as string | null | undefined;
  const email = carrier.claims_email as string | null | undefined;
  const phone = carrier.claims_phone as string | null | undefined;
  const notes = carrier.process_notes as string | null | undefined;
  const special = carrier.special_instructions as string | null | undefined;
  const days = carrier.typical_estimate_days as number | null | undefined;

  if (portal) tips.push({ kind: 'portal', carrierName, url: portal });
  if (email) tips.push({ kind: 'email', email });
  if (phone) tips.push({ kind: 'phone', phone });
  if (notes) tips.push({ kind: 'text', text: notes });
  if (special) tips.push({ kind: 'text', text: special });
  if (typeof days === 'number') tips.push({ kind: 'days', carrierName, days });

  if (tips.length === 0) return null;
  return { title: `Tips for ${carrierName}`, tips };
}
