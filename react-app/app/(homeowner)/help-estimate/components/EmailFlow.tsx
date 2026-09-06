'use client';

import { useState } from 'react';
import type { HelpEstimateClaim } from '../types';
import { buildEmailPreview, isEmailFormValid } from '../utils';
import { sendEstimateRequest } from '../actions';

interface EmailFlowProps {
  claim: HelpEstimateClaim | null;
  homeownerName: string;
  homeownerPhone: string;
  onSent: () => void;
  onBack: () => void;
}

export function EmailFlow({ claim, homeownerName, homeownerPhone, onSent, onBack }: EmailFlowProps) {
  const [adjusterName, setAdjusterName] = useState(claim?.adjuster_name ?? '');
  const [adjusterEmail, setAdjusterEmail] = useState(claim?.adjuster_email ?? '');
  const [adjusterPhone, setAdjusterPhone] = useState(claim?.adjuster_phone ?? '');
  const [alsoMeasurements, setAlsoMeasurements] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const claimNumber = claim?.claim_number ?? '';

  const preview = buildEmailPreview({
    adjusterName,
    adjusterEmail,
    homeownerName,
    homeownerPhone,
    claimNumber,
    alsoMeasurements,
  });

  const canSend = isEmailFormValid(adjusterName, adjusterEmail) && !sending;

  async function handleSend() {
    if (!claim?.id) {
      setErrorMsg('We could not find your claim. Please return to your dashboard and try again.');
      return;
    }
    setSending(true);
    setErrorMsg(null);
    try {
      const result = await sendEstimateRequest({
        claimId: claim.id,
        carrierId: (claim.carrier_id as string | null) ?? null,
        claimNumber,
        adjusterName: adjusterName.trim(),
        adjusterEmail: adjusterEmail.trim(),
        adjusterPhone: adjusterPhone.trim(),
        homeownerName,
        homeownerPhone,
        alsoMeasurements,
      });
      if (result.success) {
        onSent();
      } else {
        throw new Error('send failed');
      }
    } catch {
      setErrorMsg(
        'Something went wrong. Your request has been saved — please try again or contact support.',
      );
      setSending(false);
    }
  }

  return (
    <div>
      <h2 className="he-section-heading">Request Your Estimate from Your Adjuster</h2>
      <p className="he-section-intro">
        We&apos;ll send your adjuster a written request for a copy of your insurance estimate
        (scope of loss).
      </p>

      {errorMsg && <div className="he-status error">{errorMsg}</div>}

      <div className="he-form">
        <div>
          <label className="he-field-label" htmlFor="he-adjuster-name">
            Adjuster Name *
          </label>
          <input
            id="he-adjuster-name"
            className="he-input"
            type="text"
            placeholder="Jane Smith"
            value={adjusterName}
            onChange={(e) => setAdjusterName(e.target.value)}
          />
        </div>
        <div>
          <label className="he-field-label" htmlFor="he-adjuster-email">
            Adjuster Email *
          </label>
          <input
            id="he-adjuster-email"
            className="he-input"
            type="email"
            placeholder="adjuster@insurance.com"
            value={adjusterEmail}
            onChange={(e) => setAdjusterEmail(e.target.value)}
          />
        </div>
        <div className="he-form-full">
          <label className="he-field-label" htmlFor="he-adjuster-phone">
            Adjuster Phone (optional)
          </label>
          <input
            id="he-adjuster-phone"
            className="he-input"
            type="tel"
            placeholder="(317) 555-1234"
            value={adjusterPhone}
            onChange={(e) => setAdjusterPhone(e.target.value)}
          />
        </div>
      </div>

      <div className="he-preview">
        <div className="he-preview-header">
          <div className="he-preview-row">
            <span className="he-preview-label">To:</span>
            <span className="he-preview-value">{preview.to}</span>
          </div>
          <div className="he-preview-row">
            <span className="he-preview-label">From:</span>
            <span className="he-preview-value">
              Sent by Otter Quotes at your request &mdash; replies come to {preview.fromName}
            </span>
          </div>
          <div className="he-preview-row">
            <span className="he-preview-label">Subject:</span>
            <span className="he-preview-value">{preview.subject}</span>
          </div>
        </div>
        <div className="he-preview-body">
          <textarea
            className="he-preview-textarea"
            readOnly
            value={preview.body}
            rows={8}
            aria-label="Email preview"
          />
        </div>
      </div>

      <label className="he-checkbox-row">
        <input
          type="checkbox"
          checked={alsoMeasurements}
          onChange={(e) => setAlsoMeasurements(e.target.checked)}
          aria-label="Also request property measurements"
        />
        <span>
          Also request property measurements — check this if you need the adjuster&apos;s
          measurements for your repair estimate.
        </span>
      </label>

      <p className="he-followup">
        After sending, we&apos;ll follow up with a text reminder in 48 hours if you haven&apos;t
        heard back. You can also call your adjuster directly if you prefer.
      </p>

      <div className="he-btn-row">
        <button
          type="button"
          className="he-btn he-btn-amber"
          disabled={!canSend}
          onClick={handleSend}
        >
          {sending ? 'Sending…' : 'Review & Send Email'}
        </button>
        <button type="button" className="he-btn he-btn-outline" onClick={onBack}>
          ← Back
        </button>
      </div>
    </div>
  );
}
