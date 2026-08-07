// ============================================================================
// _shared/roofing-scope.ts — Roofing SOW Line-Item Catalog v1.0 + frozen-scope
// generator (Exhibit A Section 1). Issue #588 Phase 2.
//
// Catalog authority: `Stellar Edge Services/Otter Quotes/Docs/
// roofing-sow-line-item-catalog-v1.0-LOCKED-2026-07-31.md` (Dustin workspace),
// as amended by the 2026-07-31 LOCK comment on #588:
//   1. Section 1 quantities are PURE MEASURED values — NO waste multipliers.
//      Contractor declares a single waste % as a bid parameter; SQ-material
//      rows compute install quantity = measured × (1 + waste) at RENDER time.
//      The freeze/hash covers measured values only.
//   2. NO code-determination logic anywhere. Ice & water (eaves) is an
//      options-layer contractor-declared row in ALL states (risk-accepted).
//   3. 13 base rows (ridge vent always base; permit is a quantity row).
//      Starter strip is NOT a base row — it is a contractor-declared
//      options-layer row at BOTH eaves and rakes (Call B, resolved
//      2026-08-07 / D-273; corrects this file's original 14-row draft,
//      which had eaves-starter as base and rakes-starter as an option).
//   4. Chimney work removed from base — contractor Section 3 territory.
//
// Locked decisions #1/#4 (2026-07-30): scope is measurement-derived, generated
// once when the report parses; Section 1 is FROZEN — structured JSON + content
// hash, never recomputed, rendered verbatim everywhere it appears.
//
// Transcribed and verified against the workspace LOCKED catalog file
// (roofing-sow-line-item-catalog-v1.0-LOCKED-2026-07-31.md, incl. its
// 2026-08-07 Call B correction) by the local Code session that applied
// this PR's pending patch payloads:
//   - Note rows N1–N4 verbatim text (DISCLOSURE_PLACEHOLDERS below).
//   - Ridge-vent measured basis (combined ridges/hips is used here — Hover does
//     not split ridge from hip; flagged in the row note).
//   - Which rows carry sq_material (install-quantity waste): field shingles +
//     synthetic underlayment here; tear-off deliberately excluded (you tear off
//     what exists — measured, not install, quantity).
// ============================================================================

export const CATALOG_VERSION = "roofing-v1.0-locked-2026-07-31";
export const SCOPE_SCHEMA = "sow-section1@1";

export interface MeasuredInputs {
  roof_area_sf: number | null;
  squares: number | null;
  ridge_hip_lf: number | null;
  valley_lf: number | null;
  rake_lf: number | null;
  eave_lf: number | null;
  drip_edge_perimeter_lf: number | null;
  step_flashing_lf: number | null;
  flashing_lf: number | null;
  predominant_pitch: string | null;
}

export interface ScopeRow {
  row_id: string;
  num: number;
  item: string;
  measured_qty: number | null;
  unit: string;
  basis: string;           // which measured field(s) the quantity derives from
  notes: string;
  sq_material: boolean;    // install qty = measured × (1 + declared waste) at render
  qty_source: "measured" | "project_confirmation" | "fixed";
}

// N1–N4 note rows, transcribed verbatim from the LOCKED catalog file's
// "Standard note rows" section. These render as scope notes and are part of
// the frozen record.
export const DISCLOSURE_PLACEHOLDERS: string[] = [
  "Roof decking inspected at tear-off; replacement of rotten/damaged decking handled as a change order under the contract's change-order provision.",
  "Predominant pitch shown in the measurement summary header (informational).",
  "The measurements contained in this Statement of Work were provided to Contractor on behalf of Customer. Both parties have relied upon the accuracy of this information in negotiating the terms of this Agreement. Prior to starting the work set forth in this agreement, either party shall have the right to perform his or her own measurements to verify the measurements contained herein. If any measurement in this statement of work is off by more than 10%, either party shall have the right to: (1) negotiate a change order to adjust the compensation due under the Agreement; (2) cancel the Agreement; or (3) proceed under the terms set forth in the Agreement.",
  "Second-layer tear-off remains a D-163 contingency field, not a scope row.",
];

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

/** Normalize any hover_measurements-shaped object into MeasuredInputs. */
export function normalizeMeasuredInputs(hm: Record<string, unknown> | null | undefined): MeasuredInputs {
  const m = hm ?? {};
  const roofAreaSf = num(m["roof_area_sf"]);
  let squares = num(m["squares"]);
  if (squares == null && roofAreaSf != null) squares = Math.round((roofAreaSf / 100) * 10) / 10;
  return {
    roof_area_sf: roofAreaSf,
    squares,
    ridge_hip_lf: num(m["ridge_hip_lf"]),
    valley_lf: num(m["valley_lf"]),
    rake_lf: num(m["rake_lf"]),
    eave_lf: num(m["eave_lf"]),
    drip_edge_perimeter_lf: num(m["drip_edge_perimeter_lf"]),
    step_flashing_lf: num(m["step_flashing_lf"]),
    flashing_lf: num(m["flashing_lf"]),
    predominant_pitch: typeof m["predominant_pitch"] === "string" ? (m["predominant_pitch"] as string) : null,
  };
}

