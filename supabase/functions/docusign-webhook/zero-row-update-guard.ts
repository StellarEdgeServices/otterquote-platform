// gh-2105 (batch 3) -- pure, synchronous, unit-testable logic for the
// #2103/gh-2105 defect class: a supabase-js `.from(t).update({...}).eq(...)`
// call with no `.select(` chained resolves `{ error: null }` even when RLS or
// the `.eq()` filter matches ZERO rows -- PostgREST/Supabase do not treat a
// zero-row match as an error. On a money/legal path (a contract-signed flag,
// a platform-fee-charge flip, a dunning-state transition) that means the
// caller believes the write succeeded while nothing was actually written,
// with no error anywhere to notice it by.
//
// The fix pattern (batch 1, react-app/app/(homeowner)/bids/actions.ts, PR
// #2199; batch 2's Deno port, supabase/functions/_shared/
// zero-row-update-guard.ts, PR #2210): chain `.select('id')` on the update
// and check the returned row array is non-empty.
//
// This is a LOCAL copy, in this function's own directory, matching this
// file's existing convention for pure/testable logic (ack-verify.ts,
// price-verify.ts, payload-parser.ts, payment-response-classify.ts all live
// here rather than in `_shared`) -- and NOT an import from
// `supabase/functions/_shared/zero-row-update-guard.ts`, because as of this
// batch that file exists only on PR #2210's unmerged branch, not on `main`.
// The logic below is intentionally byte-identical in behavior to it, so a
// follow-up de-duplication pass (once #2210 merges) is mechanical.
export interface RowsWrittenResult {
  /** true iff the update's `.select()` returned at least one row. */
  wroteRows: boolean;
  /** Number of rows the `.select()` returned (0 when none/null/not an array). */
  rowCount: number;
}

/**
 * Inspect the `data` returned by `.update(...).eq(...).select('id')` and
 * report whether the write actually matched a row. Treats `null`,
 * `undefined`, or any non-array value the same as an empty array (all mean
 * "nothing came back to prove a row was written").
 */
export function checkRowsWritten(rows: unknown): RowsWrittenResult {
  const rowCount = Array.isArray(rows) ? rows.length : 0;
  return { wroteRows: rowCount > 0, rowCount };
}

/**
 * Build a single-line, greppable log message for a detected zero-row write
 * on a money/legal path, so every site in this function uses the same shape
 * in `console.error` / `platform_alerts_log` output (op is the DB write's
 * short description, e.g. "quotes.payment_status=succeeded for quote q1").
 */
export function zeroRowWriteMessage(functionName: string, op: string): string {
  return `[${functionName}] gh-2105: zero-row update -- ${op} matched no rows; the write silently did nothing.`;
}
