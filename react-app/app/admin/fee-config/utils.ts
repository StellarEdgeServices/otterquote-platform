/**
 * Admin Platform Fee Configuration — pure logic (D-211 Phase 11).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing.
 * All network / supabase calls live in page.tsx — never here.
 *
 * Mirrors admin-fee-config.html @ main behavior 1:1.
 *
 * ⚠️  LIVE FEE MATH — DO NOT TRANSFORM VALUES.
 * `fee_pct` is stored EXACTLY as the operator types it: a percent value
 * (e.g. 15.5 means 15.5%), via parseFloat — never rounded, rescaled, converted
 * to basis points, or divided to a decimal fraction. `buildFeePayload`
 * reproduces the static page's INSERT/UPDATE body byte-for-byte:
 *   { state, trade, fee_pct, fee_basis, effective_date }
 * (the DB defaults notes/created_at/updated_at — the static page never sends them).
 *
 * §6.1 XSS note: all values are returned as plain data; JSX rendering in
 * page.tsx is inherently escaped. No HTML strings are built here.
 */

// ── Data model (platform_fee_config — sql/v62-d214-d215-fee-acceptances.sql) ──

export interface FeeConfigRow {
  /** uuid (gen_random_uuid). */
  id: string;
  /** null = applies to all states. */
  state: string | null;
  /** null = applies to all trades. */
  trade: string | null;
  /** numeric — PERCENT value exactly as entered (15.5 = 15.5%). Never rescaled. */
  fee_pct: number;
  /** e.g. 'bid_amount'. */
  fee_basis: string;
  /** date — 'yyyy-mm-dd' (or full ISO from the DB). */
  effective_date: string;
  notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

// ── Form option lists (exact values/order from admin-fee-config.html) ─────────

/** Trade <select> options — first entry is the "All Trades" (empty value) option. */
export const TRADE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Trades' },
  { value: 'Roofing', label: 'Roofing' },
  { value: 'Siding', label: 'Siding' },
  { value: 'Windows', label: 'Windows' },
  { value: 'Gutters', label: 'Gutters' },
  { value: 'Painting', label: 'Painting' },
  { value: 'Decking', label: 'Decking' },
  { value: 'HVAC', label: 'HVAC' },
  { value: 'Plumbing', label: 'Plumbing' },
  { value: 'Electrical', label: 'Electrical' },
];

/** Fee basis <select> options — the static page exposes only 'bid_amount'. */
export const FEE_BASIS_OPTIONS: { value: string; label: string }[] = [
  { value: 'bid_amount', label: 'Bid Amount' },
];

// ── Sorting ────────────────────────────────────────────────────────────────

export type FeeSortColumn =
  | 'state'
  | 'trade'
  | 'fee_pct'
  | 'fee_basis'
  | 'effective_date';

export interface FeeSortState {
  column: FeeSortColumn;
  ascending: boolean;
}

/**
 * Compute the next sort state when a column header is clicked.
 * Mirrors sortTable(): same column → flip direction; new column → ascending.
 */
export function nextSortState(
  current: FeeSortState,
  clicked: FeeSortColumn,
): FeeSortState {
  if (current.column === clicked) {
    return { column: clicked, ascending: !current.ascending };
  }
  return { column: clicked, ascending: true };
}

/**
 * Return a sorted COPY of the rows (the static page sorts allFees in place;
 * we keep React state immutable but reproduce the comparator exactly).
 *
 * Comparator parity with sortTable():
 *   - null → '' before comparing
 *   - string values lower-cased
 *   - `<` / `>` comparison, direction flipped by `ascending`
 */
export function sortFees(
  fees: FeeConfigRow[],
  column: FeeSortColumn,
  ascending: boolean,
): FeeConfigRow[] {
  const copy = [...fees];
  copy.sort((a, b) => {
    let av: string | number = a[column] === null ? '' : (a[column] as string | number);
    let bv: string | number = b[column] === null ? '' : (b[column] as string | number);
    if (typeof av === 'string') {
      av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
    }
    // Casts are erased at runtime; the live comparison runs on the real
    // string/number values, matching the static page's dynamic `<`/`>`.
    if ((av as number) < (bv as number)) return ascending ? -1 : 1;
    if ((av as number) > (bv as number)) return ascending ? 1 : -1;
    return 0;
  });
  return copy;
}

// ── Display helpers ───────────────────────────────────────────────────────

/** fee_basis label: 'bid_amount' → 'Bid Amount', otherwise the raw value. */
export function feeBasisLabel(basis: string): string {
  return basis === 'bid_amount' ? 'Bid Amount' : basis;
}

/**
 * Effective-date label. Reproduces the static page exactly:
 *   new Date(value).toLocaleDateString()
 * (locale default format — no options object).
 */
export function formatEffectiveDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

/** A "default" rule applies to all states AND all trades (state and trade both empty). */
export function isDefaultRule(fee: Pick<FeeConfigRow, 'state' | 'trade'>): boolean {
  return !fee.state && !fee.trade;
}

/**
 * True when only one rule remains. The static page disables Delete and blocks
 * confirmDelete() in this case ("At least one rule must always exist").
 */
export function isLastRule(count: number): boolean {
  return count === 1;
}

// ── Fee % validation + parsing (UNCHANGED fee math) ──────────────────────────

/** parseFloat of the raw input — preserved exactly (NaN for empty/invalid). */
export function parseFeePct(raw: string): number {
  return parseFloat(raw);
}

/**
 * Valid when in [0, 50] and not NaN.
 * Mirrors the static guard: `isNaN(feePct) || feePct < 0 || feePct > 50` → invalid.
 */
export function isFeePctValid(value: number): boolean {
  return !Number.isNaN(value) && value >= 0 && value <= 50;
}

// ── Write payload (byte-identical to the static page's insert/update body) ───

export interface FeeConfigPayload {
  state: string | null;
  trade: string | null;
  fee_pct: number;
  fee_basis: string;
  effective_date: string;
}

export interface FeeFormInput {
  /** Raw state input value ('' → null). NOT upper-cased (static stores as typed). */
  state: string;
  /** Raw trade select value ('' → null). */
  trade: string;
  /** parseFloat'd fee percent — passed through unchanged. */
  feePct: number;
  feeBasis: string;
  /** 'yyyy-mm-dd' from the date input. */
  effectiveDate: string;
}

/**
 * Build the INSERT/UPDATE body. Identical shape + null-coercion to the static
 * page's handleSaveRule():
 *
 *   const state = stateInput.value || null;
 *   const trade = tradeInput.value || null;
 *   const data  = { state, trade, fee_pct: feePct, fee_basis: feeBasis,
 *                   effective_date: effectiveDate };
 *
 * fee_pct is forwarded verbatim — no rounding / rescaling / unit conversion.
 */
export function buildFeePayload(form: FeeFormInput): FeeConfigPayload {
  return {
    state: form.state || null,
    trade: form.trade || null,
    fee_pct: form.feePct,
    fee_basis: form.feeBasis,
    effective_date: form.effectiveDate,
  };
}
