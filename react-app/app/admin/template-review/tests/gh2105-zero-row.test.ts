/**
 * gh-2105 batch 7 -- admin-template-review.html's contract-template
 * approve/reject writes (D-211 A6), and its React twin page.tsx, had no
 * `.select()` chained on either `.update()`. A zero-row RLS/id-mismatch
 * match reported success (the drawer closed and the list refreshed) while
 * `contractor_templates.status` -- what gates whether a contractor's
 * template can be used on a bid -- never actually changed.
 *
 * admin-template-review.html can't be imported (a raw static page with an
 * inline <script>, not a module), so -- following
 * gh2105-admin-fee-config-html-zero-row.test.ts's established source-guard
 * convention -- this reads both files as text and asserts the fix's wiring
 * is present.
 *
 * FAIL-FIRST: run against origin/k72/gh2105-batch6's (pre-batch-7) files --
 * neither `.update(...).eq('id', id)` / `.eq('id', openTemplate.id)` chains
 * `.select('id')` and neither has a zero-row-guarded alert. Every
 * assertion below fails there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// react-app/app/admin/template-review/tests -> repo root is 5 levels up.
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const htmlSrc = readFileSync(resolve(repoRoot, 'admin-template-review.html'), 'utf8');
const pageSrc = readFileSync(resolve(here, '..', 'page.tsx'), 'utf8');

describe('admin-template-review.html source guards', () => {
  it('reads/writes contractor_templates with the same call shape as the React twin', () => {
    expect(htmlSrc).toContain("sb.from('contractor_templates').update({");
    expect(htmlSrc).toContain("status: 'admin_validated'");
    expect(htmlSrc).toContain("status: 'rejected'");
  });

  it('gh-2105 (decision a, legal): approveTemplate chains .select() and alerts on a zero-row match', () => {
    const idxApprove = htmlSrc.indexOf('async function approveTemplate(id) {');
    const idxReject = htmlSrc.indexOf('async function rejectTemplate(id) {');
    expect(idxApprove).toBeGreaterThan(-1);
    expect(idxReject).toBeGreaterThan(idxApprove);
    const approveBlock = htmlSrc.slice(idxApprove, idxReject);
    expect(approveBlock).toContain(".eq('id', id).select('id')");
    expect(approveBlock).toContain('gh2105_zero_rows');
    expect(approveBlock).toContain("!Array.isArray(data) || data.length === 0");
  });

  it('gh-2105 (decision a, legal): rejectTemplate chains .select() and alerts on a zero-row match', () => {
    const idxReject = htmlSrc.indexOf('async function rejectTemplate(id) {');
    const idxLogout = htmlSrc.indexOf('async function handleLogout() {');
    expect(idxReject).toBeGreaterThan(-1);
    expect(idxLogout).toBeGreaterThan(idxReject);
    const rejectBlock = htmlSrc.slice(idxReject, idxLogout);
    expect(rejectBlock).toContain(".eq('id', id).select('id')");
    expect(rejectBlock).toContain('gh2105_zero_rows');
    expect(rejectBlock).toContain("!Array.isArray(data) || data.length === 0");
  });
});

describe('page.tsx source guards (React twin)', () => {
  it('reads/writes contractor_templates with the static call shapes', () => {
    expect(pageSrc).toContain("from('contractor_templates')");
    expect(pageSrc).toContain('buildApproveUpdate(user.id)');
    expect(pageSrc).toContain('buildRejectUpdate(user.id, reason)');
  });

  it('gh-2105 (decision a, legal): handleApprove chains .select() and alerts on a zero-row match', () => {
    const idxApprove = pageSrc.indexOf('async function handleApprove() {');
    const idxReject = pageSrc.indexOf('async function handleReject() {');
    expect(idxApprove).toBeGreaterThan(-1);
    expect(idxReject).toBeGreaterThan(idxApprove);
    const approveBlock = pageSrc.slice(idxApprove, idxReject);
    expect(approveBlock).toContain(".eq('id', openTemplate.id)\n      .select('id')");
    expect(approveBlock).toContain('gh2105_zero_rows');
    expect(approveBlock).toContain('!Array.isArray(data) || data.length === 0');
  });

  it('gh-2105 (decision a, legal): handleReject chains .select() and alerts on a zero-row match', () => {
    const idxReject = pageSrc.indexOf('async function handleReject() {');
    const idxLogout = pageSrc.indexOf('async function handleLogout() {');
    expect(idxReject).toBeGreaterThan(-1);
    expect(idxLogout).toBeGreaterThan(idxReject);
    const rejectBlock = pageSrc.slice(idxReject, idxLogout);
    expect(rejectBlock).toContain(".eq('id', openTemplate.id)\n      .select('id')");
    expect(rejectBlock).toContain('gh2105_zero_rows');
    expect(rejectBlock).toContain('!Array.isArray(data) || data.length === 0');
  });
});

describe('mutation control', () => {
  it('the zero-row guard in each block is anchored to that block\'s own update, not borrowed from the other', () => {
    const idxApprove = htmlSrc.indexOf('async function approveTemplate(id) {');
    const idxReject = htmlSrc.indexOf('async function rejectTemplate(id) {');
    const idxLogout = htmlSrc.indexOf('async function handleLogout() {');
    const approveGuardIdx = htmlSrc.indexOf('gh2105_zero_rows', idxApprove);
    const rejectGuardIdx = htmlSrc.indexOf('gh2105_zero_rows', idxReject);
    expect(approveGuardIdx).toBeGreaterThan(idxApprove);
    expect(approveGuardIdx).toBeLessThan(idxReject);
    expect(rejectGuardIdx).toBeGreaterThan(idxReject);
    expect(rejectGuardIdx).toBeLessThan(idxLogout);
  });
});
