'use client';

/**
 * Designer-product catalog grid (H8 hardening fold-in, brief item 4).
 *
 * The static page assembled this whole grid via container.innerHTML with
 * interpolated material_catalog fields (manufacturer, product_name, description,
 * and visualizer_url inside an href). Here it is rendered as React JSX — never
 * dangerouslySetInnerHTML — so even though material_catalog is admin-curated,
 * no field can inject markup. visualizer_url opens with rel="noopener noreferrer".
 */

import type { MaterialCatalogRow } from '../types';
import {
  groupByManufacturer,
  impactBadge,
  tierBadge,
  truncateDescription,
} from '../utils';

interface DesignerProductGridProps {
  products: MaterialCatalogRow[];
  loading: boolean;
  error: Error | null;
  selectedId: string | null;
  onSelect: (product: MaterialCatalogRow) => void;
}

export function DesignerProductGrid({
  products,
  loading,
  error,
  selectedId,
  onSelect,
}: DesignerProductGridProps) {
  if (loading) {
    return <p className="hm-products-empty">Loading designer products…</p>;
  }
  if (error) {
    return (
      <p className="hm-products-error" role="alert">
        Error loading products. Please refresh the page.
      </p>
    );
  }
  if (products.length === 0) {
    return <p className="hm-products-empty">No designer products available yet.</p>;
  }

  const groups = groupByManufacturer(products);

  return (
    <div>
      {groups.map((group) => (
        <div className="hm-mfr-group" key={group.manufacturer}>
          <h3 className="hm-mfr-name">{group.manufacturer}</h3>
          <div className="hm-product-grid">
            {group.products.map((p) => {
              const impact = impactBadge(p.impact_class);
              const tier = tierBadge(p.price_tier);
              const selected = p.id === selectedId;
              return (
                <button
                  type="button"
                  key={p.id}
                  className={'hm-product' + (selected ? ' selected' : '')}
                  aria-pressed={selected}
                  onClick={() => onSelect(p)}
                >
                  <div className="hm-product-head">
                    <span className="hm-product-name">{p.product_name}</span>
                    <span className="hm-product-badges">
                      {impact && (
                        <span className={'hm-product-badge ' + impact.variant}>
                          {impact.label}
                        </span>
                      )}
                      <span className={'hm-product-badge ' + tier.variant}>
                        {tier.label}
                      </span>
                    </span>
                  </div>
                  {p.description && (
                    <span className="hm-product-desc">
                      {truncateDescription(p.description)}
                    </span>
                  )}
                  {p.visualizer_url && (
                    <a
                      className="hm-product-link"
                      href={p.visualizer_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View Colors →
                    </a>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
