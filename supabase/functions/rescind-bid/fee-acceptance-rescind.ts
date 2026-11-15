// gh-3750: when rescind-bid withdraws a bid, stamp rescinded_at (and rescission_reason) on the bid's fee_acceptances row(s).
// Why: fee_acceptances.rescinded_at / rescission_reason were created with the table (D-214/D-215, sql/v62) as the record of a
// withdrawn acceptance, and stripe-webhook's acceptance selector already filters `rescinded_at IS NULL`, but nothing in the
// repo ever wrote the column (gh3320 header: "never-written columns"). So a withdrawn bid kept a live-looking acceptance.
// Table posture (read from production 2026-11-15): UPDATE is granted only to service_role and postgres (gh3320 revoked it from
// anon/authenticated), no UPDATE/DELETE policy, and the only trigger is BEFORE INSERT. service_role may therefore set this
// column with no migration. The update is idempotent: it touches only rows still NULL, so a retry never moves the first stamp.
// Dependency-free so a test can import it (index.ts calls Deno.serve at load).

// deno-lint-ignore no-explicit-any
type Db = { from: (table: string) => any };

// A fixed, machine-readable marker (a data value, not customer copy). It tells a withdrawal of the bid apart from a D-215 24-hour
// rescission-link rescission, which would carry its own value. No other convention for rescission_reason exists in the repo (no writer
// before this one). The contractor's free-text reason is NOT stored here: it stays in activity_log.metadata.reason (rescind-bid index.ts).
export const BID_WITHDRAWN_REASON = "bid_withdrawn";

export interface StampResult {
  ok: boolean;
  stamped: number;
  error?: string;
}

export async function stampFeeAcceptancesRescinded(
  db: Db,
  p: { quoteId: string; contractorId: string; rescindedAt: string },
): Promise<StampResult> {
  try {
    const { data, error } = await db
      .from("fee_acceptances")
      .update({ rescinded_at: p.rescindedAt, rescission_reason: BID_WITHDRAWN_REASON })
      .eq("bid_id", p.quoteId)
      .eq("contractor_id", p.contractorId)
      .is("rescinded_at", null)
      .select("id");
    if (error) return { ok: false, stamped: 0, error: String(error.message ?? JSON.stringify(error)) };
    return { ok: true, stamped: Array.isArray(data) ? data.length : 0 };
  } catch (e) {
    return { ok: false, stamped: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// Visibility for a failed stamp beyond console.error: one platform_alerts_log row (the pattern platform-health-check and
// watch-template-mapping use: alert_type, function_name, message; service_role INSERT policy, sql/v52b). Never throws.
export const STAMP_FAILED_ALERT_TYPE = "fee_acceptance_rescind_stamp_failed";

export async function alertStampFailure(db: Db, p: { quoteId: string; contractorId: string; error?: string }): Promise<boolean> {
  try {
    const { error } = await db.from("platform_alerts_log").insert({
      alert_type: STAMP_FAILED_ALERT_TYPE,
      function_name: "rescind-bid",
      message: `quote=${p.quoteId} contractor=${p.contractorId} fee_acceptances rescinded_at stamp failed after the bid was withdrawn: ${(p.error ?? "unknown").slice(0, 300)}`,
    });
    return !error;
  } catch {
    return false;
  }
}
