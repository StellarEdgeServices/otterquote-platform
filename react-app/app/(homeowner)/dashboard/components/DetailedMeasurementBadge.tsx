'use client';

/**
 * gh-1411 / D-317 cl. 5-6 — homeowner Shape-B "detailed" mark, DISPLAY ONLY.
 *
 * Renders once a contractor's paid upgrade purchase has been delivered by an
 * admin (admin-measurements.html flips claims.measurement_shape to 'full' —
 * the ONLY writer, see react-app/app/lib/measurement-shape.ts). No charge or
 * purchase logic on this page: the homeowner's copy upgrades for free in the
 * same write that flips the shape, per D-317 cl. 5. Mirrors RebateCard's
 * layout/pattern (D-181) for a consistent homeowner-dashboard card style.
 */

import { shouldShowDetailedMeasurementBadge, buildDetailedMeasurementBadge } from '../utils';
import type { HomeownerClaim } from '../types';

export function DetailedMeasurementBadge({ claim }: { claim: HomeownerClaim | null }) {
  if (!shouldShowDetailedMeasurementBadge(claim)) return null;
  const model = buildDetailedMeasurementBadge();

  return (
    <div
      style={{
        marginTop: '1.25rem',
        background: 'var(--navy-2, #0f2942)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '0.875rem',
        padding: '1.25rem 1.5rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
        <div style={{ fontSize: '1.75rem', flexShrink: 0, lineHeight: 1 }} aria-hidden="true">
          📐
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontWeight: 700,
              color: '#10B981',
              fontSize: '1rem',
              marginBottom: '0.5rem',
            }}
          >
            {model.header}
          </div>
          <div
            style={{
              fontSize: '0.875rem',
              color: 'rgba(255,255,255,0.85)',
              lineHeight: 1.55,
            }}
          >
            {model.body}
          </div>
        </div>
      </div>
    </div>
  );
}
