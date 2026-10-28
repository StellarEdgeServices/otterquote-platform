// gh-3056: the hook must only select columns that exist in production.
// Schema snapshot verified read-only via information_schema / pg_get_functiondef (2026-10-24).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { brandFromScopeSummary } from '../signing-utils';

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

// gh-3138: public.quotes columns per supabase/migrations/20260101000000_v000_baseline_schema.sql and sql/schema-snapshot.json.
// There is NO brand or product_line column; the bid's brand lives in the scope_summary JSON string.
const QUOTES_COLUMNS = new Set([
  'id', 'claim_id', 'contractor_id', 'total_price', 'estimated_days', 'timeline_note', 'scope_summary', 'notes',
  'fee_percentage', 'fee_amount', 'fee_agreed', 'fee_agreed_at', 'status', 'created_at', 'updated_at',
  'decking_price_per_sheet', 'full_redeck_price', 'supplement_acknowledged', 'trade_type', 'is_bundled_bid',
  'bundled_trades', 'per_trade_breakdown', 'value_adds', 'payment_intent_id', 'payment_status',
  'docusign_envelope_id', 'contractor_signed_at', 'homeowner_signed_at', 'is_auto_bid', 'payment_method_id',
  'payment_method_type', 'card_fee_cents', 'cancelled_at', 'cancellation_reason', 'expires_at', 'auto_renew',
  'renewed_from_quote_id', 'expired_at', 'bid_status', 'warranty_option_id', 'warranty_snapshot',
  'material_selection', 'workmanship_warranty_years', 'warranty_document_url', 'warranty_uploaded_at',
  'platform_fee_pct', 'platform_fee_basis', 'fee_accepted_at', 'is_test',
]);

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
  it('winning-quote select uses only existing quotes columns (gh-3138)', () => {
    const cols = referencedColumns(SRC, ".from('quotes')");
    expect(cols.length).toBeGreaterThan(0);
    expect(missing(cols, QUOTES_COLUMNS)).toEqual([]);
  });
  it('NEGATIVE CONTROL: the old query shapes fail the schema check', () => {
    const oldProfiles = ".from('profiles')\n.select('user_id, full_name')\n.eq('user_id', userId)";
    const oldRpc = ".rpc('get_contractors_public')\n.select('id, company_name, years_in_business, logo_url')\n.eq('id', x)";
    expect(missing(referencedColumns(oldProfiles, ".from('profiles')"), PROFILES_COLUMNS)).toEqual(['user_id', 'user_id']);
    expect(missing(referencedColumns(oldRpc, ".rpc('get_contractors_public')"), GET_CONTRACTORS_PUBLIC_COLUMNS)).toEqual(['logo_url']);
  });
  it('NEGATIVE CONTROL (gh-3138): the old quotes select fails the schema check', () => {
    const oldQuotes = ".from('quotes')\n.select('brand, product_line, decking_price_per_sheet, status')\n.eq('claim_id', c)";
    expect(missing(referencedColumns(oldQuotes, ".from('quotes')"), QUOTES_COLUMNS)).toEqual(['brand', 'product_line']);
  });
  it('brand is read from scope_summary JSON; malformed or absent yields null (gh-3138)', () => {
    expect(brandFromScopeSummary('{"brand":"GAF Timberline HDZ","estimated_start_date":null}')).toBe('GAF Timberline HDZ');
    expect(brandFromScopeSummary({ brand: ' Owens Corning ' })).toBe('Owens Corning');
    expect(brandFromScopeSummary('not json')).toBeNull();
    expect(brandFromScopeSummary(null)).toBeNull();
    expect(brandFromScopeSummary('{"brand":null}')).toBeNull();
  });
});
