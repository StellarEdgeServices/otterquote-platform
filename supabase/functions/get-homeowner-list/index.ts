/**
 * OtterQuote Edge Function: get-homeowner-list
 *
 * gh-1653 — Homeowner tracking on the admin PWA. Dustin: "I need a way to
 * track homeowners. That's not there yet."
 *
 * admin-homeowners.html needs ONE ROW PER CLAIM with the homeowner's identity
 * (name or email as held), a plainly-worded status, created_at, and how long
 * the claim has sat at its current status. claims already carries an admin
 * SELECT policy (claims_admin_select, is_admin_email()) so the page could
 * read claims directly — but the homeowner's identity lives on profiles,
 * which has NO admin RLS read policy (verified live 2026-09-04: 0 of 5 real
 * claims carry claims.homeowner_name; every one has profiles.full_name +
 * email). Same reason get-payout-completion-status and
 * get-business-lines-dashboard exist: the join happens here with the service
 * role behind the admin allow-list, and only the joined, per-claim row
 * crosses the wire — never a raw profiles row.
 *
 * Dwell ("days at current status") is computed HERE, never client-side —
 * it is the product this list exists to show. Basis: claims.updated_at.
 * Neither a status-changed timestamp on claims nor a status-change
 * activity_log event exists (see rows.ts HomeownerRow.dwell_basis for the
 * verification and the lower-bound caveat); the response says so in
 * `dwell_basis` and the page labels the number "since last change".
 *
 * ── gh-1796 — loss-sheet queue (Dustin's ruling on #1597, 2026-09-07) ──────
 * "I want the system to identify people who need their loss sheets and bring
 * them to my attention in the administrative dashboard. This will need to be
 * part of the homeowner tracking process." So it is part of THIS list, not a
 * second page: every row now carries a `loss_sheet` state
 * (missing | uploaded_unreviewed | reviewed) plus the upload date and a link.
 *
 * Two impure inputs the pure rows.ts cannot produce, both done here with the
 * service role, both bounded:
 *
 *   1. UPLOAD DATE. There is no upload-timestamp column on claims, so the date
 *      is `storage.objects.created_at` for the object at
 *      `claims.estimate_filename`. The `storage` schema is NOT exposed through
 *      PostgREST, so this cannot be a join — it is one Storage `list()` per
 *      distinct `<user_id>/<claim_id>/` prefix, run at a fixed concurrency and
 *      hard-capped (see LOSS_SHEET_DIR_CAP). Rows past the cap fall back to
 *      `loss_sheet_parsed_at`, and every row reports which basis it used.
 *
 *   2. DOCUMENT LINK. There is NO admin SELECT policy on `claim-documents`
 *      (verified live 2026-09-07 — the only non-service-role SELECT policies on
 *      that bucket are "Users can view own files" and "Contractors can view
 *      biddable claim docs"). The admin page therefore CANNOT mint its own
 *      signed URL; if it tried, every link would 400. The URLs are minted here
 *      under "Service role full access claim docs", and ONLY for rows still in
 *      the queue (uploaded_unreviewed) — a reviewed row needs no link, and
 *      minting one for every claim would grow unbounded for no purpose.
 *
 * Still read-only: no writes, no schema change, no other EF touched. Setting
 * the reviewed marker is a separate function, mark-loss-sheet-reviewed.
 *
 * ── gh-1570 Part 3 ─────────────────────────────────────────────────────────
 * Each row also carries `checklist_complete`: true when that claim has
 * written the `checklist_complete` activity_log event (dashboard.html, on
 * the homeowner side of #1570). admin-homeowners.html uses it together with
 * `status === 'documents_needed'` for a third view — homeowners who did
 * everything asked of them and never clicked "Submit for Bids". Resolved the
 * same way the loss-sheet upload dates are: one activity_log read here,
 * reduced in JS (see the read-and-reduce note above its query), then handed
 * to buildRows() alongside the existing uploadedAtByPath map.
 *
 * Input:  POST {}  (body unused — reserved)
 * Output: { ok: true, generated_at, dwell_basis: "updated_at",
 *           loss_sheet_queue: { missing, uploaded_unreviewed, reviewed },
 *           loss_sheet_uploaded_at_basis_note, loss_sheet_dir_lookups,
 *           rows: HomeownerRow[] }  // each row also carries checklist_complete
 *         rows sorted longest-dwell first; is_test rows INCLUDED (the page
 *         hides them by default — a display filter, not a refetch).
 *
 * Auth: requires a valid Supabase JWT with email in the admin allow-list.
 * verify_jwt = false (see supabase/config.toml) — auth is performed
 * in-handler, same pattern as get-payout-completion-status /
 * get-business-lines-dashboard.
 *
 * GitHub: #1653, #1796
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { buildRows, isMigrationPendingError, type ClaimIn, type HomeownerRow, type ProfileIn } from "./rows.ts";

const FUNCTION_NAME = "get-homeowner-list";
// gh-1534: kept in sync with supabase/functions/_shared/admin.ts ADMIN_EMAILS — do not
// edit this array without updating that file too (deploy path does not resolve imports).
const ADMIN_EMAILS  = ["dustinstohler1@gmail.com", "dustin@otterquote.com"];

const LOSS_SHEET_BUCKET = "claim-documents";
/**
 * gh-1796 — bound on the storage lookups. One `list()` per distinct
 * `<user_id>/<claim_id>/` prefix that has a loss sheet, newest claims first;
 * beyond this many prefixes the remaining rows fall back to
 * `loss_sheet_parsed_at` and say so in `loss_sheet_uploaded_at_basis`. Chosen
 * so the page can never turn into an unbounded fan-out as claim volume grows:
 * an admin refresh is worth a few hundred cheap metadata reads, not thousands.
 */