/**
 * Catalog v1.0 base rows — PURE measured quantities, no multipliers of any
 * kind (amendment #1), no code-determination logic (amendment #2).
 * A null measured_qty renders as "per field count" / "per project
 * confirmation" — it is still a locked-included row (decision #2: contractors
 * may not alter or remove a line).
 */
export function buildBaseRows(m: MeasuredInputs): ScopeRow[] {
  return [
    { row_id: "tear_off", num: 1, item: "Tear off & dispose existing roofing (all layers)",
      measured_qty: m.squares, unit: "SQ", basis: "Measured roof area",
      notes: "Haul-off in row 14", sq_material: false, qty_source: "measured" },
    { row_id: "underlayment_synthetic", num: 2, item: "Synthetic underlayment (full coverage)",
      measured_qty: m.squares, unit: "SQ", basis: "Measured roof area",
      notes: "Install qty per declared waste", sq_material: true, qty_source: "measured" },
    { row_id: "iw_valleys", num: 3, item: "Ice & water shield - valleys",
      measured_qty: m.valley_lf, unit: "LF", basis: "Measured valleys",
      notes: "Valleys only (I&W at eaves is a contractor-declared option)", sq_material: false, qty_source: "measured" },
    { row_id: "drip_edge", num: 4, item: "Drip edge",
      measured_qty: m.drip_edge_perimeter_lf, unit: "LF", basis: "Measured perimeter",
      notes: "Eaves & rakes", sq_material: false, qty_source: "measured" },
    { row_id: "field_shingles", num: 5, item: "Architectural laminate field shingles",
      measured_qty: m.squares, unit: "SQ", basis: "Measured roof area",
      notes: "Brand per bid; install qty per declared waste", sq_material: true, qty_source: "measured" },
    { row_id: "hip_ridge_standard", num: 6, item: "Hip & ridge cap shingles (standard profile)",
      measured_qty: m.ridge_hip_lf, unit: "LF", basis: "Measured ridges/hips",
      notes: "High-profile cap is a contractor-declared option", sq_material: false, qty_source: "measured" },
    { row_id: "valley_closed_cut", num: 7, item: "Closed-cut valley treatment (default)",
      measured_qty: m.valley_lf, unit: "LF", basis: "Measured valleys",
      notes: "Open-metal W-valley is a contractor-declared option", sq_material: false, qty_source: "measured" },
    { row_id: "step_flashing", num: 8, item: "Step flashing (roof-to-wall)",
      measured_qty: m.step_flashing_lf, unit: "LF", basis: "Measured step flashing",
      notes: "Replace", sq_material: false, qty_source: "measured" },
    { row_id: "headwall_flashing", num: 9, item: "Headwall / apron flashing",
      measured_qty: m.flashing_lf, unit: "LF", basis: "Measured flashing",
      notes: "Replace", sq_material: false, qty_source: "measured" },
    { row_id: "pipe_boots", num: 10, item: "Pipe boots / penetration flashings",
      measured_qty: null, unit: "EA", basis: "Project-confirmation count",
      notes: "Count confirmed at project confirmation", sq_material: false, qty_source: "project_confirmation" },
    { row_id: "ridge_vent", num: 11, item: "Ridge vent",
      measured_qty: m.ridge_hip_lf, unit: "LF", basis: "Measured ridges/hips (combined)",
      notes: "Hover reports ridges+hips combined; vented ridge length field-verified", // [SPEC-VERIFY] basis
      sq_material: false, qty_source: "measured" },
    { row_id: "permit", num: 12, item: "Building permit",
      measured_qty: 1, unit: "EA", basis: "Fixed",
      notes: "Quantity row; jurisdiction fees per bid", sq_material: false, qty_source: "fixed" },
    { row_id: "cleanup_haul_off", num: 13, item: "Site cleanup, magnetic sweep & haul-off",
      measured_qty: 1, unit: "LS", basis: "Fixed",
      notes: "Includes debris disposal", sq_material: false, qty_source: "fixed" },
  ];
}

/** Canonical JSON: recursively key-sorted, no whitespace — stable hash input. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface FrozenScope {
  schema: string;
  catalog_version: string;
  trade: "roofing";
  source: string; // 'pdf_parse' | 'hover_api'
  measurements: MeasuredInputs;
  rows: ScopeRow[];
  disclosures: string[];
}

/** The hash covers measured values + rows + catalog version ONLY (amendment #1). */
export async function hashScope(scope: FrozenScope): Promise<string> {
  return await sha256Hex(canonicalJson({
    catalog_version: scope.catalog_version,
    trade: scope.trade,
    measurements: scope.measurements,
    rows: scope.rows,
    disclosures: scope.disclosures,
  }));
}

