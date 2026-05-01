/**
 * OtterQuote Edge Function: refresh-warranty-manifest
 * D-202 Phase 3 — Quarterly warranty manifest refresh system.
 *
 * Scans all active warranty_options rows, diffs against manufacturer sources,
 * and inserts proposed changes into warranty_manifest_drift for admin review.
 * NO autonomous edits to warranty_options — all changes are admin-gated.
 *
 * Trigger: pg_cron quarterly (Jan 1, Apr 1, Jul 1, Oct 1 at 09:00 UTC)
 *          OR manual POST with {"force": true} to bypass dedup window.
 *
 * Idempotency: if any pending_review rows exist for a manufacturer, skip that
 * manufacturer. Re-running after all items are resolved produces a fresh set.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY")!;
const MAILGUN_DOMAIN = "mail.otterquote.com";
const ADMIN_EMAIL = "dustinstohler1@gmail.com";

// Minimum days between auto-triggered runs (dedup window).
// Manual trigger with {"force": true} bypasses this.
const DEDUP_WINDOW_DAYS = 80;

// Canonical warranty page URLs per manufacturer (source_url reference).
// These are the pages admins should check during manual review.
const MANUFACTURER_SOURCES: Record<string, string> = {
  "GAF": "https://www.gaf.com/en-us/roofing-products/residential-roofing/warranties",
  "Owens Corning": "https://www.owenscorning.com/en-us/roofing/warranties",
  "CertainTeed": "https://www.certainteed.com/roofing/homeowners/warranties/",
  "Tamko": "https://www.tamko.com/warranties",
  "Atlas": "https://www.atlasroofing.com/residential-roofing/warranties",
  "IKO": "https://www.iko.com/na/residential/warranties/",
  "Malarkey": "https://malarkeyroofing.com/warranties/",
  "PABCO": "https://www.pabcoroofing.com/residential/warranties/",
};

// GAF warranty tier names to look for on their warranty page.
// Used for programmatic diff. If the page stops listing these names,
// we fall back to no_source.
const GAF_KNOWN_TIER_PATTERNS = [
  /golden\s+pledge/i,
  /system\s+plus/i,
  /silver\s+pledge/i,
  /standard/i,
];

interface WarrantyOption {
  id: string;
  manufacturer: string;
  tier: string;
  display_string: string;
  program_name: string;
  source_url: string | null;
  cert_required: boolean;
  active: boolean;
}

interface DriftInsert {
  refresh_run_id: string;
  manufacturer: string;
  tier: string;
  warranty_option_id: string | null;
  current_value: Record<string, unknown>;
  proposed_value: Record<string, unknown> | null;
  change_type: "modified" | "added" | "deprecated" | "no_source";
  source_url: string | null;
  status: "pending_review";
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "https://otterquote.com",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let forceRun = false;
  try {
    const body = await req.json();
    forceRun = body?.force === true;
  } catch {
    // no body or not JSON — not an error
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  try {
    // ── Dedup check ──────────────────────────────────────────────────────────
    if (!forceRun) {
      const cutoff = new Date(
        Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();

      const { data: recentRun } = await sb
        .from("cron_health")
        .select("last_run_at, last_run_status")
        .eq("job_name", "warranty-manifest-refresh")
        .maybeSingle();

      const withinWindow = recentRun?.last_run_status === "success" &&
        recentRun?.last_run_at &&
        new Date(recentRun.last_run_at) >= new Date(cutoff);

      if (withinWindow) {
        console.log(
          `[refresh-warranty-manifest] Dedup: last successful run at ${recentRun.last_run_at}. ` +
            `Use {"force": true} to override.`
        );
        await logCronHealth(sb, "skipped_dedup", null);
        return new Response(
          JSON.stringify({
            status: "skipped",
            reason: "dedup_window",
            last_run: recentRun.last_run_at,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ── Load active warranty_options ─────────────────────────────────────────
    const { data: options, error: optErr } = await sb
      .from("warranty_options")
      .select("*")
      .eq("active", true)
      .order("manufacturer", { ascending: true });

    if (optErr) throw new Error(`Failed to load warranty_options: ${optErr.message}`);
    const allOptions = (options ?? []) as WarrantyOption[];

    // Group by manufacturer
    const byManufacturer: Record<string, WarrantyOption[]> = {};
    for (const opt of allOptions) {
      if (!byManufacturer[opt.manufacturer]) byManufacturer[opt.manufacturer] = [];
      byManufacturer[opt.manufacturer].push(opt);
    }

    // ── Check for existing open items per manufacturer ───────────────────────
    const { data: existingOpen } = await sb
      .from("warranty_manifest_drift")
      .select("manufacturer")
      .eq("status", "pending_review");

    const manufacturersWithOpenItems = new Set(
      (existingOpen ?? []).map((r: { manufacturer: string }) => r.manufacturer)
    );

    // ── Build drift rows ─────────────────────────────────────────────────────
    const driftRows: DriftInsert[] = [];
    let gafProgrammatic = false;

    for (const [manufacturer, opts] of Object.entries(byManufacturer)) {
      // Skip if open items already exist for this manufacturer (idempotent)
      if (manufacturersWithOpenItems.has(manufacturer)) {
        console.log(
          `[refresh-warranty-manifest] Skipping ${manufacturer}: open items already exist.`
        );
        continue;
      }

      const sourceUrl = MANUFACTURER_SOURCES[manufacturer] ?? null;

      if (manufacturer === "GAF") {
        // Attempt programmatic scrape for GAF
        const gafRows = await tryGafProgrammatic(
          runId,
          opts,
          sourceUrl
        );
        if (gafRows !== null) {
          driftRows.push(...gafRows);
          gafProgrammatic = true;
          continue;
        }
        // Fall through to no_source if scrape failed
        console.log("[refresh-warranty-manifest] GAF scrape failed — falling back to no_source.");
      }

      // All other manufacturers (and GAF fallback): no_source stub
      // One row per manufacturer (not per tier) — prompts admin to check the page
      driftRows.push({
        refresh_run_id: runId,
        manufacturer,
        tier: "ALL_TIERS",
        warranty_option_id: null,
        current_value: {
          manufacturer,
          tiers: opts.map((o) => ({
            id: o.id,
            tier: o.tier,
            display_string: o.display_string,
            program_name: o.program_name,
          })),
          tier_count: opts.length,
        },
        proposed_value: null,
        change_type: "no_source",
        source_url: sourceUrl,
        status: "pending_review",
      });
    }

    // ── Insert drift rows ────────────────────────────────────────────────────
    let insertedCount = 0;
    if (driftRows.length > 0) {
      const { error: insertErr } = await sb
        .from("warranty_manifest_drift")
        .insert(driftRows);
      if (insertErr) throw new Error(`Failed to insert drift rows: ${insertErr.message}`);
      insertedCount = driftRows.length;
    }

    // ── Log to cron_health ───────────────────────────────────────────────────
    await logCronHealth(sb, "success", null);

    // ── Send Mailgun notification ────────────────────────────────────────────
    if (insertedCount > 0) {
      await sendMailgunNotification(insertedCount, driftRows, gafProgrammatic);
    }

    console.log(
      `[refresh-warranty-manifest] Run ${runId} complete. ` +
        `${insertedCount} drift rows inserted.`
    );

    return new Response(
      JSON.stringify({
        status: "ok",
        run_id: runId,
        items_inserted: insertedCount,
        gaf_programmatic: gafProgrammatic,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[refresh-warranty-manifest] Error: ${message}`);
    await logCronHealth(sb, "error", message);
    return new Response(
      JSON.stringify({ error: message, run_id: runId }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

// ── GAF Programmatic Scrape ──────────────────────────────────────────────────
// Fetches GAF's warranty page and diffs tier names against active warranty_options.
// Returns an array of drift rows, or null if the scrape failed/inconclusive.
async function tryGafProgrammatic(
  runId: string,
  gafOptions: WarrantyOption[],
  sourceUrl: string | null
): Promise<DriftInsert[] | null> {
  const url = sourceUrl ?? "https://www.gaf.com/en-us/roofing-products/residential-roofing/warranties";
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "OtterQuotes-WarrantyMonitor/1.0 (quarterly manifest refresh; contact support@otterquote.com)",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.warn(`[refresh-warranty-manifest] GAF fetch returned ${resp.status}`);
      return null;
    }

    const html = await resp.text();
    const rows: DriftInsert[] = [];

    // Check each known GAF tier against the page content
    for (const opt of gafOptions) {
      const tierPattern = new RegExp(
        opt.program_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      const foundOnPage = tierPattern.test(html);

      if (!foundOnPage) {
        // Tier name not found on page — flag as potentially deprecated
        rows.push({
          refresh_run_id: runId,
          manufacturer: "GAF",
          tier: opt.tier,
          warranty_option_id: opt.id,
          current_value: {
            id: opt.id,
            manufacturer: opt.manufacturer,
            tier: opt.tier,
            display_string: opt.display_string,
            program_name: opt.program_name,
            cert_required: opt.cert_required,
          },
          proposed_value: null,
          change_type: "deprecated",
          source_url: url,
          status: "pending_review",
        });
      }
    }

    // If no issues found, check whether the page returned any of the known GAF tier patterns
    // If NONE of the known patterns appear, the page structure probably changed — return null (fallback to no_source)
    const anyKnownPatternFound = GAF_KNOWN_TIER_PATTERNS.some((p) => p.test(html));
    if (!anyKnownPatternFound) {
      console.warn("[refresh-warranty-manifest] GAF page structure may have changed — no known tier patterns found.");
      return null;
    }

    // If all tiers found and nothing looks deprecated, return an empty array
    // (no drift rows needed — nothing to flag for GAF this cycle)
    return rows;
  } catch (err) {
    console.warn(`[refresh-warranty-manifest] GAF scrape exception: ${err}`);
    return null;
  }
}

// ── Cron Health Logger ───────────────────────────────────────────────────────
async function logCronHealth(
  sb: ReturnType<typeof createClient>,
  status: string,
  errorMessage: string | null
) {
  try {
    await sb.rpc("record_cron_health", {
      p_job_name: "warranty-manifest-refresh",
      p_status: status,
      p_error: errorMessage ?? null,
    });
  } catch (e) {
    console.error("[refresh-warranty-manifest] Failed to log cron_health:", e);
  }
}

// ── Mailgun Notification ─────────────────────────────────────────────────────
async function sendMailgunNotification(
  count: number,
  rows: DriftInsert[],
  gafProgrammatic: boolean
) {
  const manufacturerBreakdown = Object.entries(
    rows.reduce((acc: Record<string, number>, r) => {
      acc[r.manufacturer] = (acc[r.manufacturer] ?? 0) + 1;
      return acc;
    }, {})
  )
    .map(([mfr, n]) => `  • ${mfr}: ${n} item(s)`)
    .join("\n");

  const body = [
    `Warranty Manifest Quarterly Review`,
    ``,
    `${count} item(s) flagged for your review.`,
    ``,
    `Breakdown:`,
    manufacturerBreakdown,
    ``,
    gafProgrammatic
      ? `GAF: programmatic scrape completed.`
      : `All manufacturers: manual review required (no_source).`,
    ``,
    `Review queue: https://otterquote.com/admin-warranty-drift.html`,
    ``,
    `No changes will be made to the warranty manifest until you approve them.`,
    ``,
    `— Otter Quotes Platform`,
  ].join("\n");

  try {
    const formData = new FormData();
    formData.append("from", "Otter Quotes Platform <no-reply@mail.otterquote.com>");
    formData.append("to", ADMIN_EMAIL);
    formData.append("subject", `Warranty Manifest Quarterly Review — ${count} item(s) flagged`);
    formData.append("text", body);

    const resp = await fetch(
      `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
        },
        body: formData,
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[refresh-warranty-manifest] Mailgun error ${resp.status}: ${errText}`);
    }
  } catch (e) {
    console.error("[refresh-warranty-manifest] Mailgun send failed:", e);
  }
}
