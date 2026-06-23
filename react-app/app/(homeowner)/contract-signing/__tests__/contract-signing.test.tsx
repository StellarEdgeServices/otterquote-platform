/**
 * Parity + unit tests for the homeowner contract-signing scaffolding
 * (D-211 Phase 25, H3 — PR 1/2).
 *
 *  1. TIER-3 verbatim copy: the homeowner legal / disclosure blocks are asserted
 *     BYTE-FOR-BYTE against contract-signing.html (the live homeowner reference).
 *     Any reword of ./copy.ts trips this — the intended Tier-3 tripwire.
 *  2. <DocuSignEmbed>: onComplete fires on each of the three completion signals and
 *     NOT on unrelated / non-string messages; the iframe renders with id/allow/src.
 *  3. Pure helpers (./utils + the embed's pure exports): claim-id resolution,
 *     selected-quote / gate logic, the return_url shape, the create-docusign-envelope
 *     body builder, isSigningCompleteReturn, and the in-iframe return bridge.
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SIGN_COPY } from '../copy';
import {
  DocuSignEmbed,
  isSigningCompleteReturn,
  postSigningCompleteToParent,
  runSigningReturnBridge,
} from '@/components/docusign-embed';
import {
  resolveClaimId,
  resolveSelectedQuote,
  resolveSignGate,
  buildHomeownerReturnUrl,
  buildHomeownerEnvelopeRequest,
  type SigningClaim,
  type SignableQuote,
} from '../utils';

// ── Verbatim source strings — contract-signing.html @ 92eb09c (see copy.ts refs) ──
const STATIC = {
  rightToCancelTitle: 'Your Right to Cancel (Indiana Law IC 24-5-11)',
  rightToCancelBody:
    'You may cancel this contract at any time before midnight on the third business day after signing. A Notice of Cancellation form is included in the contract documents. Both you and the contractor will sign this agreement.',
  noCostTitle: 'No Cost to You',
  noCostBody:
    'Otter Quotes is 100% free for Homeowners. The price shown in this contract is the price you pay your contractor — there are no separate fees from Otter Quotes.',
  // (a) reconstituted (lead + name fallback + tail).
  ackLabelFull:
    'I understand I am signing a contract directly with the contractor. Otter Quotes is not a party to this agreement.',
  ackHint: 'Required before signing.',
  indianaRightsTitle: '⚖️ Your Rights Under Indiana Law (IC 24-5-11)',
  indianaRightsBody:
    'You have the right to cancel this contract at any time before midnight on the third business day after the date you signed. To cancel, complete and deliver the Notice of Cancellation form included in your contract documents to your contractor. No penalty applies.',
  switchPolicyTitle: '🔄 Otter Quotes Contractor Switch Policy',
  switchPolicyP1:
    'Changed your mind about your contractor? Up to 3 days before your scheduled installation date, you can switch to a different contractor in the Otter Quotes network — at no cost to you.',
  switchPolicyP2:
    'Otter Quotes handles the entire transition. Your project goes back out to the contractor network and a replacement is selected. You do not need to contact your current contractor directly.',
  switchPolicyNote:
    'Note: If you choose to leave the Otter Quotes platform entirely rather than switch within the network, you remain bound by the contract you signed with your contractor. To initiate a contractor switch, go to your dashboard and use the "Switch Contractor" option, or contact us at support@otterquote.com.',
  signedContractTitle: '📋 Your Signed Contract',
  signedContractBody:
    'DocuSign has emailed a copy of your fully signed contract to the address on your account. Keep it for your records.',
  signedContractSpam:
    "If you don't see it within a few minutes, check your spam folder or contact us at support@otterquote.com.",
  signedTitle: 'Contract Signed Successfully',
  signedBody: 'Your signed contract has been recorded.',
  returningText: 'Contract signed! Returning...',
};

describe('TIER-3 verbatim homeowner legal copy (byte-for-byte)', () => {
  it('Step-1 callouts match contract-signing.html exactly', () => {
    expect(SIGN_COPY.rightToCancelTitle).toBe(STATIC.rightToCancelTitle);
    expect(SIGN_COPY.rightToCancelBody).toBe(STATIC.rightToCancelBody);
    expect(SIGN_COPY.noCostTitle).toBe(STATIC.noCostTitle);
    expect(SIGN_COPY.noCostBody).toBe(STATIC.noCostBody);
  });

  it('D-123 acknowledgment (split lead+name+tail) + hint match exactly', () => {
    expect(
      SIGN_COPY.ackLabelLead + SIGN_COPY.ackContractorNameFallback + SIGN_COPY.ackLabelTail,
    ).toBe(STATIC.ackLabelFull);
    expect(SIGN_COPY.ackHint).toBe(STATIC.ackHint);
  });

  it('Step-3 Indiana rights + switch policy + signed-contract note match exactly', () => {
    expect(SIGN_COPY.indianaRightsTitle).toBe(STATIC.indianaRightsTitle);
    expect(SIGN_COPY.indianaRightsBody).toBe(STATIC.indianaRightsBody);
    expect(SIGN_COPY.switchPolicyTitle).toBe(STATIC.switchPolicyTitle);
    expect(SIGN_COPY.switchPolicyP1).toBe(STATIC.switchPolicyP1);
    expect(SIGN_COPY.switchPolicyP2).toBe(STATIC.switchPolicyP2);
    expect(SIGN_COPY.switchPolicyNote).toBe(STATIC.switchPolicyNote);
    expect(SIGN_COPY.signedContractTitle).toBe(STATIC.signedContractTitle);
    expect(SIGN_COPY.signedContractBody).toBe(STATIC.signedContractBody);
    expect(SIGN_COPY.signedContractSpam).toBe(STATIC.signedContractSpam);
  });

  it('signed-confirmation + in-iframe bridge text match exactly', () => {
    expect(SIGN_COPY.signedTitle).toBe(STATIC.signedTitle);
    expect(SIGN_COPY.signedBody).toBe(STATIC.signedBody);
    expect(SIGN_COPY.returningText).toBe(STATIC.returningText);
  });
});

describe('<DocuSignEmbed> completion signals', () => {
  const SIGNALS: Array<[string, string]> = [
    ['JSON {type:session_end}', JSON.stringify({ type: 'session_end' })],
    ['JSON {event:signing_complete}', JSON.stringify({ event: 'signing_complete' })],
    ['non-JSON string containing signed=true', 'https://x/contract-signing?claim_id=c1&signed=true'],
  ];

  it.each(SIGNALS)('calls onComplete on %s', (_label, data) => {
    const onComplete = vi.fn();
    const { unmount } = render(
      <DocuSignEmbed signingUrl="https://ds/sign" onComplete={onComplete} />,
    );
    window.dispatchEvent(new MessageEvent('message', { data }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('ignores unrelated and non-string messages', () => {
    const onComplete = vi.fn();
    const { unmount } = render(
      <DocuSignEmbed signingUrl="https://ds/sign" onComplete={onComplete} />,
    );
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'resize' }) }));
    window.dispatchEvent(new MessageEvent('message', { data: 'just some unrelated text' }));
    window.dispatchEvent(
      new MessageEvent('message', { data: { notAString: true } as unknown as string }),
    );
    expect(onComplete).not.toHaveBeenCalled();
    unmount();
  });

  it('renders the iframe with id=docusignFrame, signing URL, and geolocation allow', () => {
    const { container, unmount } = render(
      <DocuSignEmbed signingUrl="https://ds/sign?x=1" onComplete={() => {}} title="Sign here" />,
    );
    const frame = container.querySelector('#docusignFrame') as HTMLIFrameElement | null;
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('src')).toBe('https://ds/sign?x=1');
    expect(frame?.getAttribute('allow')).toBe('geolocation');
    expect(frame?.getAttribute('title')).toBe('Sign here');
    unmount();
  });
});

describe('isSigningCompleteReturn', () => {
  const p = (qs: string) => new URLSearchParams(qs);
  it('true for signed=true or event=signing_complete', () => {
    expect(isSigningCompleteReturn(p('signed=true'))).toBe(true);
    expect(isSigningCompleteReturn(p('event=signing_complete'))).toBe(true);
    expect(isSigningCompleteReturn(p('claim_id=c1&signed=true'))).toBe(true);
  });
  it('false for cancel/decline or no completion marker (no false success)', () => {
    expect(isSigningCompleteReturn(p('signed=false'))).toBe(false);
    expect(isSigningCompleteReturn(p('event=cancel'))).toBe(false);
    expect(isSigningCompleteReturn(p('claim_id=c1'))).toBe(false);
    expect(isSigningCompleteReturn(p(''))).toBe(false);
  });
});

describe('postSigningCompleteToParent / runSigningReturnBridge', () => {
  // self !== top → framed. Same ref → not framed.
  const makeWin = (search: string, framed: boolean) => {
    const selfRef = {};
    const topRef = framed ? {} : selfRef;
    return { self: selfRef, top: topRef, location: { search }, parent: { postMessage: vi.fn() } };
  };

  it('posts the verbatim completion payload to the parent', () => {
    const postMessage = vi.fn();
    postSigningCompleteToParent({ postMessage });
    expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ type: 'session_end', event: 'signing_complete' }),
      '*',
    );
  });

  it('fires only when framed AND a completion marker is present', () => {
    const win = makeWin('signed=true', true);
    expect(runSigningReturnBridge(win)).toBe(true);
    expect(win.parent.postMessage).toHaveBeenCalledTimes(1);
  });

  it('does nothing when not in an iframe', () => {
    const win = makeWin('signed=true', false);
    expect(runSigningReturnBridge(win)).toBe(false);
    expect(win.parent.postMessage).not.toHaveBeenCalled();
  });

  it('does nothing when framed but no completion marker', () => {
    const win = makeWin('claim_id=c1', true);
    expect(runSigningReturnBridge(win)).toBe(false);
    expect(win.parent.postMessage).not.toHaveBeenCalled();
  });
});

describe('resolveClaimId', () => {
  it('reads the claim_id query param (canonical homeowner route)', () => {
    expect(resolveClaimId(new URLSearchParams('claim_id=abc-123'))).toBe('abc-123');
    expect(resolveClaimId(new URLSearchParams('claim_id=abc-123&signed=true'))).toBe('abc-123');
  });
  it('falls back to a /contract-signing/<id> path segment', () => {
    expect(resolveClaimId(new URLSearchParams(''), '/contract-signing/xyz-9')).toBe('xyz-9');
    expect(resolveClaimId(new URLSearchParams(''), '/contract-signing/abc%2D9')).toBe('abc-9');
  });
  it('returns null when neither is present', () => {
    expect(resolveClaimId(new URLSearchParams(''))).toBeNull();
    expect(resolveClaimId(new URLSearchParams(''), '/dashboard')).toBeNull();
  });
});

describe('resolveSelectedQuote', () => {
  const SEL = 'ctr-sel';
  const q = (over: Partial<SignableQuote>): SignableQuote => ({ id: 'q', contractor_id: SEL, ...over });
  it("returns the selected contractor's quote", () => {
    expect(resolveSelectedQuote([q({ id: 'a' })], SEL)?.id).toBe('a');
  });
  it('ignores quotes belonging to another contractor', () => {
    expect(resolveSelectedQuote([q({ contractor_id: 'other' })], SEL)).toBeNull();
  });
  it('handles empty / nullish input', () => {
    expect(resolveSelectedQuote([], SEL)).toBeNull();
    expect(resolveSelectedQuote(null, SEL)).toBeNull();
    expect(resolveSelectedQuote(undefined, SEL)).toBeNull();
    expect(resolveSelectedQuote([q({})], null)).toBeNull();
  });
});

describe('resolveSignGate', () => {
  const claim = (over: Partial<SigningClaim>): SigningClaim => ({
    id: 'c', selected_contractor_id: 'ctr', ...over,
  });
  const quote = (over: Partial<SignableQuote> = {}): SignableQuote => ({
    id: 'q', contractor_id: 'ctr', ...over,
  });

  it('ready when a contract exists and the homeowner has not signed', () => {
    expect(resolveSignGate(claim({ status: 'awarded' }), quote())).toBe('ready');
  });
  it('already-signed via contract_signed_at / status / homeowner_signed_at', () => {
    expect(resolveSignGate(claim({ contract_signed_at: '2026-06-20T00:00:00Z' }), quote())).toBe(
      'already-signed',
    );
    expect(resolveSignGate(claim({ status: 'contract_signed' }), quote())).toBe('already-signed');
    expect(
      resolveSignGate(claim({ status: 'awarded' }), quote({ homeowner_signed_at: '2026-06-20T00:00:00Z' })),
    ).toBe('already-signed');
  });
  it('no-contract without a selected contractor or quote', () => {
    expect(resolveSignGate(claim({ selected_contractor_id: null }), quote())).toBe('no-contract');
    expect(resolveSignGate(claim({}), null)).toBe('no-contract');
    expect(resolveSignGate(null, quote())).toBe('no-contract');
  });
});

describe('buildHomeownerReturnUrl', () => {
  it('targets the React route with claim_id + signed=true', () => {
    expect(buildHomeownerReturnUrl('https://app.otterquote.com', 'abc-123')).toBe(
      'https://app.otterquote.com/contract-signing?claim_id=abc-123&signed=true',
    );
  });
});

describe('buildHomeownerEnvelopeRequest', () => {
  it('builds the homeowner_sign create-docusign-envelope body with return_url', () => {
    const body = buildHomeownerEnvelopeRequest({
      claimId: 'abc-123',
      contractorId: 'ctr-1',
      quoteId: 'q-1',
      signer: { email: 'home@owner.com', name: 'Home Owner' },
      origin: 'https://app.otterquote.com',
    });
    expect(body).toEqual({
      claim_id: 'abc-123',
      document_type: 'homeowner_sign',
      contractor_id: 'ctr-1',
      quote_id: 'q-1',
      signer: { email: 'home@owner.com', name: 'Home Owner' },
      return_url: 'https://app.otterquote.com/contract-signing?claim_id=abc-123&signed=true',
    });
  });
});