const LOSS_SHEET_DIR_CAP = 250;
/** Parallelism for those lookups. */
const LOSS_SHEET_CONCURRENCY = 6;
/** Signed-URL lifetime for a loss sheet the admin opens from the queue. */
const LOSS_SHEET_URL_TTL_SECONDS = 3600;

/**
 * gh-1570 Part 3 REVIEW FIX — PostgREST caps rows server-side (db-max-rows)
 * on ANY query, filtered or not; get-business-lines-dashboard/index.ts's
 * fetchAllActivity() documents this for an unfiltered activity_log read, and
 * an .eq("event_type", ...) filter does not exempt a query from the same
 * cap. Page size and max pages are generous for what is, today, a small
 * filtered slice — the point is correctness at any volume, not the current
 * row count.
 */
const CHECKLIST_COMPLETE_PAGE = 1000;
const CHECKLIST_COMPLETE_MAX_PAGES = 50;

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Directory part of a bucket-relative object path ("" when at bucket root). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

interface ChecklistCompleteRow {
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * gh-1570 Part 3 REVIEW FIX — read every `checklist_complete` activity_log
 * row, paginated. Same idiom as get-business-lines-dashboard/index.ts's
 * fetchAllActivity(): the cursor advances by `rows.length` (what the server
 * actually returned), NOT by CHECKLIST_COMPLETE_PAGE — a short-page stop
 * test breaks the moment the server's real cap is smaller than the page
 * size requested, silently dropping every row past it (that file's own
 * comment on why, verbatim-applicable here). Stops on an empty page;
 * `truncated: true` if CHECKLIST_COMPLETE_MAX_PAGES is exhausted first,
 * which the caller must surface rather than silently return a partial set.
 * `order("created_at", { ascending: true })` also makes the FIRST row seen
 * for a given claim id the earliest completion — the timestamp Part 3's
 * "sorted oldest first" queue needs.
 */
async function fetchChecklistCompleteRows(
  // deno-lint-ignore no-explicit-any
  db: any,
): Promise<{ rows: ChecklistCompleteRow[]; truncated: boolean; error: string | null }> {
  const all: ChecklistCompleteRow[] = [];
  let from = 0;
  for (let page = 0; page < CHECKLIST_COMPLETE_MAX_PAGES; page++) {
    const { data, error } = await db
      .from("activity_log")
      .select("metadata, created_at")
      .eq("event_type", "checklist_complete")
      .order("created_at", { ascending: true })
      .range(from, from + CHECKLIST_COMPLETE_PAGE - 1);
    if (error) return { rows: [], truncated: false, error: error.message };
    const rows = (data ?? []) as ChecklistCompleteRow[];
    if (rows.length === 0) return { rows: all, truncated: false, error: null };
    all.push(...rows);
    from += rows.length;
  }
  return { rows: all, truncated: true, error: null };
}

/**
 * gh-1796 — path -> storage object created_at for every loss sheet we can
 * afford to look up. A failed or capped lookup is simply absent from the map;
 * rows.ts then falls back and labels the basis. Never throws.
 */
async function buildUploadedAtIndex(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  paths: string[],
): Promise<{ index: Map<string, string>; dirLookups: number; capped: boolean }> {
  const index = new Map<string, string>();
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const d = dirOf(p);
    const list = byDir.get(d);
    if (list) list.push(p);
    else byDir.set(d, [p]);
  }

