'use client';

/**
 * D-407 material selection (gh-3283 RCV page, gh-3285 Out-of-pocket). Byte-identical
 * in both PRs.
 *
 * The same branching selection as /help-materials (H8): the step markup and every
 * string below are copied from help-materials/page.tsx on main, and the state,
 * validity (isConfirmReady), summary (confirmSummary) and the claims payload
 * (buildClaimMaterialUpdate) are the existing help-materials/utils.ts functions.
 * Unlike H8 this component only collects the choice; the hosting page saves it
 * together with the rest of the page in one claims write.
 */

import type { Dispatch, SetStateAction } from 'react';
import { HELP_MATERIALS_CSS } from '../help-materials/styles';
import { DesignerProductGrid } from '../help-materials/components/DesignerProductGrid';
import { useDesignerProducts } from '../help-materials/use-help-materials-data';
import { confirmSummary, initialSelectionState, isConfirmReady } from '../help-materials/utils';
import type {
  MaterialCatalogRow,
  MaterialSelectionState,
  MetalMaterial,
  MetalType,
  ShingleType,
} from '../help-materials/types';

interface Props {
  state: MaterialSelectionState;
  setState: Dispatch<SetStateAction<MaterialSelectionState>>;
}

export function MaterialPicker({ state, setState }: Props) {
  const designerEnabled = state.category === 'shingles' && state.shingleType === 'designer';
  const {
    products: designerProducts,
    loading: designerLoading,
    error: designerError,
  } = useDesignerProducts(designerEnabled);

  function selectCategory(category: 'shingles' | 'metal') {
    setState({ ...initialSelectionState(), category });
  }
  function selectShingleType(shingleType: ShingleType) {
    setState((s) => ({
      ...s,
      shingleType,
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
      impactClass: (product.impact_class as string) ?? 'none',
    }));
  }

  const summary = isConfirmReady(state) ? confirmSummary(state) : null;

  return (
    <div className="d407-mat" data-testid="d407-material-picker">
      <style>{HELP_MATERIALS_CSS}</style>
      <div className="oqh-mat">
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

      {summary && (
        <div className="hm-confirm" data-testid="d407-material-summary">
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
          <button type="button" className="d407-btn" onClick={() => setState(initialSelectionState())}>
            Change selection
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
