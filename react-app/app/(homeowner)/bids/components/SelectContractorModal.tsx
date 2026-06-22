'use client';

/**
 * Confirm-selection modal + award flow (bids.html:1742-2016). On confirm:
 *   1. get-contractor-info → if no payment method, show "Almost There" and notify
 *      the contractor (payment_method_needed); homeowner checks back later.
 *   2. otherwise award the claim (claims/quotes writes) and redirect to the static
 *      contract-signing page. No charge here — D-127 charges post-signing.
 * Guards a claim that is already awarded/contract_signed.
 */

import { useEffect, useState } from 'react';
import {
  awardClaimToContractor,
  checkContractorPaymentMethod,
  notifyContractorPaymentNeeded,
} from '../actions';
import type { BidRow, BidsClaim, ContractorProfile } from '../types';

type ModalPhase = 'confirm' | 'processing' | 'no_payment' | 'error' | 'already_awarded';

interface SelectContractorModalProps {
  bid: BidRow;
  claim: BidsClaim;
  contractor: ContractorProfile;
  onClose: () => void;
  /** Injectable for tests; defaults to a real navigation. */
  navigate?: (href: string) => void;
}

export function SelectContractorModal({
  bid,
  claim,
  contractor,
  onClose,
  navigate,
}: SelectContractorModalProps) {
  const go = navigate || ((href: string) => { window.location.href = href; });
  const [phase, setPhase] = useState<ModalPhase>(
    claim.status === 'awarded' || claim.status === 'contract_signed' ? 'already_awarded' : 'confirm',
  );
  const [busyText, setBusyText] = useState('Awarding the project...');
  const companyName = contractor.company_name || 'this contractor';

  // Reset to confirm whenever a fresh bid is selected.
  useEffect(() => {
    setPhase(
      claim.status === 'awarded' || claim.status === 'contract_signed' ? 'already_awarded' : 'confirm',
    );
  }, [bid.id, claim.status]);

  async function confirm() {
    setPhase('processing');
    setBusyText('Verifying contractor payment method...');

    const pm = await checkContractorPaymentMethod(claim.id, bid.contractor_id);
    if (!pm || !pm.has_payment_method) {
      setPhase('no_payment');
      if (pm?.user_id) await notifyContractorPaymentNeeded(pm.user_id, claim.id);
      return;
    }

    setBusyText('Awarding the project...');
    const result = await awardClaimToContractor({ claim, bid });
    if (result.ok && result.href) {
      go(result.href);
      return;
    }
    setPhase('error');
  }

  const titleByPhase: Record<ModalPhase, string> = {
    confirm: 'Confirm Your Selection',
    processing: 'Processing...',
    no_payment: 'Almost There',
    error: 'Something Went Wrong',
    already_awarded:
      claim.status === 'contract_signed' ? 'Contract Already Signed' : 'Project Already Awarded',
  };

  return (
    <div className="oqb-modal-overlay" role="dialog" aria-modal="true" aria-label={titleByPhase[phase]}>
      <div className="oqb-modal">
        <h3 className="oqb-modal-title">{titleByPhase[phase]}</h3>

        {phase === 'confirm' && (
          <>
            <p className="oqb-modal-body">
              You&apos;re selecting <strong>{companyName}</strong>. Once confirmed, the contract will be sent to
              both you and the contractor for signature. Continue?
            </p>
            <div className="oqb-modal-actions">
              <button type="button" className="oqb-btn ghost" onClick={onClose}>
                Go Back
              </button>
              <button type="button" className="oqb-btn primary" onClick={confirm}>
                Yes, Continue
              </button>
            </div>
          </>
        )}

        {phase === 'processing' && (
          <>
            <div className="oqb-modal-spinner" role="status" aria-label="Processing" />
            <p className="oqb-modal-body">{busyText}</p>
          </>
        )}

        {phase === 'no_payment' && (
          <>
            <p className="oqb-modal-body">
              This contractor hasn&apos;t set up their payment method yet. We&apos;re notifying them now. Please
              check back soon — most contractors resolve this within a few hours.
            </p>
            <div className="oqb-modal-actions">
              <button type="button" className="oqb-btn secondary" onClick={onClose}>
                OK, I&apos;ll Check Back
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <p className="oqb-modal-body">
              There was a problem awarding this project. Please try again.
            </p>
            <div className="oqb-modal-actions">
              <button type="button" className="oqb-btn ghost" onClick={onClose}>
                Go Back
              </button>
              <button type="button" className="oqb-btn primary" onClick={confirm}>
                Try Again
              </button>
            </div>
          </>
        )}

        {phase === 'already_awarded' && (
          <>
            <p className="oqb-modal-body">
              {claim.status === 'contract_signed'
                ? 'This project has already been awarded and the contract has been signed.'
                : 'This project has already been awarded to a contractor.'}
            </p>
            <div className="oqb-modal-actions">
              <button type="button" className="oqb-btn primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
