/**
 * gh-3199 (clause 6 of #2105; #2717 Q2, Ben's ruling on #3199: option A, an RPC).
 * Supersedes the gh-2105 batch 3 source scan: both d199-validation.tsx call sites that used to write
 * `status: 'submitted_for_admin_review'` straight to contractor_templates now call the server-side
 * RPC `submit_template_for_admin_review(p_template_id, p_overrides, p_missing_fields)`, because the
 * trigger contractor_templates_freeze_verdict rewrites any status a regular contractor writes.
 *
 * FAIL-FIRST: against origin/main's d199-validation.tsx there is no rpc call and a direct
 * `.update({ ... status: 'submitted_for_admin_review' })` exists, so the tests below fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '..', 'd199-validation.tsx'), 'utf8');
const reqStart = src.indexOf('async function requestAdminReview()');
const reqEnd = src.indexOf('return (', reqStart);
const requestBlock = src.slice(reqStart, reqEnd);
const start = src.indexOf('if (missingFields.length > 0) {');
const end = src.indexOf('const result = await callValidate(row.id!, overrides);', start);
const block = src.slice(start, end);

describe('d199-validation submit goes through the status RPC (gh-3199)', () => {
  it('locates both call sites', () => {
    expect(reqStart).toBeGreaterThan(-1);
    expect(reqEnd).toBeGreaterThan(reqStart);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('no client write of status submitted_for_admin_review remains', () => {
    expect(src).not.toMatch(/status:\s*'submitted_for_admin_review'/);
    expect(requestBlock).not.toMatch(/\.update\(/);
    expect(block).not.toMatch(/\.update\(/);
  });

  it('requestAdminReview calls the RPC with the template id and null overrides/missing fields', () => {
    expect(requestBlock).toMatch(/supabase\.rpc\('submit_template_for_admin_review', \{\s*p_template_id: row\.id,\s*p_overrides: null,\s*p_missing_fields: null,\s*\}\)/);
  });

  it('the manual-mapping submit sends overrides and missing fields as separate arguments in one RPC call', () => {
    expect(block).toMatch(/supabase\.rpc\('submit_template_for_admin_review', \{\s*p_template_id: row\.id!,\s*p_overrides: overrides,\s*p_missing_fields: missingFields,\s*\}\)/);
    expect(block).not.toMatch(/manual_overrides:\s*\{/);
  });

  it('the success alert comes only after the returned row is checked for the target status', () => {
    const check = block.indexOf("status !== 'submitted_for_admin_review'");
    const alertAt = block.indexOf('alert(');
    expect(check).toBeGreaterThan(-1);
    expect(alertAt).toBeGreaterThan(check);
    expect(requestBlock).toContain("status !== 'submitted_for_admin_review'");
  });

  it('internal tokens are logged, never shown', () => {
    const catchBlock = src.slice(src.indexOf('} catch (e) {', end));
    expect(catchBlock).toContain("console.error('[D-199] manual mapping submit did not reach submitted_for_admin_review:'");
    expect(catchBlock).toContain("internal ? 'Submission failed' :");
    expect(src).not.toContain('wrote no row:');
    expect(block).toContain("status_not_reached: submit_template_for_admin_review (manual mapping submit)");
    expect(requestBlock).toContain("console.error('[D-199] admin review submit did not reach the status:'");
    expect(requestBlock).toContain("alert('Could not submit for admin review.')");
  });

  it('the target-status predicate rejects a trigger-rewritten status and accepts the real one', () => {
    const reached = (row: { status: string } | null) => !!row && row.status === 'submitted_for_admin_review';
    expect(reached({ status: 'pending_validation' })).toBe(false); // what main produced on every submit
    expect(reached(null)).toBe(false);
    expect(reached({ status: 'submitted_for_admin_review' })).toBe(true);
  });

  it('rejected rows show the upload action, not "Request admin review" (source scan)', () => {
    const act = src.indexOf('{showActions && (');
    const actEnd = src.indexOf('{mappingOpen && row.id', act);
    const actions = src.slice(act, actEnd);
    expect(actions).toMatch(/row\.status === 'rejected' \?/);
    const rejectedBranch = actions.slice(actions.indexOf("row.status === 'rejected' ?"), actions.indexOf(') : ('));
    expect(rejectedBranch).toContain('D199_UPLOAD_CORRECTED_LABEL');
    expect(rejectedBranch).toContain('onUploadCorrected');
    expect(rejectedBranch).not.toContain('Request admin review');
    expect(actions.slice(actions.indexOf(') : (')).match(/Request admin review/g)).toHaveLength(1);
  });
});
