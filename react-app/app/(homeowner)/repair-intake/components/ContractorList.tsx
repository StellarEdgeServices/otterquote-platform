'use client';

/**
 * "Contractors Available for Repairs" list (H9). Shown after submission, from the
 * contractors_public PUBLIC-SAFE view.
 *
 * Hardening fold-in (brief item 5): the static built each card via innerHTML with
 * interpolated contractors_public fields (company_name, years_in_business,
 * rating, and a never-selected `phone`). Here every field renders as React JSX —
 * never innerHTML — so no field can inject markup. `phone` is OMITTED: it is not
 * a column on contractors_public (verified live 2026-06-23), so the static's
 * phone block was always falsy; rendering it would print undefined.
 */

import type { ContractorPublicRow } from '../types';

interface ContractorListProps {
  contractors: ContractorPublicRow[];
  loading: boolean;
  error: Error | null;
}

export function ContractorList({ contractors, loading, error }: ContractorListProps) {
  if (loading) {
    return <p className="ri-loading-contractors">Loading available contractors…</p>;
  }

  // Faithful: the static collapsed both the error and the empty result into the
  // same "no contractors opted in yet — your claim is saved" reassurance.
  if (error || contractors.length === 0) {
    return (
      <div className="ri-empty-contractors">
        <strong>No contractors have opted into repairs yet.</strong>
        <p>
          Your claim has been saved. We’ll notify you as soon as a contractor opts
          in to handle your repair.
        </p>
      </div>
    );
  }

  return (
    <div>
      {contractors.map((c) => (
        <div className="ri-contractor" key={c.id}>
          <div className="ri-contractor-top">
            <div>
              <span className="ri-contractor-name">{c.company_name}</span>
              {c.years_in_business ? (
                <span className="ri-contractor-years">
                  {c.years_in_business} yrs in business
                </span>
              ) : null}
            </div>
            {c.rating ? (
              <span className="ri-contractor-rating">★ {c.rating}</span>
            ) : null}
          </div>
          <p className="ri-contractor-repairs">✓ Accepts repair work</p>
        </div>
      ))}
    </div>
  );
}
