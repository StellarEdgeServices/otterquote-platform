// =============================================================
// scrape-manufacturer-certs — D-204 cert verification scraper
// Session 465, May 1, 2026 (chain terminus, soft mode launch)
//
// Single Edge Function with per-manufacturer modules dispatched by body.manufacturer.
// GAF module is the pilot. OC, CT, Atlas, IKO, Malarkey, PABCO ship as stubs that
// write status='scrape_failed' rows so contractors surface in the admin queue.
// Tamko is excluded (no public lookup per D-202 v2 manifest).
//
// Triggers:
//   - Weekly pg_cron at 0 4 * * 0 (Sundays 4 AM ET) → body { manufacturer: 'all' }
//   - Manual: { manufacturer: 'GAF' | 'Owens Corning' | ... }
//   - Single contractor: { manufacturer, contractor_id }
//   - Health-check: { health_check: true }
//
// Idempotency: if a 'verified' row exists for (contractor, mfr, cert) and verified_at
// is within 90 days, skip. Otherwise write a fresh row.
//
// robots.txt: each module fetches /robots.txt first; if locator path is disallowed,
// writes status='blocked_by_robots'.
// =============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FN_VERSION = "v1.0.0-soft";

interface Contractor {
  id: string;
  company_name: string;
  primary_zip?: string | null;
  zip_code?: string | null;
}

interface ScrapeResult {
  status: "verified" | "scrape_failed" | "blocked_by_robots" | "pending";
  source_url?: string;
  notes?: string;
  cert_name?: string;
}

// ---------- robots.txt helper ----------
async function isAllowed(host: string, pathname: string): Promise<boolean> {
  try {
    const r = await fetch(`https://${host}/robots.txt`, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "OtterQuoteCertVerifier/1.0 (+https://otterquote.com)" },
    });
    if (!r.ok) return true; // no robots.txt — assume allowed
    const txt = await r.text();
    // Naive parse: scan for a User-agent: * block and any Disallow that prefixes pathname
    const lines = txt.split(/\r?\n/);
    let inBlock = false;
    let disallowed: string[] = [];
    for (const raw of lines) {
      const line = raw.split("#")[0].trim();
      if (!line) continue;
      const m = line.match(/^([A-Za-z-]+)\s*:\s*(.+)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === "user-agent") {
        inBlock = val === "*";
        if (inBlock) disallowed = [];
      } else if (inBlock && key === "disallow" && val) {
        disallowed.push(val);
      }
    }
    for (const d of disallowed) {
      if (pathname.startsWith(d)) return false;
    }
    return true;
  } catch (_e) {
    // Network blip — be conservative and treat as allowed (single-attempt; will retry next run).
    return true;
  }
}

// ---------- GAF (PILOT — public Certified/Master Elite lookup) ----------
async function scrapeGAF(c: Contractor, certName: string): Promise<ScrapeResult> {
  const host = "www.gaf.com";
  const path = "/en-us/roofing/contractors";
  const allowed = await isAllowed(host, path);
  if (!allowed) {
    return { status: "blocked_by_robots", source_url: `https://${host}${path}`, notes: "robots.txt disallows /en-us/roofing/contractors" };
  }
  // GAF's locator is a JS SPA backed by an internal search API. From a Deno EF we can't
  // execute the SPA; we attempt the public HTML page with the company name as a query param
  // and string-match. If we cannot find a hit, write scrape_failed and let the admin-upload
  // path take over. This is intentional — see D-204 architectural notes.
  const zip = c.primary_zip || c.zip_code || "";
  const url = `https://${host}${path}?q=${encodeURIComponent(c.company_name)}${zip ? `&zip=${encodeURIComponent(zip)}` : ""}`;
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "OtterQuoteCertVerifier/1.0 (+https://otterquote.com)" },
    });
    if (!r.ok) {
      return { status: "scrape_failed", source_url: url, notes: `GAF HTTP ${r.status}` };
    }
    const html = await r.text();
    const haystack = html.toLowerCase();
    const needle = c.company_name.toLowerCase();
    const certNeedle = certName.toLowerCase();
    if (haystack.includes(needle) && haystack.includes(certNeedle)) {
      return { status: "verified", source_url: url, cert_name: certName, notes: "GAF lookup contains both company name and cert tier on result page" };
    }
    return { status: "scrape_failed", source_url: url, notes: "GAF page loaded but did not contain company name + cert tier (likely SPA-rendered; admin upload required)" };
  } catch (e) {
    return { status: "scrape_failed", source_url: url, notes: `GAF fetch error: ${(e as Error).message}` };
  }
}

// ---------- Stub modules (admin queue surface) ----------
function stubModule(host: string, path: string, mfr: string) {
  return async (_c: Contractor, _certName: string): Promise<ScrapeResult> => ({
    status: "scrape_failed",
    source_url: `https://${host}${path}`,
    notes: `${mfr} scraper module not implemented in v1.0.0-soft — admin upload required (D-204 soft-mode default)`,
  });
}

