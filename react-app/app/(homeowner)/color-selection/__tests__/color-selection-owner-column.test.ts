// gh-2105 batch 13 (REVIEW: FAIL 6049368115, point 3): claims has no homeowner_id column
// in production (information_schema.columns on public.claims: id, user_id, homeowner_name,
// homeowner_notes only). A May 2026 rename put homeowner_id into the color-selection load
// and save, so the page errored before the save was reachable. Guard the owner column.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../../..');
const files = [
  'color-selection.html',
  'react-app/app/(homeowner)/color-selection/use-color-selection-data.ts',
];

describe('color-selection scopes claims by user_id, not the nonexistent homeowner_id', () => {
  for (const f of files) {
    it(f, () => {
      const src = readFileSync(resolve(root, f), 'utf8');
      expect(src).not.toMatch(/\.eq\(\s*['"]homeowner_id['"]/);
      // the select list of the claims load
      expect(src).not.toMatch(/^\s*homeowner_id,\s*$/m);
      expect(src).toMatch(/\.eq\(\s*['"]user_id['"]/);
    });
  }
});
