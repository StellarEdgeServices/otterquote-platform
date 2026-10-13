// gh-2105 (batch 2): turn a supabase-js `.update(...).select(...)` result into the
// ledger's MarkResult shape. A bare update resolves { error: null } when it matches
// ZERO rows, so "the ledger row was written" must be proved by a row coming back.
// Pure (no client, no Deno.env) so it is unit-testable; index.ts is not importable
// (it calls serve()).
import { checkRowsWritten, zeroRowWriteMessage } from "../_shared/zero-row-update-guard.ts";

export const ZERO_ROWS_CODE = "gh2105_zero_rows";

export function markResult(
  error: { code?: string; message: string } | null | undefined,
  rows: unknown,
  op: string,
  functionName = "send-partner-onboarding",
): { error: { code?: string; message: string } | null } {
  if (error) return { error: { code: error.code, message: error.message } };
  if (!checkRowsWritten(rows).wroteRows) {
    return { error: { code: ZERO_ROWS_CODE, message: zeroRowWriteMessage(functionName, op) } };
  }
  return { error: null };
}
