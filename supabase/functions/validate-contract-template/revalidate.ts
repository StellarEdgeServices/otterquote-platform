// validate-contract-template/revalidate.ts — the RE-validation path (gh-1315).
//
// `validate-contract-template` writes a verdict once, against the manifest
// deployed that day, and nothing ever rechecks it. This module re-runs the
// IDENTICAL scan (manifest.ts / pdf-text.ts — the same functions the fresh path
// calls) over every contractor_templates row whose stored result is missing or
// was produced under a different manifest version, and either reports what
// would change (dry run) or writes it.
//
// Write rules, deliberately no wider than the fresh path's:
//   - validation_result is rewritten with the new scan.
//   - status is rewritten by the SAME D-199 state machine the fresh path uses
//     (allRequiredFound -> manual_validated if the row carries manual_overrides
//     else auto_validated; otherwise manual_mapping_pending). The fresh path
//     already writes status on every validation, so revalidation does too.
//   - A row whose PDF cannot be downloaded or parsed is NOT written (the fresh
//     path returns 404/422 and writes nothing); it is reported with `error`.
//   - manual_overrides are re-read from the row, never invented.
//
// Pure with respect to IO: the Supabase client, the extractor and the clock
// are injected so the unit test drives it with fakes and the operator can run
// the same function locally in dry-run with a service key (no deploy needed).

// deno-lint-ignore-file no-explicit-any
import { MANIFEST, manifestSlotFor, scanOptionalAnchors, scanRequiredAnchors } from "./manifest.ts";
import { describeMissingMarkers, detectFilledProposal, cancellationNoticeState } from "./starter-template.ts";
import {
  CONTRACT_PRICE_FIELD_ID,
  CURRENT_TEMPLATE_MANIFEST_VERSION,
  foundFieldIds,
  isTemplateUsable,
} from "./template-validity.ts";

export interface RevalidateOptions {
  supabase: any;
  dryRun: boolean;
  /** Re-run even rows whose stored manifestVersion already equals current. Default false. */
  force?: boolean;
  /** Restrict to these template ids (optional). */
  templateIds?: string[];
  extractPdfText: (bytes: Uint8Array) => Promise<string>;
  now?: () => Date;
  currentManifestVersion?: string;
}

export interface RevalidateRowReport {
  id: string;
  contractor_id: string | null;
  trade: string | null;
  funding_type: string | null;
  pdf_storage_path: string | null;
  before: { status: string | null; manifestVersion: string | null; usable: boolean; code: string | null };
  after: {
    status: string | null;
    manifestVersion: string | null;
    requiredFoundCount: number | null;
    requiredCount: number | null;
    allRequiredFound: boolean | null;
    contract_price_found: boolean | null;
    missing: string[];
    usable: boolean | null;
    code: string | null;
  } | null;
  status_would_change: boolean;
  written: boolean;
  error: string | null;
}

export interface RevalidateReport {
  ok: true;
  dryRun: boolean;
  currentManifestVersion: string;
  scanned: number;
  stale: number;
  written: number;
  wouldPass: number;
  wouldFail: number;
  errors: number;
  rows: RevalidateRowReport[];
}

/** Rows the pass touches: result missing, or produced under another manifest version. */
export function isStale(row: { validation_result?: any }, currentManifestVersion: string): boolean {
  const vr = row.validation_result;
  if (vr === null || vr === undefined || typeof vr !== "object") return true;
  return vr.manifestVersion !== currentManifestVersion;
}

/** The D-199 state machine, verbatim from the fresh path. */
export function nextStatus(allRequiredFound: boolean, manualOverrides: unknown): string {
  if (allRequiredFound) return manualOverrides ? "manual_validated" : "auto_validated";
  return "manual_mapping_pending";
}