export function buildScope(hm: Record<string, unknown>, source: string): FrozenScope {
  const measurements = normalizeMeasuredInputs(hm);
  return {
    schema: SCOPE_SCHEMA,
    catalog_version: CATALOG_VERSION,
    trade: "roofing",
    source,
    measurements,
    rows: buildBaseRows(measurements),
    disclosures: DISCLOSURE_PLACEHOLDERS,
  };
}

/**
 * Freeze Exhibit A Section 1 for a claim — generate-once semantics
 * (decision #1/#4): if an active scope_records row exists for the claim+trade,
 * return it untouched; otherwise insert version 1. NEVER recomputes.
 *
 * Returns { record, created } or throws on DB failure (callers surface
 * loudly — Phase 1 fail-loud requirement).
 */
// deno-lint-ignore no-explicit-any
export async function freezeScopeForClaim(supabase: any, claimId: string, hm: Record<string, unknown>, source: string): Promise<{ record: Record<string, unknown>; created: boolean }> {
  const { data: existing, error: selErr } = await supabase
    .from("scope_records")
    .select("id, claim_id, trade, catalog_version, scope_json, content_hash, version, generated_at")
    .eq("claim_id", claimId)
    .eq("trade", "roofing")
    .is("superseded_at", null)
    .maybeSingle();
  if (selErr) throw new Error(`scope_records read failed: ${selErr.message}`);
  if (existing) return { record: existing, created: false };

  const scope = buildScope(hm, source);
  const contentHash = await hashScope(scope);
  const { data: inserted, error: insErr } = await supabase
    .from("scope_records")
    .insert({
      claim_id: claimId,
      trade: "roofing",
      catalog_version: CATALOG_VERSION,
      scope_json: scope,
      content_hash: contentHash,
      version: 1,
      source,
    })
    .select("id, claim_id, trade, catalog_version, scope_json, content_hash, version, generated_at")
    .single();
  if (insErr) {
    // Unique-violation race (two parsers freezing simultaneously): re-read the
    // winner instead of failing — the freeze exists either way.
    if (String(insErr.code) === "23505") {
      const { data: winner, error: reErr } = await supabase
        .from("scope_records")
        .select("id, claim_id, trade, catalog_version, scope_json, content_hash, version, generated_at")
        .eq("claim_id", claimId).eq("trade", "roofing").is("superseded_at", null).maybeSingle();
      if (!reErr && winner) return { record: winner, created: false };
    }
    throw new Error(`scope_records insert failed: ${insErr.message}`);
  }
  return { record: inserted, created: true };
}

/** Map the Hover API measurements.json shape into hover_measurements keys.
 *  Mirrors the fallback mapping in create-docusign-envelope. */
// deno-lint-ignore no-explicit-any
export function mapHoverApiMeasurements(mj: any): Record<string, unknown> | null {
  if (!mj || typeof mj !== "object") return null;
  const s0 = mj?.structures?.[0] ?? {};
  const pick = (...vals: unknown[]) => {
    for (const v of vals) { const n = num(v); if (n != null) return n; }
    return null;
  };
  const roofAreaSf = pick(s0?.areas?.roof, mj?.total_sq_ft, mj?.total_area_sq_ft, mj?.roof_area_sq_ft, mj?.measurements?.total_area);
  const eaves = pick(s0?.eaves, mj?.eaves, mj?.eaves_length, mj?.eave_length);
  const out: Record<string, unknown> = {
    roof_area_sf: roofAreaSf != null ? Math.round(roofAreaSf) : null,
    squares: roofAreaSf != null ? Math.round((roofAreaSf / 100) * 10) / 10 : null,
    ridge_hip_lf: pick(s0?.ridges_hips, mj?.ridges_hips, mj?.ridge_hip_length),
    valley_lf: pick(s0?.valleys, mj?.valleys, mj?.valley_length),
    rake_lf: pick(s0?.rakes, mj?.rakes, mj?.rake_length),
    eave_lf: eaves,
    drip_edge_perimeter_lf: pick(s0?.drip_edge, mj?.drip_edge, mj?.drip_edge_length, mj?.perimeter_ft, mj?.measurements?.perimeter),
    step_flashing_lf: pick(s0?.step_flashing, mj?.step_flashing, mj?.step_flashing_length),
    flashing_lf: pick(s0?.flashing, mj?.flashing, mj?.flashing_length),
    predominant_pitch: (s0?.pitch ?? mj?.primary_pitch ?? mj?.pitch) != null ? String(s0?.pitch ?? mj?.primary_pitch ?? mj?.pitch) : null,
  };
  const any = Object.entries(out).some(([k, v]) => k !== "predominant_pitch" && v != null) || out.predominant_pitch != null;
  return any ? out : null;
}

/** Install quantity for an sq_material row under the contractor's declared
 *  waste % (render-time only — never part of the frozen record). One-decimal
 *  rounding matches the locked spec example: 33.4 SQ @ 10% → 36.7 SQ. */
export function installQty(measured: number, declaredWastePct: number): number {
  return Math.round(measured * (1 + declaredWastePct / 100) * 10) / 10;
}