  const dirs = [...byDir.keys()];
  const capped = dirs.length > LOSS_SHEET_DIR_CAP;
  const dirsToRead = capped ? dirs.slice(0, LOSS_SHEET_DIR_CAP) : dirs;

  await mapLimited(dirsToRead, LOSS_SHEET_CONCURRENCY, async (dir) => {
    try {
      const { data, error } = await supabase.storage.from(LOSS_SHEET_BUCKET).list(dir, { limit: 100 });
      if (error || !Array.isArray(data)) {
        console.warn(`[${FUNCTION_NAME}] storage list failed for one prefix:`, error?.message ?? "no data");
        return;
      }
      for (const obj of data) {
        const created = obj?.created_at;
        if (!obj?.name || !created) continue;
        index.set(dir ? `${dir}/${obj.name}` : obj.name, created);
      }
    } catch (err) {
      console.warn(`[${FUNCTION_NAME}] storage list threw for one prefix:`, err);
    }
  });

  return { index, dirLookups: dirsToRead.length, capped };
}

/**
 * gh-1796 — attach a short-lived signed URL to each row still in the queue.
 * Mutates rows in place. Never throws; a failure leaves loss_sheet_url null and
 * the page falls back to showing the path, which is still actionable.
 */
async function attachSignedUrls(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  rows: HomeownerRow[],
): Promise<number> {
  const queued = rows.filter((r) => r.loss_sheet === "uploaded_unreviewed" && r.loss_sheet_path);
  if (queued.length === 0) return 0;
  try {
    const { data, error } = await supabase.storage
      .from(LOSS_SHEET_BUCKET)
      .createSignedUrls(queued.map((r) => r.loss_sheet_path as string), LOSS_SHEET_URL_TTL_SECONDS);
    if (error || !Array.isArray(data)) {
      console.warn(`[${FUNCTION_NAME}] createSignedUrls failed:`, error?.message ?? "no data");
      return 0;
    }
    let attached = 0;
    const byPath = new Map<string, string>();
    for (const entry of data) {
      if (entry?.path && entry?.signedUrl) byPath.set(entry.path, entry.signedUrl);
    }
    for (const r of queued) {
      const url = byPath.get(r.loss_sheet_path as string);
      if (url) { r.loss_sheet_url = url; attached++; }
    }
    return attached;
  } catch (err) {
    console.warn(`[${FUNCTION_NAME}] createSignedUrls threw:`, err);
    return 0;
  }
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
  }

  const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnon   = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, corsHeaders);
  }

  // ── JWT verification — admin only (same pattern as get-payout-completion-status) ──
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, supabaseAnon || serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();

  if (userError || !userData?.user || !ADMIN_EMAILS.includes(userData.user.email ?? "")) {
    return jsonResponse({ ok: false, error: "Unauthorized — admin only" }, 401, corsHeaders);
  }

  // Service role for the cross-table read (profiles has no admin RLS).
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const now = Date.now();

    // One query per table (no N+1). Column lists are the exact fields
    // rows.ts consumes — nothing else leaves the database.
    const [claimsRes, profilesRes] = await Promise.all([
      // gh-1796 adds estimate_filename / has_estimate / loss_sheet_parsed_at /
      // loss_sheet_reviewed_at, and profiles.created_at for "days since signup".
      // loss_sheet_reviewed_at does not exist until migration
      // 20260907220015_gh1796_claims_loss_sheet_reviewed_at.sql is applied, and a
      // PostgREST select naming an absent column 400s the WHOLE query — so it is
      // requested separately and its absence degrades to "nothing is reviewed
      // yet", which is exactly true pre-migration. Deleting this fallback after
      // the migration is applied is a one-line follow-up, not a correctness fix.
      supabase.from("claims").select(
        "id, user_id, status, created_at, updated_at, trades, job_type, funding_type, is_test, homeowner_name, estimate_filename, has_estimate, loss_sheet_parsed_at"
      ),
      supabase.from("profiles").select("id, full_name, email, created_at"),
    ]);

    for (const [label, res] of [["claims", claimsRes], ["profiles", profilesRes]] as const) {
      if (res.error) {
        console.error(`[${FUNCTION_NAME}] ${label} read failed:`, res.error.message);
        return jsonResponse({ ok: false, error: `Read failed: ${label}` }, 500, corsHeaders);
      }
    }

    const claims = (claimsRes.data ?? []) as ClaimIn[];

    // ── gh-1796: the reviewed markers, in their own query ──────────────────
    // Pre-migration this 400s and every claim reads as unreviewed — correct,
    // because pre-migration nothing HAS been marked reviewed. `reviewed_present`
    // in the response tells the page (and a reviewer) which world it is in, so a
    // missing column is visible rather than silently indistinguishable from an
    // empty queue.
    let reviewedPresent = false;
    const reviewedRes = await supabase
      .from("claims")
      .select("id, loss_sheet_reviewed_at")
      .not("loss_sheet_reviewed_at", "is", null);

    if (reviewedRes.error) {
      if (!isMigrationPendingError(reviewedRes.error)) {
        // REVIEW: FAIL (PR #1804 comment 5577261841): this branch used to
        // treat EVERY error class here as "migration not applied", which
        // (1) silently drops every reviewed marker on a transient failure,
        // making already-reviewed claims reappear in the queue, and (2)
        // makes admin-homeowners.html falsely tell the operator the column
        // "has not been added". Only the real pre-migration signal (42703,
        // undefined_column -- matching mark-loss-sheet-reviewed/index.ts's
        // own PG_UNDEFINED_COLUMN check) may take the fail-open path below;
        // anything else is a real failure and must be reported as one.
        console.error(`[${FUNCTION_NAME}] reviewed-marker query failed:`, reviewedRes.error.message);
        return jsonResponse({ ok: false, error: "Read failed: loss_sheet_reviewed_at" }, 500, corsHeaders);
      }
      console.warn(
        `[${FUNCTION_NAME}] loss_sheet_reviewed_at unavailable (migration 20260907220015 not applied?):`,
        reviewedRes.error.message,
      );
    } else {
      reviewedPresent = true;
      const reviewedById = new Map<string, string>();
      for (const r of reviewedRes.data ?? []) {
        if (r?.id && r?.loss_sheet_reviewed_at) reviewedById.set(r.id, r.loss_sheet_reviewed_at);
      }
      for (const c of claims) {
        const at = reviewedById.get(c.id);
        if (at) c.loss_sheet_reviewed_at = at;
      }
    }

    // ── gh-1796: upload dates from storage, newest claims first so the cap
    // (if it ever bites) drops the oldest rows rather than an arbitrary set ──
    const pathsNewestFirst = claims
      .filter((c) => (c.estimate_filename ?? "").trim().length > 0)
      .sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
      })
      .map((c) => (c.estimate_filename as string).trim());

    const uploaded = await buildUploadedAtIndex(supabase, pathsNewestFirst);

    // ── gh-1570 Part 3: which claims have completed the checklist without
    // submitting for bids, and WHEN. activity_log has no claim_id column
    // (same constraint the loss-sheet code above works around, and the one
    // send-homeowner-next-steps/index.ts documents for this table), so this
    // is read and reduced in JS rather than filtered server-side on
    // metadata->>'claim_id'. A read failure OR a truncated read degrades to
    // "nothing (or not everything) is complete yet" — flagged in the
    // response via checklist_complete_truncated — rather than 500ing the
    // whole list: this queue is a visibility aid, not a source of truth the
    // rest of the page depends on. ────────────────────────────────────────
    const checklistCompleteAtByClaimId = new Map<string, string>();
    let checklistCompleteTruncated = false;
    const checklistFetch = await fetchChecklistCompleteRows(supabase);
    if (checklistFetch.error) {
      console.warn(`[${FUNCTION_NAME}] checklist_complete read failed (queue will read empty):`, checklistFetch.error);
    } else {
      checklistCompleteTruncated = checklistFetch.truncated;
      if (checklistCompleteTruncated) {
        console.warn(`[${FUNCTION_NAME}] checklist_complete read truncated past ${CHECKLIST_COMPLETE_MAX_PAGES} pages — "Ready, not submitted" may be missing rows`);
      }
      for (const row of checklistFetch.rows) {
        const claimId = (row.metadata as { claim_id?: string } | null)?.claim_id;
        if (!claimId) continue;
        // Rows arrive created_at ascending — the first one seen for a claim
        // id is its earliest completion. Defensive against a duplicate (the
        // dashboard's own write-side guard should prevent one, but this is
        // a read path and must not assume the write side is bug-free).
        if (!checklistCompleteAtByClaimId.has(claimId)) {
          checklistCompleteAtByClaimId.set(claimId, row.created_at);
        }
      }
    }

    const rows = buildRows(
      claims,
      (profilesRes.data ?? []) as ProfileIn[],
      now,
      uploaded.index,
      checklistCompleteAtByClaimId,
    );

    const signedUrlsAttached = await attachSignedUrls(supabase, rows);

    const queue = { missing: 0, uploaded_unreviewed: 0, reviewed: 0 };
    for (const r of rows) queue[r.loss_sheet]++;

    return jsonResponse({
      ok: true,
      generated_at: new Date(now).toISOString(),
      dwell_basis: "updated_at",
      // gh-1796 — counts over ALL rows, is_test included. The page filters.
      loss_sheet_queue: queue,
      loss_sheet_reviewed_column_present: reviewedPresent,
      loss_sheet_dir_lookups: uploaded.dirLookups,
      loss_sheet_dir_lookups_capped: uploaded.capped,
      loss_sheet_signed_urls: signedUrlsAttached,
      loss_sheet_uploaded_at_basis_note:
        "storage_object = storage.objects.created_at for claims.estimate_filename (authoritative); " +
        "loss_sheet_parsed_at = fallback, set by parse-loss-sheet just after upload; " +
        "unknown = no date this function can source. claims has no upload-timestamp column.",
      // gh-1570 Part 3 — true only if the checklist_complete activity_log
      // read ran past CHECKLIST_COMPLETE_MAX_PAGES; the "Ready, not
      // submitted" tab may then be missing rows and must say so rather than
      // showing a silently short list.
      checklist_complete_truncated: checklistCompleteTruncated,
      rows,
    }, 200, corsHeaders);

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return jsonResponse({ ok: false, error: "Internal server error" }, 500, corsHeaders);
  }
});
