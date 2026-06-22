'use client';

/**
 * Side-by-side comparison grid (bids.html:2188-2252). 16 canonical rows across 5
 * sections; each cell shows ✓ / "$X OOP" / ✗ / — via its cell-* class; rows whose
 * cells all match are dimmed (identical-row dimming). Needs 2+ active bids.
 */

import { buildCompareModel, COMPARE_NEEDS_TWO, activeBids } from '../utils';
import type { BidRow, ContractorProfile } from '../types';

interface BidsCompareGridProps {
  bids: BidRow[];
  contractors: Record<string, ContractorProfile>;
}

export function BidsCompareGrid({ bids, contractors }: BidsCompareGridProps) {
  if (activeBids(bids).length < 2) {
    return <div className="oqb-compare-empty">{COMPARE_NEEDS_TWO}</div>;
  }

  const model = buildCompareModel(bids, contractors);
  const cols = `180px repeat(${model.headers.length}, minmax(140px, 1fr))`;

  return (
    <div className="oqb-compare" style={{ gridTemplateColumns: cols }} role="table" aria-label="Bid comparison">
      <div className="oqb-compare-corner" />
      {model.headers.map((h, i) => (
        <div className="oqb-compare-header" key={i} role="columnheader">
          <div className="oqb-compare-name">{h.name}</div>
          <div className="oqb-compare-price">{h.price}</div>
          {h.isLowest && <div className="oqb-compare-best">Best price</div>}
        </div>
      ))}

      {model.sections.map((section) => (
        <div className="oqb-compare-section" key={section.name} style={{ display: 'contents' }}>
          <div className="oqb-compare-section-header">{section.name}</div>
          {section.rows.map((row) => (
            <div
              className={'oqb-compare-row' + (row.identical ? ' identical' : '')}
              key={row.label}
              style={{ display: 'contents' }}
              role="row"
            >
              <div className="oqb-compare-row-label">{row.label}</div>
              {row.cells.map((cell, ci) => (
                <div className={'oqb-compare-cell ' + (cell.cls || '')} key={ci} role="cell">
                  {cell.display}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
