/**
 * gh-2556 / D-366 -- pins the five approved wordings (items 1, 2, 3, 4 and 6 of issue #2556; item 5, Privacy Section 12, is
 * deliberately NOT changed and is pinned here as unchanged). Every string below was copied by script from the issue
 * (body 2556 and comment 6016275310), not retyped. Source comment ids: approval 6016654830, decision D-366 6017132949.
 * The static pages are raw HTML, so this reads them as text, following the repo's source-guard convention
 * (see admin/fee-config/__tests__/gh2105-admin-fee-config-html-zero-row.test.ts).
 * FAIL-FIRST: against main every "new text present" and every "old text absent" assertion below fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SIGN_COPY } from '../copy';

const here = dirname(fileURLToPath(import.meta.url));
// react-app/app/(homeowner)/contract-signing/__tests__ -> repo root is 5 levels up.
const root = resolve(here, '..', '..', '..', '..', '..');
const read = (f: string) => readFileSync(resolve(root, f), 'utf8');
const agreement = read('contractor-agreement.html');
const signing = read('contract-signing.html');
const privacy = read('privacy.html');
const preApproval = read('contractor-pre-approval.html');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
// contract-signing.html screen 2 wraps "third business day" in a <strong>; strip markup to compare the words.
const text = (html: string) => html.replace(/<[^>]+>/g, '');

const OLD = {
  s93: "While Otter Quotes provides the cancellation notice and right-to-cancel form, Contractor remains responsible for ensuring that its uploaded contract template contains all other elements required by IC 24-5-11, including but not limited to:",
  s92: "Otter Quotes automatically appends to every Contract facilitated through the Platform for Indiana properties a compliance addendum containing: (a) the three-day right-to-cancel notice required by IC 24-5-11-7, and (b) a detachable cancellation form as required by IC 24-5-11-8. Contractor acknowledges and agrees that this addendum will be attached to all Contracts executed through the Platform.",
  s95: "Otter Quotes may, but is not obligated to, provide jurisdiction-specific compliance addenda for states other than Indiana.",
  signing1: "You may cancel this contract at any time before midnight on the third business day after signing. A Notice of Cancellation form is included in the contract documents. Both you and the contractor will sign this agreement.",
  signing2: "You have the right to cancel this contract at any time before midnight on the third business day after the date you signed. To cancel, complete and deliver the Notice of Cancellation form included in your contract documents to your contractor. No penalty applies.",
  s41: "If you request contractor recommendations or matching services, we will share relevant information (property details, project scope, insurance information) with contractors you connect with on our platform.",
  s71: "4 years from creation, then deleted unless the lead has become an account",
};
const NEW = {
  s93: "Contractor is responsible for ensuring that its uploaded contract template contains every element required by IC 24-5-11, including the statement of the consumer's right to cancel and the attached Notice of Cancellation form, and including but not limited to:",
  signing1: "You may cancel this contract at any time before midnight on the third business day after signing, or the third business day after your insurance company's written final decision on your claim if that is later. Both you and the contractor will sign this agreement.",
  signing2: "You have the right to cancel this contract at any time before midnight on the third business day after the date you signed, or the third business day after your insurance company's written final decision on your claim if that is later. To cancel, give your contractor written notice; you may use the Notice of Cancellation form in your contract documents.",
  s41Added: "We share your name and contact information with the contractor you select, so they can prepare and perform your contract.",
  s71: "4 years from creation, then deleted unless the lead has become an account or we hold a call or text consent record for it",
  // D-366 amendment (#2556 comment 6022019578, 2026-10-06T17:43:49Z): Effective Date line with the Section 18.1 carve-out.
  effective: "Effective Date: October 6, 2026. For Contractors who accepted an earlier version, the changes apply to new Opportunities posted after the date stated in the written notice sent under Section 18.1.",
};

describe('gh-2556 item 1: Contractor Agreement 9.3', () => {
  it('old sentence absent, approved sentence present once', () => {
    expect(agreement).not.toContain(OLD.s93);
    expect(count(agreement, NEW.s93)).toBe(1);
  });
  it('the four IC 24-5-11-4 pin cites are struck', () => {
    for (const n of [1, 2, 3, 4]) expect(agreement).not.toContain('(IC 24-5-11-4(' + n + '))');
  });
});

describe('gh-2556 item 2: Contractor Agreement 9.2 reserved, 9.5 last sentence deleted', () => {
  it('9.2 paragraph and heading are gone; "9.2 [Reserved]" stands; 9.3 to 9.5 keep their numbers', () => {
    expect(agreement).not.toContain(OLD.s92);
    expect(agreement).not.toContain("Compliance Addendum</h3>");
    expect(agreement).toContain('<h3>9.2 [Reserved]</h3>');
    for (const h of ['9.3 Contractor', '9.4 Contractor Signing Order', '9.5 Compliance for Other Jurisdictions']) expect(agreement).toContain(h);
  });
  it('9.5 last sentence deleted', () => {
    expect(agreement).not.toContain(OLD.s95);
  });
});

describe('gh-2556 item 3: homeowner signing screens, static and React byte-equal to the approved text', () => {
  it('static page: old screen 1 and 2 text absent, approved text present', () => {
    expect(signing).not.toContain(OLD.signing1);
    expect(text(signing)).not.toContain(OLD.signing2);
    expect(signing).toContain(NEW.signing1);
    expect(text(signing)).toContain(NEW.signing2);
  });
  it('React copy.ts equals the approved text and the static page', () => {
    expect(SIGN_COPY.rightToCancelBody).toBe(NEW.signing1);
    expect(SIGN_COPY.indianaRightsBody).toBe(NEW.signing2);
    expect(text(signing)).toContain(SIGN_COPY.rightToCancelBody);
    expect(text(signing)).toContain(SIGN_COPY.indianaRightsBody);
  });
  it('no signing copy says a form "is included" or "No penalty applies"', () => {
    expect(SIGN_COPY.rightToCancelBody).not.toContain('is included');
    expect(SIGN_COPY.indianaRightsBody).not.toContain('No penalty applies');
  });
});

describe('gh-2556 amendment: Contractor Agreement Effective Date line (D-366, comment 6022019578)', () => {
  it('prints the date plus the Section 18.1 carve-out, once; the bare date line is gone', () => {
    expect(count(agreement, NEW.effective)).toBe(1);
    expect(agreement).not.toContain('Effective Date: October 6, 2026</p>');
  });
});

describe('gh-2556 item 4 and 6: Privacy 4.1 and 7.1', () => {
  it('4.1 keeps its sentence and adds the approved sentence directly after it', () => {
    expect(privacy).toContain(OLD.s41 + ' ' + NEW.s41Added);
  });
  it('7.1 lead retention is the approved sentence; old one absent', () => {
    expect(privacy).not.toContain('<td>' + OLD.s71 + '</td>');
    expect(privacy).toContain('<td>' + NEW.s71 + '</td>');
  });
});

describe('gh-2556 item 5 untouched and the version rule', () => {
  it('Privacy Section 12 opt-out wording is unchanged (item 5: leave)', () => {
    expect(privacy).toContain('To exercise your right to Do Not Sell or Share My Personal Information, contact us at <a href="mailto:support@otterquote.com">support@otterquote.com</a>.');
    expect(privacy).toContain('We treat a Global Privacy Control (GPC) signal sent by your browser as a request to opt out of the sale or sharing of your personal information for advertising purposes.');
    expect(privacy).not.toContain('we do not load Clarity');
  });
  it('agreement_version moves to v2-2026-10 on the static page; cpa_version stays v1-2026-04', () => {
    expect(preApproval).toContain("agreement_version:        'v2-2026-10',");
    expect(preApproval).not.toContain("agreement_version:        'v1-2026-04',");
    expect(preApproval).toContain("cpa_version:              'v1-2026-04',"); // cpa_version line untouched
  });
});
