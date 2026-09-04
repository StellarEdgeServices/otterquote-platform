// gh-1602 REVIEW: FAIL fix — the "6e. Integrity guard" (gh-1584) shipped in
// PR #1602 was verified only by a fresh-context reviewer reading the code
// trace, never by executing it against a constructed bad row. Per that
// review's own standard: a check that has never been run against the state
// it's supposed to catch is not evidence it catches anything.
//
// These tests construct the exact bad row (auto_validated + no
// validation_result) and assert the guard rejects it, construct the good
// row (auto_validated + a real validation_result) and assert the guard
// passes it, and assert the guard fails closed (rethrows, does not
// silently no-op) when its own query errors or throws.
//
// Convention note: this package (tests/e2e/) has no unit-test framework
// (Playwright's testDir is scoped to ./flows/ — see playwright.config.ts —
// so a file here would never be discovered by `npm test`, and there is no
// vitest/jest devDependency at this level; the react-app/ package uses
// vitest, but that's a separate, browser-app-scoped package with its own
// node_modules). seed.mjs itself is a plain Node ESM script invoked via
// `node seed/seed.mjs` (see package.json's `seed` script) — Node's built-in
// test runner matches that exact runtime with zero new dependencies, which
// also keeps this PR's diff to only the guard's own source (seed.mjs +
// the newly extracted integrity-guard.mjs) and this test file.
//
// Run with:
//   node --test tests/e2e/seed/integrity-guard.test.mjs
// (from the repo root; also runnable from tests/e2e/ as
//   node --test seed/integrity-guard.test.mjs)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isUnvalidatedAutoValidated, runIntegrityGuard } from './integrity-guard.mjs';

describe('isUnvalidatedAutoValidated (predicate)', () => {
  test('flags auto_validated + validation_result: null (SQL NULL / jsonb null, both arrive as JS null)', () => {
    const badRow = {
      id: 'row-1',
      status: 'auto_validated',
      validation_result: null,
    };
    assert.equal(isUnvalidatedAutoValidated(badRow), true);
  });

  test('flags auto_validated + validation_result absent from the row entirely', () => {
    const badRow = { id: 'row-2', status: 'auto_validated' };
    assert.equal(isUnvalidatedAutoValidated(badRow), true);
  });

  test('does NOT flag auto_validated with a real validation_result', () => {
    const goodRow = {
      id: 'row-3',
      status: 'auto_validated',
      validation_result: { seeded: true, source: 'manifest-v2' },
    };
    assert.equal(isUnvalidatedAutoValidated(goodRow), false);
  });

  test('does NOT flag a non-auto_validated row, even with no validation_result', () => {
    const notApplicable = { id: 'row-4', status: 'pending_review', validation_result: null };
    assert.equal(isUnvalidatedAutoValidated(notApplicable), false);
  });
});

describe('runIntegrityGuard (bad-state construction + rejection)', () => {
  test('REJECTS: throws when the queried rows contain an auto_validated row with no validation_result', async () => {
    const bad = {
      id: '297d480b-15c0-4b3e-85c8-62f319814be2',
      contractor_id: 'bb07fc40-3607-4f3f-ac44-dffd4ca95111',
      trade: 'roofing',
      funding_type: 'insurance',
      status: 'auto_validated',
      validation_result: null,
    };
    const fetchAutoValidatedRows = async () => ({ data: [bad], error: null });

    await assert.rejects(
      () => runIntegrityGuard(fetchAutoValidatedRows),
      /auto_validated contractor_templates row\(s\) with no validation_result/
    );
  });

  test('REJECTS: throws when validation_result key is entirely absent (not just null)', async () => {
    const bad = { id: 'row-x', status: 'auto_validated' };
    const fetchAutoValidatedRows = async () => ({ data: [bad], error: null });

    await assert.rejects(() => runIntegrityGuard(fetchAutoValidatedRows));
  });

  test('PASSES: does not throw when the auto_validated row has a real validation_result (guard is not just rejecting everything)', async () => {
    const good = {
      id: 'b69dd25a-2ae0-40f0-8283-f99ea0f7b121',
      contractor_id: 'bb07fc40-3607-4f3f-ac44-dffd4ca95111',
      trade: 'siding',
      funding_type: 'insurance',
      status: 'auto_validated',
      validation_result: { seeded: true, source: 'manifest-v2', validated_at: '2026-09-01T00:00:00Z' },
    };
    const fetchAutoValidatedRows = async () => ({ data: [good], error: null });

    const offending = await runIntegrityGuard(fetchAutoValidatedRows);
    assert.deepEqual(offending, []);
  });

  test('PASSES: empty result set (no auto_validated rows at all)', async () => {
    const fetchAutoValidatedRows = async () => ({ data: [], error: null });
    const offending = await runIntegrityGuard(fetchAutoValidatedRows);
    assert.deepEqual(offending, []);
  });

  test('PASSES: mixed set — good auto_validated rows only, bad rows of other statuses ignored', async () => {
    const rows = [
      { id: 'g1', status: 'auto_validated', validation_result: { seeded: true } },
      { id: 'other', status: 'pending_review', validation_result: null },
    ];
    const fetchAutoValidatedRows = async () => ({ data: rows, error: null });
    const offending = await runIntegrityGuard(fetchAutoValidatedRows);
    assert.deepEqual(offending, []);
  });
});

describe('runIntegrityGuard (fail-closed on query failure)', () => {
  test('FAIL-CLOSED: rethrows (does not silently pass) when the query resolves with a Supabase-style error field', async () => {
    const fetchAutoValidatedRows = async () => ({
      data: null,
      error: { message: 'relation "contractor_templates" does not exist' },
    });

    await assert.rejects(
      () => runIntegrityGuard(fetchAutoValidatedRows),
      /Integrity guard query failed/
    );
  });

  test('FAIL-CLOSED: rethrows (does not silently pass) when the query function itself throws/rejects', async () => {
    const fetchAutoValidatedRows = async () => {
      throw new Error('fetch failed: getaddrinfo ENOTFOUND');
    };

    await assert.rejects(
      () => runIntegrityGuard(fetchAutoValidatedRows),
      /Integrity guard query threw/
    );
  });

  test('FAIL-CLOSED: a query failure never resolves — it never returns an empty offending-rows array', async () => {
    const fetchAutoValidatedRows = async () => ({ data: null, error: { message: 'timeout' } });
    let resolved = false;
    try {
      await runIntegrityGuard(fetchAutoValidatedRows);
      resolved = true; // should never reach here
    } catch {
      // expected
    }
    assert.equal(resolved, false, 'runIntegrityGuard must not resolve normally when its query fails');
  });
});
