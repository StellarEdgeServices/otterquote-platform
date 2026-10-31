'use client';

/**
 * D-407 2/8 (gh-3283) RCV page -> /insurance-rcv.
 *
 * Where an Insurance + RCV homeowner lands after the routing question (#3282):
 *   1. project information at the top (contact info + timeline + notes),
 *   2. the insurance estimate upload (the existing dashboard uploadClaimDocument:
 *      claim-documents bucket + has_estimate + fire-and-forget parse-loss-sheet),
 *   3. material selection (the existing H8 selection, collected here).
 * No measurements block (D-407). Continue is refused until contact, the estimate
 * and the material selection are all present; then ONE claims write persists
 * everything.
 *
 * Policy answer (D-079, LEGAL-READ finding on #3295): this page NEVER writes
 * policy_type and asserts "Replacement Cost Value" only when the stored answer is
 * 'rcv'. Unsure or missing renders no policy-type assertion (placeholder in
 * copy.ts, pending Ben's ruling).
 *
 * New file; the PAYMENT_DESTINATIONS 'rcv' row in trade-selector/payment-route.ts
 * switches to this route in a follow-up.
 */

import { useRef, useState } from 'react';
import { HomeownerShell } from '../_shell/HomeownerShell';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { uploadClaimDocument } from '../dashboard/actions';
import { ContactProjectCard } from '../_d407/ContactProjectCard';
import { MaterialPicker } from '../_d407/MaterialPicker';
import { D407_CSS } from '../_d407/styles';
import { saveClaim, saveContact, useD407Data, type D407Claim, type D407Profile } from '../_d407/use-d407-claim';
import {
  buildRcvClaimUpdate,
  missingForRcv,
  type ContactInfo,
  type ProjectInfoInput,
} from '../_d407/project-info';
import { initialSelectionState } from '../help-materials/utils';
import type { MaterialSelectionState } from '../help-materials/types';
import * as C from './copy';

export default function InsuranceRcvPage() {
  return (
    <HomeownerShell active="dashboard">
      <InsuranceRcvContent />
    </HomeownerShell>
  );
}

function addressLine(c: {
  property_address?: string | null;
  property_city?: string | null;
  property_state?: string | null;
  property_zip?: string | null;
}): string {
  const street = (c.property_address ?? '').trim();
  if (!street) return '';
  return [street, c.property_city, [c.property_state, c.property_zip].filter(Boolean).join(' ')]
    .filter((p) => p && String(p).trim())
    .join(', ');
}

function InsuranceRcvContent() {
  const { user } = useAuthReady();
  const data = useD407Data(user?.id);

  if (data.loading) {
    return (
      <div className="d407-page" role="status" aria-label="Loading">
        <style>{D407_CSS}</style>
      </div>
    );
  }

  if (data.error || !data.claim || !user) {
    return (
      <div className="d407-page">
        <style>{D407_CSS}</style>
        <p className="d407-error" role="alert">{C.NO_CLAIM_MESSAGE}</p>
      </div>
    );
  }

  return <RcvForm key={data.claim.id} claim={data.claim} profile={data.profile} userId={user.id} email={user.email ?? ''} />;
}

function RcvForm({
  claim,
  profile,
  userId,
  email,
}: {
  claim: D407Claim;
  profile: D407Profile | null;
  userId: string;
  email: string;
}) {
  const [contact, setContact] = useState<ContactInfo>(() => ({
    fullName: (profile?.full_name ?? claim.homeowner_name ?? '').trim(),
    phone: (profile?.phone ?? '').trim(),
    email,
    address: addressLine(claim),
  }));
  const [info, setInfo] = useState<ProjectInfoInput>(() => ({
    urgency:
      claim.urgency === 'flexible' || claim.urgency === '30_days' || claim.urgency === '2_weeks' || claim.urgency === 'asap'
        ? claim.urgency
        : 'flexible',
    urgencyDeadline: '',
    urgencyReason: '',
    notes: '',
  }));
  const [material, setMaterial] = useState<MaterialSelectionState>(initialSelectionState);
  const [hasEstimate, setHasEstimate] = useState(!!claim.has_estimate);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const res = await uploadClaimDocument({
        userId,
        claimId: claim.id,
        file,
        timestamp: Date.now(),
        kind: 'estimate',
      });
      if (res.ok) setHasEstimate(true);
      else setUploadError(C.RCV_ESTIMATE_FAILED);
    } catch {
      setUploadError(C.RCV_ESTIMATE_FAILED);
    } finally {
      setUploading(false);
    }
  }

  async function onContinue() {
    setError(null);
        const gaps = missingForRcv({ contact, hasEstimate, material });
    if (gaps.length > 0) {
      setMissing(gaps.map((g) => C.MISSING_LABELS[g]));
      return;
    }
    setMissing([]);
    setSaving(true);
    try {
      await saveContact(userId, contact.fullName, contact.phone);
      await saveClaim(claim.id, buildRcvClaimUpdate(info, contact.fullName, material, claim.policy_type));
      window.location.assign(new URL('/dashboard', window.location.origin).href);
    } catch (err) {
      console.error('[insurance-rcv] save failed:', err);
      setError(C.RCV_SAVE_FAILED);
      setSaving(false);
    }
  }

  const storedRcv = claim.policy_type === 'rcv';

  return (
    <div className="d407-page">
      <style>{D407_CSS}</style>
      <h1 className="d407-title">{C.RCV_TITLE}</h1>

      {storedRcv ? (
        <div className="d407-banner" data-testid="d407-policy-banner">
          <span>{C.RCV_BANNER}</span>
          <a href={C.RCV_CHANGE_HREF}>{C.RCV_BANNER_CHANGE}</a>
        </div>
      ) : (
        C.POLICY_UNKNOWN_WORDING_PENDING_RULING && (
          <div className="d407-banner" data-testid="d407-policy-pending">
            <span>{C.POLICY_UNKNOWN_WORDING_PENDING_RULING}</span>
          </div>
        )
      )}

      <ContactProjectCard contact={contact} onContact={setContact} info={info} onInfo={setInfo} />

      <div className="d407-card">
        <h2>{C.RCV_ESTIMATE_HEADING}</h2>
        <p className="d407-note">{C.RCV_ESTIMATE_PROMPT}</p>
        {hasEstimate ? (
          <p className="d407-done" data-testid="d407-estimate-done">{C.RCV_ESTIMATE_DONE}</p>
        ) : (
          <>
            <button type="button" className="d407-btn" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? C.RCV_ESTIMATE_UPLOADING : C.RCV_ESTIMATE_BUTTON}
            </button>
            <input ref={fileRef} data-testid="d407-estimate-input" type="file" hidden onChange={onFile} />
          </>
        )}
        {uploadError && <p className="d407-error" role="alert">{uploadError}</p>}
      </div>

      <div className="d407-card">
        <h2>{C.RCV_MATERIAL_HEADING}</h2>
        <MaterialPicker state={material} setState={setMaterial} />
      </div>

      {missing.length > 0 && (
        <div role="alert" data-testid="d407-missing">
          <p className="d407-error">{C.RCV_MISSING_LEAD}</p>
          <ul className="d407-missing">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="d407-error" role="alert">{error}</p>}
      <button type="button" className="d407-btn" data-testid="d407-continue" disabled={saving} onClick={onContinue}>
        {saving ? C.RCV_SUBMITTING : C.RCV_SUBMIT}
      </button>
    </div>
  );
}
