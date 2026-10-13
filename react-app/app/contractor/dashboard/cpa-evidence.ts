/**
 * gh-2444 part (a): shared CPA acceptance evidence for the React dashboard's
 * first-acceptance (AgreementModal) and re-acceptance (CpaReacceptModal) paths.
 *
 * Mirrors recordCpaAcceptanceEvidence() in contractor-dashboard.html. supabase-js
 * RETURNS `{ error }` (it does not throw), so both results are checked. Returns
 * null on success or the first error: a failed evidence write must not be treated
 * as a successful acceptance. Stops at the first failure so a retry does not
 * duplicate an activity_log row. Call only after the contractors update succeeded.
 */

/** Minimal supabase client surface this helper needs (keeps it unit-testable). */
export interface CpaEvidenceClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
  };
}

export async function recordCpaAcceptanceEvidence(
  client: CpaEvidenceClient,
  args: { contractorId: string; userId: string; now: string; title: string },
): Promise<unknown | null> {
  try {
    const { error } = await client.rpc('record_cpa_ip', { p_contractor_id: args.contractorId });
    if (error) {
      console.error('record_cpa_ip failed:', error);
      return error;
    }
  } catch (e) {
    console.error('record_cpa_ip failed:', e);
    return e;
  }
  try {
    const { error } = await client.from('activity_log').insert({
      user_id: args.userId, event_type: 'cpa_accepted', title: args.title, created_at: args.now,
    });
    if (error) {
      console.error('activity_log failed:', error);
      return error;
    }
  } catch (e) {
    console.error('activity_log failed:', e);
    return e;
  }
  return null;
}
