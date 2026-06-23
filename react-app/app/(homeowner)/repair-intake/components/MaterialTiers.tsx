'use client';

/**
 * Roofing material-identification accordions (H9) — Tiers 1-4. Shown only when
 * the trade is roofing and a repair type is selected.
 *
 *   • Tier 1 — paperwork checklist + image/PDF upload + brand/product/color.
 *   • Tier 2 — leftover bundle-label photo + brand/product/color.
 *   • Tier 3 — AI Photo Identification: COMING SOON STUB. Display-only, the
 *     action button is permanently disabled; NO AI integration (brief exclusion).
 *   • Tier 4 — ITEL Lab Analysis: photo upload + mailing address + a request
 *     button that records a local "noted" acknowledgement only. NO payment, NO
 *     Stripe, NO functions.invoke (faithful to the static's alert-only stub).
 *
 * brand/product/color render under BOTH Tier 1 and Tier 2 but edit ONE shared
 * material identity (see types.ts — corrects the static's Tier-1-only read).
 */

import { useState } from 'react';
import type { MaterialIdentity, PhotoTier, SelectedPhoto } from '../types';
import { PhotoUploader } from './PhotoUploader';

type MaterialField = keyof MaterialIdentity;

interface MaterialTiersProps {
  material: MaterialIdentity;
  onMaterialChange: (field: MaterialField, value: string) => void;
  photos: Record<'tier1' | 'tier2' | 'tier3' | 'tier4', SelectedPhoto[]>;
  errors: Record<'tier1' | 'tier2' | 'tier3' | 'tier4', string[]>;
  onFiles: (tier: PhotoTier, files: FileList) => void;
  onRemove: (tier: PhotoTier, id: string) => void;
}

const CHECKLIST = [
  "Prior roofer's invoice",
  'Warranty registration',
  'Proposal/contract',
  'Permit records',
];

function MaterialFields({
  material,
  onMaterialChange,
  idPrefix,
}: {
  material: MaterialIdentity;
  onMaterialChange: (field: MaterialField, value: string) => void;
  idPrefix: string;
}) {
  return (
    <div className="ri-mat-fields">
      <div>
        <label className="ri-field-label" htmlFor={`${idPrefix}-brand`}>
          Brand
        </label>
        <input
          id={`${idPrefix}-brand`}
          className="ri-input"
          type="text"
          placeholder="e.g., GAF, Owens Corning"
          value={material.brand}
          onChange={(e) => onMaterialChange('brand', e.target.value)}
        />
      </div>
      <div>
        <label className="ri-field-label" htmlFor={`${idPrefix}-product`}>
          Product Line
        </label>
        <input
          id={`${idPrefix}-product`}
          className="ri-input"
          type="text"
          placeholder="e.g., Timberline, Duration"
          value={material.product}
          onChange={(e) => onMaterialChange('product', e.target.value)}
        />
      </div>
      <div>
        <label className="ri-field-label" htmlFor={`${idPrefix}-color`}>
          Color
        </label>
        <input
          id={`${idPrefix}-color`}
          className="ri-input"
          type="text"
          placeholder="e.g., Weathered Wood"
          value={material.color}
          onChange={(e) => onMaterialChange('color', e.target.value)}
        />
      </div>
    </div>
  );
}

