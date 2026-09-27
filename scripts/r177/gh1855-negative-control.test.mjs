// gh-1855 NEGATIVE CONTROL -- DELIBERATE FAILURE. DO NOT MERGE.
// This file exists only on branch cto43/gh1855-negative-control to prove that a
// red "R-177 predicate tests" check blocks the merge on main. The PR is closed
// unmerged and the branch deleted after the refusal is captured.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('gh-1855 negative control: this assertion is deliberately false', () => {
  assert.equal(1, 2, 'DELIBERATE failure for gh-1855 negative control -- do not merge');
});