export async function revalidateTemplates(opts: RevalidateOptions): Promise<RevalidateReport> {
  const current = opts.currentManifestVersion ?? CURRENT_TEMPLATE_MANIFEST_VERSION;
  const now = opts.now ?? (() => new Date());
  const { supabase, dryRun } = opts;

  let q = supabase
    .from("contractor_templates")
    .select("id, contractor_id, trade, funding_type, status, pdf_storage_path, validation_result, manual_overrides")
    .order("created_at", { ascending: true });
  if (opts.templateIds && opts.templateIds.length > 0) q = q.in("id", opts.templateIds);
  const { data: rows, error: loadErr } = await q;
  if (loadErr) throw new Error(`contractor_templates load failed: ${loadErr.message}`);

  const report: RevalidateReport = {
    ok: true,
    dryRun,
    currentManifestVersion: current,
    scanned: 0,
    stale: 0,
    written: 0,
    wouldPass: 0,
    wouldFail: 0,
    errors: 0,
    rows: [],
  };

  for (const tmpl of rows ?? []) {
    report.scanned++;
    if (!opts.force && !isStale(tmpl, current)) continue;
    report.stale++;

    const beforeU = isTemplateUsable(tmpl, current, { requireFieldIds: [CONTRACT_PRICE_FIELD_ID] });
    const rowReport: RevalidateRowReport = {
      id: tmpl.id,
      contractor_id: tmpl.contractor_id ?? null,
      trade: tmpl.trade ?? null,
      funding_type: tmpl.funding_type ?? null,
      pdf_storage_path: tmpl.pdf_storage_path ?? null,
      before: {
        status: tmpl.status ?? null,
        manifestVersion: typeof tmpl.validation_result?.manifestVersion === "string" ? tmpl.validation_result.manifestVersion : null,
        usable: beforeU.usable,
        code: beforeU.code,
      },
      after: null,
      status_would_change: false,
      written: false,
      error: null,
    };
    report.rows.push(rowReport);

    const tradeManifest = manifestSlotFor(tmpl.trade, tmpl.funding_type);
    if (!tradeManifest) {
      rowReport.error = `No manifest for ${tmpl.trade}/${tmpl.funding_type}`;
      report.errors++;
      continue;
    }

    // Download + extract — same calls, same failure semantics as the fresh path.
    let pdfText: string;
    try {
      const { data: pdfBlob, error: downloadErr } = await supabase.storage
        .from("contractor-templates")
        .download(tmpl.pdf_storage_path);
      if (downloadErr || !pdfBlob) {
        rowReport.error = `PDF not found in storage (${tmpl.pdf_storage_path}): ${downloadErr?.message ?? "no data"}`;
        report.errors++;
        continue;
      }
      pdfText = await opts.extractPdfText(new Uint8Array(await pdfBlob.arrayBuffer()));
    } catch (e: any) {
      rowReport.error = `Failed to parse PDF (${tmpl.pdf_storage_path}): ${e?.message ?? String(e)}`;
      report.errors++;
      continue;
    }

    const manualOverrides = tmpl.manual_overrides ?? undefined;
    const anchorResults = scanRequiredAnchors(pdfText, tradeManifest, manualOverrides);
    const optionalResults = scanOptionalAnchors(pdfText, tradeManifest);
    const requiredFoundCount = anchorResults.filter((a) => a.found).length;
    const allRequiredFound = requiredFoundCount === tradeManifest.required.length;

    const { data: ownRec } = await supabase
      .from("contractors")
      .select("company_name, address_line1, address_city")
      .eq("id", tmpl.contractor_id)
      .maybeSingle();

    const validationResult = {
      manifestVersion: MANIFEST.version,
      trade: tmpl.trade,
      funding_type: tmpl.funding_type,
      requiredCount: tradeManifest.requiredCount,
      requiredFoundCount,
      allRequiredFound,
      anchors: anchorResults,
      optional: optionalResults,
      missingMarkers: describeMissingMarkers(anchorResults),
      filledProposal: detectFilledProposal(pdfText, {
        companyName: ownRec?.company_name ?? null,
        addressLine1: ownRec?.address_line1 ?? null,
        addressCity: ownRec?.address_city ?? null,
      }),
      cancellationNotice: cancellationNoticeState(pdfText),
      assistApplied: null,
      validatedAt: now().toISOString(),
      // Provenance: this result came from the revalidation pass, not an upload.
      revalidated: { from: rowReport.before.manifestVersion, at: now().toISOString() },
    };
    const newStatus = nextStatus(allRequiredFound, manualOverrides);
    const afterU = isTemplateUsable(
      { ...tmpl, status: newStatus, validation_result: validationResult },
      current,
      { requireFieldIds: [CONTRACT_PRICE_FIELD_ID] },
    );
    rowReport.after = {
      status: newStatus,
      manifestVersion: MANIFEST.version,
      requiredFoundCount,
      requiredCount: tradeManifest.requiredCount,
      allRequiredFound,
      contract_price_found: foundFieldIds(validationResult).has(CONTRACT_PRICE_FIELD_ID),
      missing: anchorResults.filter((a) => !a.found).map((a) => a.field),
      usable: afterU.usable,
      code: afterU.code,
    };
    rowReport.status_would_change = newStatus !== tmpl.status;
    if (afterU.usable) report.wouldPass++;
    else report.wouldFail++;

    if (dryRun) continue;

    const { error: updateErr } = await supabase
      .from("contractor_templates")
      .update({ validation_result: validationResult, status: newStatus })
      .eq("id", tmpl.id);
    if (updateErr) {
      rowReport.error = `Failed to update template: ${updateErr.message}`;
      report.errors++;
      continue;
    }
    rowReport.written = true;
    report.written++;
  }

  return report;
}