export function MaterialTiers({
  material,
  onMaterialChange,
  photos,
  errors,
  onFiles,
  onRemove,
}: MaterialTiersProps) {
  // Single-open accordion; Tier 1 starts open (mirrors the static markup).
  const [open, setOpen] = useState<'tier1' | 'tier2' | 'tier3' | 'tier4'>('tier1');
  const [itelNoted, setItelNoted] = useState(false);

  function toggle(tier: 'tier1' | 'tier2' | 'tier3' | 'tier4') {
    setOpen((cur) => (cur === tier ? ('' as never) : tier));
  }

  return (
    <div className="ri-section">
      <h2>🏠 What&apos;s Currently on Your Roof?</h2>
      <p className="ri-subtitle">
        Matching your existing materials is critical for repairs. We need to know
        exactly what&apos;s up there.
      </p>

      {/* Tier 1 — Paperwork */}
      <div className="ri-accordion">
        <button
          type="button"
          className={'ri-acc-header' + (open === 'tier1' ? ' open' : '')}
          aria-expanded={open === 'tier1'}
          onClick={() => toggle('tier1')}
        >
          <span>📋 Tier 1: Check Your Paperwork (Free)</span>
          <span className="ri-acc-toggle" aria-hidden="true">
            ▼
          </span>
        </button>
        {open === 'tier1' && (
          <div className="ri-acc-content">
            <p>Check for any of these documents from your original roof installation:</p>
            <div className="ri-checklist">
              {CHECKLIST.map((label) => (
                <label className="ri-check-item" key={label}>
                  <input type="checkbox" /> {label}
                </label>
              ))}
            </div>
            <p>
              <strong>Upload any documents you found:</strong>
            </p>
            <PhotoUploader
              tier="tier1"
              emoji="📄"
              primaryText="Tap to upload documents"
              photos={photos.tier1}
              errors={errors.tier1}
              onFiles={(files) => onFiles('tier1', files)}
              onRemove={(id) => onRemove('tier1', id)}
            />
            <MaterialFields
              material={material}
              onMaterialChange={onMaterialChange}
              idPrefix="ri-t1"
            />
          </div>
        )}
      </div>

      {/* Tier 2 — Leftover materials */}
      <div className="ri-accordion">
        <button
          type="button"
          className={'ri-acc-header' + (open === 'tier2' ? ' open' : '')}
          aria-expanded={open === 'tier2'}
          onClick={() => toggle('tier2')}
        >
          <span>🏚️ Tier 2: Check for Leftover Materials (Free)</span>
          <span className="ri-acc-toggle" aria-hidden="true">
            ▼
          </span>
        </button>
        {open === 'tier2' && (
          <div className="ri-acc-content">
            <p>
              Many homeowners have leftover shingles stored in their garage, attic,
              or shed.
            </p>
            <p>
              Look for the bundle wrapper — it has the brand, product name, and color
              printed on it.
            </p>
            <p>
              <strong>Upload a photo of the bundle wrapper label:</strong>
            </p>
            <PhotoUploader
              tier="tier2"
              emoji="📸"
              primaryText="Tap to take a photo or choose from gallery"
              photos={photos.tier2}
              errors={errors.tier2}
              onFiles={(files) => onFiles('tier2', files)}
              onRemove={(id) => onRemove('tier2', id)}
            />
            <MaterialFields
              material={material}
              onMaterialChange={onMaterialChange}
              idPrefix="ri-t2"
            />
          </div>
        )}
      </div>

      {/* Tier 3 — AI Photo Identification (COMING SOON STUB) */}
      <div className="ri-accordion">
        <button
          type="button"
          className={'ri-acc-header' + (open === 'tier3' ? ' open' : '')}
          aria-expanded={open === 'tier3'}
          onClick={() => toggle('tier3')}
        >
          <span>
            🤖 Tier 3: AI Photo Identification
            <span className="ri-tier-price">Coming Soon</span>
          </span>
          <span className="ri-acc-toggle" aria-hidden="true">
            ▼
          </span>
        </button>
        {open === 'tier3' && (
          <div className="ri-acc-content">
            <p>
              Our AI tool will identify your shingle from photos in seconds using
              RoofPair and SAIGE AI — 90-97% accuracy, including color matching.
            </p>
            <p>
              Take 7-8 clear photos from multiple angles — front texture, granule
              pattern, and the back of a shingle if accessible.
            </p>
            <div className="ri-coming-soon">
              <strong>⚙️ AI integration coming soon.</strong> While we finish
              building this, use Tier 1, Tier 2, or Tier 4 to identify your material.
            </div>
            <PhotoUploader
              tier="tier3"
              emoji="📸"
              primaryText="Upload photos now — we’ll run AI analysis when available"
              photos={photos.tier3}
              errors={errors.tier3}
              onFiles={(files) => onFiles('tier3', files)}
              onRemove={(id) => onRemove('tier3', id)}
            />
            <button
              type="button"
              className="ri-btn ri-btn-primary"
              disabled
              aria-disabled="true"
            >
              🤖 AI Identification — Coming Soon
            </button>
          </div>
        )}
      </div>

      {/* Tier 4 — ITEL Lab Analysis */}
      <div className="ri-accordion">
        <button
          type="button"
          className={'ri-acc-header' + (open === 'tier4' ? ' open' : '')}
          aria-expanded={open === 'tier4'}
          onClick={() => toggle('tier4')}
        >
          <span>
            🔬 Tier 4: ITEL Lab Analysis
            <span className="ri-tier-price">$75-100</span>
          </span>
          <span className="ri-acc-toggle" aria-hidden="true">
            ▼
          </span>
        </button>
        {open === 'tier4' && (
          <div className="ri-acc-content">
            <p>
              For discontinued or hard-to-identify materials, our lab partner ITEL
              can identify from photos or physical samples.
            </p>
            <p>
              ITEL covers 170+ manufacturers and 35,000+ products — including
              discontinued materials.
            </p>
            <p>They can even source and ship discontinued shingles directly to your job site.</p>
            <div className="ri-coming-soon">
              <strong>💰 Starting at $75</strong> — refunded if you use an Otter
              Quotes contractor
            </div>
            <p>
              <strong>Choose your method:</strong>
            </p>
            <p>Option 1: Submit photos</p>
            <PhotoUploader
              tier="tier4"
              emoji="📸"
              primaryText="Tap to take a photo or choose from gallery"
              photos={photos.tier4}
              errors={errors.tier4}
              onFiles={(files) => onFiles('tier4', files)}
              onRemove={(id) => onRemove('tier4', id)}
            />
            <p>Option 2: Mail a sample</p>
            <div className="ri-itel-address">
              <p style={{ margin: 0 }}>ITEL Sample Mailing Address:</p>
              <p style={{ margin: '0.5rem 0 0' }}>
                ITEL Labs
                <br />
                7 Westport Court
                <br />
                Bloomington, IL 61704
                <br />
                Phone: (800) 783-4835
              </p>
              <p style={{ margin: '0.5rem 0 0' }}>
                Mail 2–3 individual shingles. Include your name and claim number in
                the package.
              </p>
            </div>
            {itelNoted ? (
              <div className="ri-itel-note" role="status">
                ✓ ITEL analysis request noted. Our team will follow up with payment
                and lab-portal details.
              </div>
            ) : (
              <button
                type="button"
                className="ri-btn ri-btn-primary"
                onClick={() => setItelNoted(true)}
              >
                🔬 Request ITEL Analysis ($75)
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
