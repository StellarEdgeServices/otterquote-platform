// gh-2105 (batch 2) -- shared guard for the #2103/gh-2105 defect class: a
// supabase-js `.from(t).update({...}).eq(...)` call with no `.select(`
// chained resolves `{ error: null }` even when RLS or the `.eq()` filter
// matches ZERO rows -- PostgREST/Supabase do not treat a zero-row match as
// an error. On a money path (a Stripe payment_status flip, a fee-charged
// flag, a payout/commission write) that means the caller believes the write
// succeeded while nothing was actually written, with no error anywhere to
// notice it by.
//
// The fix pattern (see react-app/app/(homeowner)/bids/actions.ts, gh-2105
// batch 1 / PR #2199): chain `.select('id')` and check the returned row
// array is non-empty. This module is the batch-2 shared version of that
// check for the Deno edge functions, which don't share a module boundary
// with the React app.
//
// This file holds ONLY pure, synchronous logic -- no Supabase client, no
// fetch, no Deno.env -- so it can be unit-tested directly (see
// zero-row-update-guard.test.ts) without mocking a database.

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
 * on a money path, so every site uses the same shape in `console.error` /
 * `platform_alerts_log` output (op is the DB write's short description,
 * e.g. "quotes.payment_status=succeeded for quote abc123").
 */
export function zeroRowWriteMessage(functionName: string, op: string): string {
  return `[${functionName}] gh-2105: zero-row update -- ${op} matched no rows; the write silently did nothing.`;
}
