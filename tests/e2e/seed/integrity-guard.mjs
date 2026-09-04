// gh-1584 / gh-1602 — seed-side integrity guard, extracted for unit testing.
//
// This is the pure, unit-testable half of the "6e. Integrity guard" step in
// seed.mjs. It is kept in its own module (not inline in seed.mjs) SPECIFICALLY
// so it can be imported by integrity-guard.test.mjs without also executing
// seed.mjs's top-level module code — the SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// env var requirement, the PRODUCTION_PROJECT_REF guard (gh-1028), and real
// Supabase client construction, none of which a unit test should need or
// want to trigger.
//
// gh-1602 REVIEW: FAIL fix — the prior version of this guard (inline in
// seed.mjs) was verified only by reading the trace, never by executing it
// against a constructed bad row. See integrity-guard.test.mjs for the tests
// that now exercise this against both the bad shape and the good shape, and
// against a failing query (fail-closed).

/**
 * True when a contractor_templates row is in the exact bad shape #1584
 * exists to catch: status='auto_validated' (bid_can_submit's "may bid"
 * gate) with no validation_result behind it.
 *
 * `== null` (not `=== null`) is deliberate, carried over from the original
 * inline check: a jsonb column holding SQL NULL and one holding the JSON
 * literal `null` are indistinguishable once PostgREST serializes them to a
 * JSON response — both arrive here as JS `null`. `== null` also catches
 * `undefined`, i.e. the column being omitted from the row entirely, which
 * `=== null` would miss.
 *
 * @param {{ status?: string, validation_result?: unknown }} row
 * @returns {boolean}
 */
export function isUnvalidatedAutoValidated(row) {
  return row.status === 'auto_validated' && row.validation_result == null;
}

/**
 * Runs the gh-1584 integrity guard against whatever rows `fetchAutoValidatedRows`
 * returns, and throws if any of them are in the bad shape.
 *
 * Fail-closed by construction: `fetchAutoValidatedRows` is expected to
 * resolve with a Supabase-style `{ data, error }` result (or reject/throw
 * outright on a network-level failure). Either an `error` field or a thrown
 * exception is treated as the guard itself being unable to run, and is
 * re-thrown rather than swallowed — the seed must NOT proceed as though the
 * guard had passed clean just because its own query failed. This mirrors
 * (and makes independently testable) the same fail-closed shape the
 * original inline `if (guardErr) throw ...` already had; it is made
 * explicit and test-covered here rather than changed.
 *
 * @param {() => Promise<{ data: any[] | null, error: any }>} fetchAutoValidatedRows
 * @returns {Promise<any[]>} the (empty, on success) list of offending rows
 */
export async function runIntegrityGuard(fetchAutoValidatedRows) {
  let result;
  try {
    result = await fetchAutoValidatedRows();
  } catch (err) {
    // A thrown/rejected query (e.g. a network-level failure, not a
    // Supabase-style `{ error }` result) must still fail closed rather than
    // be treated as "no rows found, guard passed."
    throw new Error(
      `Integrity guard query threw: ${err && err.message ? err.message : err}`
    );
  }

  const { data, error } = result || {};
  if (error) {
    throw new Error(`Integrity guard query failed: ${error.message || error}`);
  }

  const unvalidatedRows = (data || []).filter(isUnvalidatedAutoValidated);
  if (unvalidatedRows.length > 0) {
    const banner = '\n' + '❌'.repeat(24) + '\n';
    console.error(banner);
    console.error(
      `GH-1584 INTEGRITY GUARD FAILED: ${unvalidatedRows.length} contractor_templates ` +
        "row(s) have status='auto_validated' with NO validation_result. This is the " +
        'exact fail-quiet shape #1584 exists to prevent — bid_can_submit treats ' +
        'auto_validated as "may bid" with no validation artefact behind it. Offending rows:\n' +
        JSON.stringify(unvalidatedRows, null, 2)
    );
    console.error(banner);
    throw new Error(
      `Integrity guard failed: ${unvalidatedRows.length} auto_validated contractor_templates ` +
        'row(s) with no validation_result. See the banner above for the offending rows.'
    );
  }

  return unvalidatedRows;
}
