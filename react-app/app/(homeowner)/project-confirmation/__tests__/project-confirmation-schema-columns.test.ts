// gh-3056: the hook must only select columns that exist in production.
// Schema snapshot verified read-only via information_schema / pg_get_functiondef (2026-10-24).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PROFILES_COLUMNS = new Set([
  'id', 'full_name', 'email', 'created_at', 'updated_at', 'phone', 'address_street', 'address_city',
  'address_state', 'address_zip', 'referral_source', 'referring_agent_name', 'referring_agent_email',
  'role', 'sms_consent_ts', 'is_test',
]);
const GET_CONTRACTORS_PUBLIC_COLUMNS = new Set([
  'id', 'company_name', 'contact_name', 'address_city', 'address_state', 'trades', 'specialties',
  'rating', 'review_count', 'years_in_business', 'num_employees', 'about_us', 'why_choose_us',
  'owner_photo_url', 'gallery_photo_urls', 'intro_video_path', 'service_area_description',
  'service_counties', 'verified', 'has_workers_comp', 'has_general_liability', 'license_number',
  'google_reviews_url', 'bbb_url', 'angi_url', 'yelp_url', 'website_url', 'status',
  'repairs_accepted', 'public_directory_optin', 'license_doc_state',
]);

/** Columns referenced by select()/eq() calls following `.from(table)` or `.rpc(fn)`. */
export function referencedColumns(src: string, anchor: string): string[] {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`anchor not found: ${anchor}`);
  const chunk = src.slice(i, i + 300);
  const cols: string[] = [];
  const sel = /\.select\('([^']*)'\)/.exec(chunk);
  if (sel) cols.push(...sel[1].split(',').map((c) => c.trim()));
  const eq = /\.eq\('([a-z_]+)'/.exec(chunk);
  if (eq) cols.push(eq[1]);
  return cols;
}
const missing = (cols: string[], real: Set<string>) => cols.filter((c) => !real.has(c));

const SRC = readFileSync(join(__dirname, '..', 'use-project-confirmation-data.ts'), 'utf8');

describe('project-confirmation queries use real columns (gh-3056)', () => {
  it('profiles query uses only existing columns (keyed on id, not user_id)', () => {
    const cols = referencedColumns(SRC, ".from('profiles')");
    expect(cols.length).toBeGreaterThan(0);
    expect(missing(cols, PROFILES_COLUMNS)).toEqual([]);
  });
  it('get_contractors_public select uses only returned columns (no logo_url)', () => {
    const cols = referencedColumns(SRC, ".rpc('get_contractors_public')");
    expect(cols.length).toBeGreaterThan(0);
    expect(missing(cols, GET_CONTRACTORS_PUBLIC_COLUMNS)).toEqual([]);
  });
  it('NEGATIVE CONTROL: the old query shapes fail the schema check', () => {
    const oldProfiles = ".from('profiles')\n.select('user_id, full_name')\n.eq('user_id', userId)";
    const oldRpc = ".rpc('get_contractors_public')\n.select('id, company_name, years_in_business, logo_url')\n.eq('id', x)";
    expect(missing(referencedColumns(oldProfiles, ".from('profiles')"), PROFILES_COLUMNS)).toEqual(['user_id', 'user_id']);
    expect(missing(referencedColumns(oldRpc, ".rpc('get_contractors_public')"), GET_CONTRACTORS_PUBLIC_COLUMNS)).toEqual(['logo_url']);
  });
});
