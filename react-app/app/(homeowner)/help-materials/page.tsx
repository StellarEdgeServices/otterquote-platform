'use client';

/**
 * Homeowner help-materials (H8) → /help-materials — D-211 Phase 23.
 *
 * Behaviour-faithful React port of the static help-materials.html "Help Me
 * Decide: choose your roofing material" wizard. Reached FROM the dashboard (a
 * sub-flow, not a primary nav tab) — wrapped in the existing HomeownerShell with
 * active="dashboard" (the non-nav value H7 used), so the shell enforces the
 * homeowner gate and adds no new nav entry.
 *
 * Demo mode is dropped entirely (real auth only, matching H1/H2/H7). No EF / no
 * Services — material_catalog + claims are read, and claims is written, directly
 * through the supabase singleton. The designer-product grid is rendered as JSX,
 * never innerHTML (brief item 4). All written value strings are preserved
 * verbatim (impact_class inconsistency flagged, not normalized — brief item 5).
 */

import { useState } from 'react';
import { HomeownerShell } from '../_shell/HomeownerShell';
import { useAuthReady } from '@/hooks/use-auth-ready';
import {
  useCurrentClaimId,
  useDesignerProducts,
  saveMaterialSelection,
} from './use-help-materials-data';
import {
  buildClaimMaterialUpdate,
  confirmSummary,
  currentStep,
  initialSelectionState,
  isConfirmReady,
  pricingRows,
} from './utils';
import { HELP_MATERIALS_CSS } from './styles';
import { DesignerProductGrid } from './components/DesignerProductGrid';
import type {
  MaterialCatalogRow,
  MaterialSelectionState,
  MetalMaterial,
  MetalType,
  ShingleType,
} from './types';

const NO_CLAIM_MESSAGE =
  'Could not find your project record. Please return to the dashboard and try again.';

const PROGRESS_LABELS = ['Category', 'Type', 'Details', 'Confirm'];

export default function HelpMaterialsPage() {
  return (
    <HomeownerShell active="dashboard">
      <HelpMaterialsContent />
    </HomeownerShell>
  );
}

function HelpMaterialsContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? '';

  const { claimId, loading: claimLoading, error: claimError } = useCurrentClaimId(userId);

  const [state, setState] = useState<MaterialSelectionState>(initialSelectionState);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Designer products load lazily, only once the Designer path is chosen.
  const designerEnabled = state.category === 'shingles' && state.shingleType === 'designer';
  const {
    products: designerProducts,
    loading: designerLoading,
    error: designerError,
  } = useDesignerProducts(designerEnabled);

  const ready = isConfirmReady(state);
  const step = currentStep(state);
  const noClaim = !claimLoading && !claimError && !claimId;

  // ── Selection handlers (mirror the static select* functions) ──────────────
  function selectCategory(category: 'shingles' | 'metal') {
    setState({ ...initialSelectionState(), category });
  }

  function selectShingleType(shingleType: ShingleType) {
    setState((s) => ({
      ...s,
      shingleType,
      // Reset downstream leaf state when re-picking a type.
      impactClass: null,
      designerProduct: null,
      designerManufacturer: null,
      designerCatalogId: null,
    }));
  }

  function selectMetalType(metalType: MetalType) {
    setState((s) => ({ ...s, metalType, metalMaterial: null }));
  }

  function selectImpactClass(impactClass: string) {
    setState((s) => ({ ...s, impactClass }));
  }

  function selectMetalMaterial(metalMaterial: MetalMaterial) {
    setState((s) => ({ ...s, metalMaterial }));
  }

  function selectDesignerProduct(product: MaterialCatalogRow) {
    setState((s) => ({
      ...s,
      designerProduct: product.product_name ?? null,
      designerManufacturer: product.manufacturer ?? null,
      designerCatalogId: product.id,
      // Auto-set impact class straight from the product (preserve 'class3'/'class4').
      impactClass: (product.impact_class as string) ?? 'none',
    }));
  }

  // ── Confirm (single claims write, no EF) ──────────────────────────────────
  async function handleConfirm() {
    setSubmitError(null);
    if (!claimId) {
      setSubmitError(NO_CLAIM_MESSAGE);
      return;
    }
    setSubmitting(true);
    try {
      await saveMaterialSelection(claimId, buildClaimMaterialUpdate(state));
      setSaved(true);
      // Mirror the static success affordance — land on the React dashboard.
      window.location.href = '/dashboard';
    } catch {
      setSubmitError('Error saving selection. Please try again.');
      setSubmitting(false);
    }
  }

  if (claimLoading) {
    return (
      <div className="oqh-mat">
        <style>{HELP_MATERIALS_CSS}</style>
        <div className="hm-spinner" role="status" aria-label="Loading">
          <div className="hm-spinner-ring" />
        </div>
      </div>
    );
  }

  if (saved) {
    return (
      <div className="oqh-mat">
        <style>{HELP_MATERIALS_CSS}</style>
        <div className="hm-success">
          <span className="hm-success-icon" aria-hidden="true">
            ✓
          </span>
          <h2>Material Selection Saved</h2>
          <p>
            Your roofing material selection has been saved to your project.
            Contractors will use it to provide accurate bids.
          </p>
          <a href="/dashboard" className="hm-success-link">
            Return to Dashboard
          </a>
        </div>
      </div>
    );
  }

  const summary = ready ? confirmSummary(state) : null;
  const prices = ready ? pricingRows(state) : [];

  return (
    <div className="oqh-mat">
      <style>{HELP_MATERIALS_CSS}</style>

      <div className="hm-header">
        <a href="/dashboard" className="hm-back">
          ← Back to Dashboard
        </a>
        <h1 className="hm-title">Material Selection</h1>
        <p className="hm-subtitle">Help Me Decide: Choose your roofing material</p>
      </div>

      {(claimError || noClaim) && (
        <div className="hm-status error" role="alert">
          {NO_CLAIM_MESSAGE}
        </div>
      )}
      {submitError && (
        <div className="hm-status error" role="alert">
          {submitError}
        </div>
      )}

      {/* Progress indicator */}
      <div className="hm-progress" aria-hidden="true">
        {PROGRESS_LABELS.map((label, idx) => {
          const n = idx + 1;
          const cls = n === step ? ' active' : n < step ? ' done' : '';
          return (
            <div className={'hm-step' + cls} key={label}>
              <div className="hm-step-circle">{n}</div>
              <div className="hm-step-label">{label}</div>
            </div>
          );
        })}
      </div>

      {/* Step 1: Category */}
      {!state.category && (
        <div className="hm-section">
          <h2 className="hm-section-heading">
            What type of roofing material interests you?
          </h2>
          <p className="hm-section-desc">
            Choose between shingles (most common) or metal roofing.
          </p>
          <div className="hm-cards">
            <button
              type="button"
              className="hm-card"
              onClick={() => selectCategory('shingles')}
            >
              <div className="hm-card-head">
                <span className="hm-card-title">Shingles</span>
              </div>
              <span className="hm-card-desc">
                The most popular choice. Easier installation, good durability, and
                widely supported by insurance policies.
              </span>
            </button>
            <button
              type="button"
              className="hm-card"
              onClick={() => selectCategory('metal')}
            >
              <div className="hm-card-head">
                <span className="hm-card-title">Metal Roofing</span>
              </div>
              <span className="hm-card-desc">
                Premium durability with 40+ year lifespan. Higher upfront cost but
                long-term value. Multiple styles available.
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Shingle type */}
      {state.category === 'shingles' && !state.shingleType && (
        <div className="hm-section">
          <h2 className="hm-section-heading">Which shingle type works for you?</h2>
          <p className="hm-section-desc">
            Select your preferred style and durability level.
          </p>
          <div className="hm-cards">
            <button
              type="button"
              className="hm-card"
              onClick={() => selectShingleType('architectural')}
            >
              <div className="hm-card-head">
                <span className="hm-card-title">Architectural Shingle</span>
                <span className="hm-badge">Most Popular</span>
              </div>
              <span className="hm-card-desc">
                The most popular choice. Dimensional look, 130+ mph wind rating.
                Included in most insurance claims at no additional cost.
              </span>
            </button>
            <button
              type="button"
              className="hm-card"
              onClick={() => selectShingleType('designer')}
            >
              <div className="hm-card-head">
                <span className="hm-card-title">Designer Shingle</span>
                <span className="hm-badge premium">Premium Upgrade</span>
              </div>
              <span className="hm-card-desc">
                Premium appearance mimicking slate, cedar, or tile. Expect to pay
                the difference out of pocket.
              </span>
            </button>
            <button
              type="button"
              className="hm-card"
              onClick={() => selectShingleType('3-tab')}
            >
              <div className="hm-card-head">
                <span className="hm-card-title">3-Tab Shingle</span>
                <span className="hm-badge basic">Basic</span>
              </div>
              <span className="hm-card-desc">
                Basic, flat appearance. Rarely used on new installations.
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Metal type */}
      {state.category === 'metal' && !state.metalType && (
        <div className="hm-section">
          <h2 className="hm-section-heading">
            Which metal roofing style interests you?
          </h2>
          <p className="hm-section-desc">
            Choose between premium standing seam or budget-friendly exposed fastener.
          </p>
          <div className="hm-cards">
            <button
              type="button"
              className="hm-card"
              onClick={() => selectMetalType('standing-seam')}
            >
              <div className="hm-card-head">
                <span className="hm-card-title">Standing Seam</span>
                <span className="hm-badge premium">Premium</span>
              </div>
              <span className="hm-card-desc">
                Premium concealed-fastener metal roof. 40+ year lifespan.
                Significant upgrade cost.
              </span>
              <span className="hm-card-details">24-gauge steel standard</span>
            </button>
            <button
              type="button"
              className="hm-card"
              onClick={() => selectMetalType('exposed-fastener')}
            >
              <div className="hm-card-head">
                <span className="hm-card-title">Exposed Fastener</span>
                <span className="hm-badge basic">Budget Metal</span>
              </div>
              <span className="hm-card-desc">
                Budget metal option with visible fasteners. Typically used on
                outbuildings but available for homes.
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Impact class (architectural) */}
      {state.category === 'shingles' && state.shingleType === 'architectural' && (
        <div className="hm-options">
          <h3 className="hm-options-title">
            Step 3: Select Impact Class (Hail Resistance)
          </h3>
          <div className="hm-options-grid">
            <button
              type="button"
              className={'hm-option' + (state.impactClass === 'none' ? ' selected' : '')}
              aria-pressed={state.impactClass === 'none'}
              onClick={() => selectImpactClass('none')}
            >
              <div className="hm-option-label">None</div>
              <div className="hm-option-desc">Standard hail resistance</div>
            </button>
            <button
              type="button"
              className={'hm-option' + (state.impactClass === 'class-3' ? ' selected' : '')}
              aria-pressed={state.impactClass === 'class-3'}
              onClick={() => selectImpactClass('class-3')}
            >
              <div className="hm-option-label">Class 3</div>
              <div className="hm-option-desc">
                Enhanced hail protection. Withstands 1.75-inch steel ball impact.
              </div>
            </button>
            <button
              type="button"
              className={'hm-option' + (state.impactClass === 'class-4' ? ' selected' : '')}
              aria-pressed={state.impactClass === 'class-4'}
              onClick={() => selectImpactClass('class-4')}
            >
              <div className="hm-option-label">Class 4</div>
              <div className="hm-option-desc">
                Maximum hail protection with SBS polymer-modified asphalt.
                Withstands 2-inch impact. Often qualifies for insurance premium
                discounts.
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Step 3b: Designer product selection */}
      {state.category === 'shingles' && state.shingleType === 'designer' && (
        <div className="hm-section">
          <h2 className="hm-section-heading">Choose Your Designer Shingle</h2>
          <p className="hm-section-desc">
            Select the specific product you want. Contractors need this to provide
            accurate bids. Click &quot;View Colors&quot; to see options on the
            manufacturer&apos;s site.
          </p>
          <DesignerProductGrid
            products={designerProducts}
            loading={designerLoading}
            error={designerError}
            selectedId={state.designerCatalogId}
            onSelect={selectDesignerProduct}
          />
        </div>
      )}

      {/* Step 3: Metal material */}
      {state.category === 'metal' && state.metalType && (
        <div className="hm-options">
          <h3 className="hm-options-title">Step 3: Select Metal Material</h3>
          <div className="hm-options-grid">
            <button
              type="button"
              className={'hm-option' + (state.metalMaterial === 'steel' ? ' selected' : '')}
              aria-pressed={state.metalMaterial === 'steel'}
              onClick={() => selectMetalMaterial('steel')}
            >
              <div className="hm-option-label">Steel (Galvalume)</div>
              <div className="hm-option-desc">
                Standard for residential. Durable, cost-effective.
              </div>
            </button>
            <button
              type="button"
              className={'hm-option' + (state.metalMaterial === 'aluminum' ? ' selected' : '')}
              aria-pressed={state.metalMaterial === 'aluminum'}
              onClick={() => selectMetalMaterial('aluminum')}
            >
              <div className="hm-option-label">Aluminum</div>
              <div className="hm-option-desc">
                Lightweight, corrosion-resistant. Best for coastal or high-moisture
                areas.
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Pricing guidance */}
      {ready && prices.length > 0 && (
        <div className="hm-pricing">
          <div className="hm-pricing-title">Relative Pricing Guidance</div>
          <div className="hm-pricing-items">
            {prices.map((row) => (
              <div className="hm-pricing-item" key={row.key}>
                <span className="hm-pricing-name">{row.name}</span>
                <span className="hm-pricing-value">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirmation */}
      {ready && summary && (
        <div className="hm-confirm">
          <h3 className="hm-confirm-title">Review Your Selection</h3>
          <div className="hm-confirm-summary">
            <div className="hm-confirm-row">
              <span className="hm-confirm-label">Category:</span>
              <span className="hm-confirm-value">{summary.category}</span>
            </div>
            <div className="hm-confirm-row">
              <span className="hm-confirm-label">Type:</span>
              <span className="hm-confirm-value">{summary.type}</span>
            </div>
            {summary.details && (
              <div className="hm-confirm-row">
                <span className="hm-confirm-label">Details:</span>
                <span className="hm-confirm-value">{summary.details}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            className="hm-confirm-btn"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? 'Saving…' : 'Confirm My Selection'}
          </button>
        </div>
      )}
    </div>
  );
}
