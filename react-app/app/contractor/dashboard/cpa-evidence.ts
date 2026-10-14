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

/** Minimal client surface for the contractors CPA-acceptance write (unit-testable). */
export interface CpaWriteClient {
  from: (table: string) => {
    update: (patch: Record<string, unknown>) => {
      eq: (col: string, val: string) => {
        select: (cols: string) => PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
}

/**
 * gh-2105 (batch 2): the CPA acceptance / re-acceptance write on `contractors`.
 * A bare `.update().eq()` resolves `{ error: null }` when RLS or a stale id matches
 * ZERO rows, so the contractor would see "accepted" while the legal-acceptance
 * columns never changed. This chains `.select('id')` and returns an Error whose
 * message starts `update_zero_rows` when no row came back (the #2610 token, logged
 * for diagnosis and never shown: the callers show their existing error copy).
 * Returns null on a real write, else the error. A throw is returned, not rethrown.
 */
export async function writeCpaAcceptance(
  client: CpaWriteClient,
  contractorId: string,
  patch: Record<string, unknown>,
): Promise<unknown | null> {
  try {
    const { data, error } = await client.from('contractors').update(patch).eq('id', contractorId).select('id');
    if (error) return error;
    if (!Array.isArray(data) || data.length === 0) return new Error('update_zero_rows: contractors (CPA acceptance)');
    return null;
  } catch (e) {
    return e;
  }
}