const SCRAPERS: Record<string, (c: Contractor, certName: string) => Promise<ScrapeResult>> = {
  "GAF": scrapeGAF,
  "Owens Corning": stubModule("www.owenscorning.com", "/roofing/find-a-contractor", "Owens Corning"),
  "CertainTeed": stubModule("www.certainteed.com", "/find-a-pro", "CertainTeed"),
  "Atlas": stubModule("www.atlasroofing.com", "/contractors", "Atlas"),
  "IKO": stubModule("www.iko.com", "/", "IKO"),
  "Malarkey": stubModule("www.malarkeyroofing.com", "/contractor-locator", "Malarkey"),
  "PABCO": stubModule("www.pabcoroofing.com", "/", "PABCO"),
  // Tamko intentionally excluded — no public lookup (D-202 v2)
};

// ---------- Idempotency ----------
async function shouldSkip(sb: ReturnType<typeof createClient>, contractorId: string, mfr: string, certName: string): Promise<boolean> {
  const { data, error } = await sb
    .from("contractor_cert_verifications")
    .select("verified_at")
    .eq("contractor_id", contractorId)
    .eq("manufacturer", mfr)
    .eq("cert_name", certName)
    .eq("status", "verified")
    .maybeSingle();
  if (error || !data?.verified_at) return false;
  const ageDays = (Date.now() - new Date(data.verified_at).getTime()) / (1000 * 60 * 60 * 24);
  return ageDays < 90;
}

// ---------- Targets: contractors with claimed-but-not-yet-verified certs ----------
// We pull the universe of (contractor_id, manufacturer, cert_name) candidates from
// contractor_cert_verifications rows that are NOT 'verified' (i.e., pending /
// scrape_failed / blocked_by_robots / rejected) — the scraper only retries existing
// claims, it does not invent new ones. Profile UI is the only entry point that creates
// a 'pending' row.
async function targetsForManufacturer(sb: ReturnType<typeof createClient>, mfr: string, contractorId?: string) {
  let q = sb
    .from("contractor_cert_verifications")
    .select("contractor_id, manufacturer, cert_name, contractors!inner(id, company_name, primary_zip, zip_code, status)")
    .eq("manufacturer", mfr)
    .neq("status", "verified")
    .neq("status", "rejected")
    .eq("contractors.status", "active");
  if (contractorId) q = q.eq("contractor_id", contractorId);
  const { data, error } = await q;
  if (error) {
    console.error("[D-204] targetsForManufacturer error:", error);
    return [];
  }
  return (data || []) as Array<{
    contractor_id: string;
    manufacturer: string;
    cert_name: string;
    contractors: Contractor;
  }>;
}

async function processManufacturer(
  sb: ReturnType<typeof createClient>,
  mfr: string,
  contractorId?: string,
): Promise<{ mfr: string; processed: number; verified: number; failed: number; blocked: number; skipped: number }> {
  const scraper = SCRAPERS[mfr];
  if (!scraper) return { mfr, processed: 0, verified: 0, failed: 0, blocked: 0, skipped: 0 };

  const targets = await targetsForManufacturer(sb, mfr, contractorId);
  let verified = 0, failed = 0, blocked = 0, skipped = 0;

  for (const t of targets) {
    if (await shouldSkip(sb, t.contractor_id, t.manufacturer, t.cert_name)) {
      skipped++;
      continue;
    }
    const result = await scraper(t.contractors, t.cert_name);
    const verifiedAt = result.status === "verified" ? new Date().toISOString() : null;
    const expiresAt = result.status === "verified"
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const { error } = await sb.from("contractor_cert_verifications").insert({
      contractor_id: t.contractor_id,
      manufacturer: mfr,
      cert_name: t.cert_name,
      status: result.status,
      source: "public_lookup",
      source_url: result.source_url || null,
      verified_at: verifiedAt,
      expires_at: expiresAt,
      notes: result.notes || null,
    });
    if (error) {
      // Unique-index conflict on a verified retry is a no-op for soft mode.
      console.warn("[D-204] insert conflict:", error.message);
      continue;
    }
    if (result.status === "verified") verified++;
    else if (result.status === "blocked_by_robots") blocked++;
    else failed++;
  }

  return { mfr, processed: targets.length, verified, failed, blocked, skipped };
}

// ---------- Entrypoint ----------
Deno.serve(async (req) => {
  const startedAt = Date.now();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  if (body.health_check) {
    return new Response(JSON.stringify({ ok: true, fn: "scrape-manufacturer-certs", version: FN_VERSION }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const requestedMfr = (body.manufacturer as string | undefined) || "all";
  const contractorId = body.contractor_id as string | undefined;

  const targets = requestedMfr === "all" ? Object.keys(SCRAPERS) : [requestedMfr];

  const results = [];
  for (const m of targets) {
    if (!SCRAPERS[m]) {
      results.push({ mfr: m, error: "no_scraper_for_manufacturer" });
      continue;
    }
    try {
      results.push(await processManufacturer(sb, m, contractorId));
    } catch (e) {
      results.push({ mfr: m, error: (e as Error).message });
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    version: FN_VERSION,
    requested: requestedMfr,
    contractor_id: contractorId || null,
    elapsed_ms: Date.now() - startedAt,
    results,
  }), { headers: { "Content-Type": "application/json" } });
});
