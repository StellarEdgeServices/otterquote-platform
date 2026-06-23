'use client';

/**
 * Homeowner repair-intake (H9) → /repair-intake — D-211 Phase 24.
 *
 * Behaviour-faithful React port of the static repair-intake.html "Repair
 * Diagnostic" wizard. Reached FROM the dashboard (a sub-flow, not a primary nav
 * tab) — wrapped in the existing HomeownerShell with active="dashboard" (the
 * non-nav value H7/H8 used), so the shell enforces the homeowner gate and adds no
 * new nav entry.
 *
 * Real auth only (DEMO_MODE dropped). NO EF / NO Services — claims (insert +
 * update) and contractors_public (read) go directly through the supabase
 * singleton via use-repair-intake-data, exactly as the static did. Repair cards,
 * dynamic fields, photo thumbnails, and the contractor list all render as JSX,
 * never innerHTML (brief item 5).
 *
 * Static quirks preserved + flagged (see utils.ts / types.ts): roofAge and
 * shinglesCount are collected but not persisted; the INSERT payload carries
 * funding_type:'insurance' + status:'draft'; the UPDATE payload omits them. The
 * unauth redirect is the shell's get-started.html (never /sign-in.html). Per
 * D-220 (Dustin, 2026-06-23) the photo upload uses the RLS-compliant UID-first
 * path; no storage/policy change.
 */

import { useState } from 'react';
import { HomeownerShell, HOMEOWNER_GET_STARTED_URL } from '../_shell/HomeownerShell';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { PhotoUploader } from './components/PhotoUploader';
import { MaterialTiers } from './components/MaterialTiers';
import { ContractorList } from './components/ContractorList';
import {
  SessionExpiredError,
  submitRepairIntake,
  useRepairContractors,
} from './use-repair-intake-data';
import {
  ROOFING_REPAIR_CARDS,
  canSubmit,
  emptyMaterial,
  emptyPhotos,
  getClaimIdFromUrl,
  getPhotoInstructions,
  getTradeFromSession,
  hasMaterialIdentity,
  totalPhotoCount,
  validatePhotoFile,
} from './utils';
import { REPAIR_INTAKE_CSS } from './styles';
import type {
  MaterialIdentity,
  PhotoTier,
  RepairSpecificFields,
  RepairType,
  SelectedPhoto,
  Trade,
  UploadedPhotos,
} from './types';

const DESCRIBE_TRADES = ['siding', 'gutters', 'windows'];

export default function RepairIntakePage() {
  return (
    <HomeownerShell active="dashboard">
      <RepairIntakeContent />
    </HomeownerShell>
  );
}

function RepairIntakeContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? '';

  // Trade + claim id resolved once from the upstream session/URL (static parity;
  // null trade falls back to roofing for both render and payload).
  const [trade] = useState<Trade>(() => getTradeFromSession() ?? 'roofing');
  const roofing = trade === 'roofing';
  const describeTrade = DESCRIBE_TRADES.includes(trade);
  const [claimId] = useState<string | null>(() => {
    const fromUrl = getClaimIdFromUrl();
    if (fromUrl) return fromUrl;
    if (typeof window !== 'undefined') return window.sessionStorage.getItem('oq_claim_id');
    return null;
  });

  const [repairType, setRepairType] = useState<RepairType | null>(
    describeTrade ? 'describe' : null,
  );
  const [photos, setPhotos] = useState<UploadedPhotos>(emptyPhotos);
  const [photoErrors, setPhotoErrors] = useState<Record<PhotoTier, string[]>>({
    main: [],
    tier1: [],
    tier2: [],
    tier3: [],
    tier4: [],
  });
  const [material, setMaterial] = useState<MaterialIdentity>(emptyMaterial);
  const [fields, setFields] = useState<RepairSpecificFields>({
    roofAge: '',
    shinglesCount: '',
    issueDescription: '',
    otherDescription: '',
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const photoCount = totalPhotoCount(photos);
  const submitReady = canSubmit(repairType, photoCount);

  // Contractors load only once submitted (mirrors the static post-submit reveal).
  const {
    contractors,
    loading: contractorsLoading,
    error: contractorsError,
  } = useRepairContractors(trade, submitted);

  // ── Photo add/remove (validation + FileReader previews) ───────────────────
  function addFiles(tier: PhotoTier, fileList: FileList) {
    const accepted: SelectedPhoto[] = [];
    const errs: string[] = [];
    Array.from(fileList).forEach((file) => {
      const v = validatePhotoFile(file, tier);
      if (!v.ok) {
        errs.push(v.error!);
        return;
      }
      const id = `${tier}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const isImage = file.type.startsWith('image/');
      accepted.push({ id, file, previewUrl: null, isImage });
      if (isImage && typeof FileReader !== 'undefined') {
        const reader = new FileReader();
        reader.onload = (e) => {
          const url = typeof e.target?.result === 'string' ? e.target.result : null;
          setPhotos((prev) => ({
            ...prev,
            [tier]: prev[tier].map((p) => (p.id === id ? { ...p, previewUrl: url } : p)),
          }));
        };
        reader.readAsDataURL(file);
      }
    });
    if (accepted.length) {
      setPhotos((prev) => ({ ...prev, [tier]: [...prev[tier], ...accepted] }));
    }
    setPhotoErrors((prev) => ({ ...prev, [tier]: errs }));
  }

  function removePhoto(tier: PhotoTier, id: string) {
    setPhotos((prev) => ({ ...prev, [tier]: prev[tier].filter((p) => p.id !== id) }));
  }

  function changeMaterial(field: keyof MaterialIdentity, value: string) {
    setMaterial((prev) => ({ ...prev, [field]: value }));
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    setSubmitError(null);
    if (!submitReady || !repairType) return;
    setSubmitting(true);

    const allPhotos = (Object.keys(photos) as PhotoTier[]).flatMap((tier) =>
      photos[tier].map((p) => ({ tier, file: p.file })),
    );
    const notes =
      fields.issueDescription.trim() || fields.otherDescription.trim() || null;

    try {
      const res = await submitRepairIntake({
        userId,
        claimId,
        trade,
        repairType,
        material,
        notes,
        photos: allPhotos,
      });
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem('oq_claim_id', res.claimId);
      }
      setSubmitted(true);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        window.location.href = HOMEOWNER_GET_STARTED_URL;
        return;
      }
      setSubmitError('Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  const instructions = getPhotoInstructions(repairType);

  return (
    <div className="ri-wrap">
      <style>{REPAIR_INTAKE_CSS}</style>

      {/* Disclaimer banner */}
      <div className="ri-disclaimer">
        <h2>
          <span className="ri-otter" aria-hidden="true">
            🦦
          </span>
          THIS IS NOT OUR SPECIALTY, BUT WE WILL TRY OUR BEST TO HELP
        </h2>
        <p className="ri-sub">
          We&apos;re a little out of our otter element here, but we&apos;ll do our
          best to help you navigate these waters.
        </p>
        <p>
          Diagnosing a repair remotely is much more difficult than a full
          replacement. But the more information you can provide upfront, the cheaper
          this job will be — you&apos;re eliminating the contractor&apos;s biggest
          cost driver: the diagnostic legwork.
        </p>
      </div>

      {/* Repair-type selector */}
      <div className="ri-section">
        <h2>What&apos;s the Issue? 🔧</h2>
        <p className="ri-subtitle">
          {describeTrade ? `Tell us about your ${trade} issue` : 'Select the type of repair you need'}
        </p>

        {roofing && (
          <div className="ri-cards">
            {ROOFING_REPAIR_CARDS.map((card) => (
              <button
                type="button"
                key={card.type}
                className={'ri-card' + (repairType === card.type ? ' selected' : '')}
                aria-pressed={repairType === card.type}
                onClick={() => setRepairType(card.type)}
              >
                <span className="ri-icon" aria-hidden="true">
                  {card.icon}
                </span>
                <span className="ri-card-title">{card.title}</span>
                <span className="ri-card-desc">{card.description}</span>
              </button>
            ))}
          </div>
        )}

        {describeTrade && (
          <textarea
            className="ri-textarea"
            placeholder="Please describe the issue in detail..."
            value={fields.otherDescription}
            onChange={(e) => setFields((f) => ({ ...f, otherDescription: e.target.value }))}
          />
        )}
      </div>

      {/* Photo section (after a repair type is chosen) */}
      {repairType && (
        <div className="ri-section">
          <h2>📸 Photos Help Contractors Estimate Accurately</h2>

          {instructions.length > 0 && (
            <div className="ri-instructions">
              {instructions.map((text, i) => (
                <div className="ri-instruction" key={i}>
                  {text}
                </div>
              ))}
            </div>
          )}

          <PhotoUploader
            tier="main"
            primaryText="Tap to take a photo or choose a file"
            hintText="Images up to 10MB each"
            photos={photos.main}
            errors={photoErrors.main}
            onFiles={(files) => addFiles('main', files)}
            onRemove={(id) => removePhoto('main', id)}
          />

          {/* Repair-type-specific dynamic fields */}
          {repairType === 'leak' && (
            <div>
              <label className="ri-field-label" htmlFor="ri-roof-age">
                <strong>How old is your roof? (approximate)</strong>
              </label>
              <input
                id="ri-roof-age"
                className="ri-input"
                type="text"
                placeholder="e.g., 15 years old"
                value={fields.roofAge}
                onChange={(e) => setFields((f) => ({ ...f, roofAge: e.target.value }))}
              />
            </div>
          )}
          {repairType === 'shingles' && (
            <div>
              <label className="ri-field-label" htmlFor="ri-shingles-count">
                <strong>Approximately how many shingles are missing?</strong>
              </label>
              <input
                id="ri-shingles-count"
                className="ri-input"
                type="number"
                min={0}
                placeholder="0"
                value={fields.shinglesCount}
                onChange={(e) =>
                  setFields((f) => ({ ...f, shinglesCount: e.target.value }))
                }
              />
            </div>
          )}
          {repairType === 'other' && (
            <div>
              <label className="ri-field-label" htmlFor="ri-issue-description">
                <strong>Please describe what&apos;s happening:</strong>
              </label>
              <textarea
                id="ri-issue-description"
                className="ri-textarea"
                placeholder="Describe the issue in detail..."
                value={fields.issueDescription}
                onChange={(e) =>
                  setFields((f) => ({ ...f, issueDescription: e.target.value }))
                }
              />
            </div>
          )}
        </div>
      )}

      {/* Material identification (roofing only, after a repair type is chosen) */}
      {roofing && repairType && (
        <MaterialTiers
          material={material}
          onMaterialChange={changeMaterial}
          photos={{
            tier1: photos.tier1,
            tier2: photos.tier2,
            tier3: photos.tier3,
            tier4: photos.tier4,
          }}
          errors={{
            tier1: photoErrors.tier1,
            tier2: photoErrors.tier2,
            tier3: photoErrors.tier3,
            tier4: photoErrors.tier4,
          }}
          onFiles={addFiles}
          onRemove={removePhoto}
        />
      )}

      {/* Contractors available for repairs (after submission) */}
      {submitted && (
        <div className="ri-section">
          <h2>🔨 Contractors Available for Repairs</h2>
          <p className="ri-subtitle">
            These contractors have opted into repair work and will receive your
            project details.
          </p>
          <ContractorList
            contractors={contractors}
            loading={contractorsLoading}
            error={contractorsError}
          />
        </div>
      )}

      {/* Submit */}
      <div className="ri-section">
        <h2>Ready to Submit? 🚀</h2>
        {submitError && (
          <div className="ri-submit-error" role="alert">
            {submitError}
          </div>
        )}
        <div className="ri-summary">
          <div className="ri-summary-item">
            <span className="ri-sum-label">Repair Type:</span>
            <span className="ri-sum-value">{repairType ?? 'Not selected'}</span>
          </div>
          <div className="ri-summary-item">
            <span className="ri-sum-label">Photos Uploaded:</span>
            <span className="ri-sum-value">{photoCount}</span>
          </div>
          {roofing && (
            <div
              className={
                'ri-summary-item' + (hasMaterialIdentity(material) ? ' complete' : '')
              }
            >
              <span className="ri-sum-label">Material Information:</span>
              <span className="ri-sum-value">
                {hasMaterialIdentity(material) ? '✓ Provided' : 'Not required'}
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          className="ri-btn ri-btn-primary"
          disabled={!submitReady || submitting}
          onClick={handleSubmit}
        >
          {submitted
            ? '✓ Submitted!'
            : submitting
              ? 'Submitting…'
              : '✓ Submit for Contractor Review'}
        </button>
      </div>
    </div>
  );
}
