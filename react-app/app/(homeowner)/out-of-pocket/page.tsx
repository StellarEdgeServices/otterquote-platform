'use client';

/**
 * D-407 4/8 (gh-3285) Out-of-pocket route -> /out-of-pocket.
 *
 * Cash/retail homeowners, and ACV homeowners sent on from the ACV explainer
 * (D-346 treats ACV as cash). Collects:
 *   1. project information with contact info (shared _d407 card),
 *   2. a measurement: UPLOAD (existing dashboard uploadClaimDocument, kind
 *      'measurements') OR PURCHASE (link to the existing help-measurements.html
 *      flow, which carries the D-400 price; no price is typed here),
 *   3. material selection (existing H8 selection, shared _d407 picker).
 * Continue is refused until contact, a measurement and the material selection are
 * present, then ONE claims write persists everything. The measurement gate is the
 * claim's has_measurements flag, the same gate the dashboard checklist uses for
 * cash jobs.
 *
 * Classification (D-079 / D-073): a stored ACV answer stays insurance_acv /
 * insurance (D-346 treats ACV as cash, it does not reclassify); retail / cash /
 * null is written only for a homeowner with no stored policy answer. See
 * buildOopClaimUpdate. The page asserts nothing about insurance.
 * New file; the PAYMENT_DESTINATIONS 'oop' row in trade-selector/payment-route.ts
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
  buildOopClaimUpdate,
  missingForOop,
  type ContactInfo,
  type ProjectInfoInput,
} from '../_d407/project-info';
import { initialSelectionState } from '../help-materials/utils';
import type { MaterialSelectionState } from '../help-materials/types';
import * as C from './copy';

export default function OutOfPocketPage() {
  return (
    <HomeownerShell active="dashboard">
      <OutOfPocketContent />
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

function OutOfPocketContent() {
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

  return <OopForm key={data.claim.id} claim={data.claim} profile={data.profile} userId={user.id} email={user.email ?? ''} />;
}

function OopForm({
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
  const [hasMeasurement, setHasMeasurement] = useState(!!claim.has_measurements);
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
        kind: 'measurements',
      });
      if (res.ok) setHasMeasurement(true);
      else setUploadError(C.OOP_UPLOAD_FAILED);
    } catch {
      setUploadError(C.OOP_UPLOAD_FAILED);
    } finally {
      setUploading(false);
    }
  }

  async function onContinue() {
    setError(null);
        const gaps = missingForOop({ contact, hasMeasurement, material });
    if (gaps.length > 0) {
      setMissing(gaps.map((g) => C.MISSING_LABELS[g]));
      return;
    }
    setMissing([]);
    setSaving(true);
    try {
      await saveContact(userId, contact.fullName, contact.phone);
      await saveClaim(claim.id, buildOopClaimUpdate(info, contact.fullName, material, claim.policy_type, claim.funding_type));
      window.location.assign(new URL('/dashboard', window.location.origin).href);
    } catch (err) {
      console.error('[out-of-pocket] save failed:', err);
      setError(C.OOP_SAVE_FAILED);
      setSaving(false);
    }
  }

  const purchaseHref = `${C.MEASUREMENT_PURCHASE_HREF}?claim_id=${encodeURIComponent(claim.id)}`;

  return (
    <div className="d407-page">
      <style>{D407_CSS}</style>
      <h1 className="d407-title">{C.OOP_TITLE}</h1>

      <ContactProjectCard contact={contact} onContact={setContact} info={info} onInfo={setInfo} />

      <div className="d407-card">
        <h2>{C.OOP_MEASUREMENTS_HEADING}</h2>
        <p className="d407-note">{C.OOP_MEASUREMENT_PROMPT}</p>
        {hasMeasurement ? (
          <p className="d407-done" data-testid="d407-measurement-done">{C.OOP_MEASUREMENT_DONE}</p>
        ) : (
          <>
            <button type="button" className="d407-btn" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? C.OOP_UPLOADING : C.OOP_UPLOAD_BUTTON}
            </button>
            <input ref={fileRef} data-testid="d407-measurement-input" type="file" hidden onChange={onFile} />
            {' '}
            <a className="d407-btn d407-btn-link" data-testid="d407-purchase-link" href={purchaseHref}>
              {C.OOP_PURCHASE_LINK}
            </a>
          </>
        )}
        {uploadError && <p className="d407-error" role="alert">{uploadError}</p>}
      </div>

      <div className="d407-card">
        <h2>{C.OOP_MATERIAL_HEADING}</h2>
        <MaterialPicker state={material} setState={setMaterial} />
      </div>

      {missing.length > 0 && (
        <div role="alert" data-testid="d407-missing">
          <p className="d407-error">{C.OOP_MISSING_LEAD}</p>
          <ul className="d407-missing">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="d407-error" role="alert">{error}</p>}
      <button type="button" className="d407-btn" data-testid="d407-continue" disabled={saving} onClick={onContinue}>
        {saving ? C.OOP_SUBMITTING : C.OOP_SUBMIT}
      </button>
    </div>
  );
}
