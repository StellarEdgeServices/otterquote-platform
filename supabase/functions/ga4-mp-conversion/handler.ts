// gh-3051 -- request handling for ga4-mp-conversion, with every side effect injected so handler.test.ts runs with no network.
import { shouldSuppressAnalyticsDispatch } from "../_shared/synthetic-traffic.ts";
import { type ConversionKind, type ConversionRow, EVENT_FOR_KIND, isTooOld, sendGa4, type SendResult } from "./ga4-mp.ts";

export const FUNCTION_NAME = "ga4-mp-conversion";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same internal-address list as notify-admin-new-homeowner (gh-1932) plus the leads reserved test suffix (gh-1994). Internal only.
const INTERNAL_EMAIL = /(@otterquote\.com|@tryotterquote\.com|@stellaredgeservices\.com|@otterquote-internal\.test|@example\.(com|org)|@test\.local)$/i;

export function isInternalEmail(email: string | null | undefined): boolean {
  return !!email && (INTERNAL_EMAIL.test(email.trim()) || /stohler/i.test(email));
}

export interface Deps {
  serviceRoleKey: string;
  apiSecret: string | undefined;
  /** Loads the row the trigger named. null = not found. */
  loadRow: (kind: ConversionKind, id: string) => Promise<ConversionRow | null>;
  /** Idempotency: 'claimed' = first time, send; 'duplicate' = already sent; 'error' = cannot tell (fail closed). */
  claimMarker: (eventName: string, rowId: string) => Promise<"claimed" | "duplicate" | "error">;
  releaseMarker: (eventName: string, rowId: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

function respond(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    if (req.method !== "POST") return respond({ error: "method" }, 405);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!deps.serviceRoleKey || bearer !== deps.serviceRoleKey) return respond({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const kind = ({ router_contact_submitted: "lead", claim_started: "claim" } as Record<string, ConversionKind>)[String(body?.event_type)];
    const id = String(body?.id ?? "");
    if (!kind || !UUID_RE.test(id)) return respond({ error: "bad_request" }, 400);
    const eventName = EVENT_FOR_KIND[kind];
    const debug = body?.debug === true;

    const row = await deps.loadRow(kind, id);
    if (!row) { log(`[gh-3051] ga4_mp ${eventName}: row not found`); return respond({ sent: false, reason: "row_not_found" }); }

    // Debug mode (the closes-on's /debug/mp/collect check) validates the payload and records NOTHING in GA4, so it may carry an
    // is_test row on purpose. No marker, no suppression, never the production endpoint.
    if (debug) {
      const r = await sendGa4(row, { secret: deps.apiSecret, debug: true, fetchImpl: deps.fetchImpl, log });
      return respond({ ...r, debug: true });
    }

    const suppressed =
      shouldSuppressAnalyticsDispatch("ga4_mp", eventName, {
        isTest: row.isTest, isSynthetic: row.isSynthetic,
        params: { utm_source: row.utmSource, utm_medium: row.utmMedium },
      }, log) ||
      (isInternalEmail(row.email) && (log(`[gh-3051] ga4_mp ${eventName} suppressed: internal address`), true));
    if (suppressed) return respond({ sent: false, reason: "suppressed" });

    // Age guard (production path only): a bulk insert / restore / backfill must not replay historic conversions. Fails closed on a missing created_at.
    if (isTooOld(row.createdAt)) { log(`[gh-3051] ga4_mp ${eventName} not sent: row older than 72 h`); return respond({ sent: false, reason: "too_old" }); }

    if (!deps.apiSecret) { log(`[gh-3051] ga4_mp ${eventName} not sent: GA4_MP_API_SECRET is not set`); return respond({ sent: false, reason: "no_secret" }); }

    const marker = await deps.claimMarker(eventName, id);
    if (marker === "duplicate") return respond({ sent: false, reason: "duplicate" });
    if (marker === "error") { log(`[gh-3051] ga4_mp ${eventName} not sent: idempotency marker unavailable`); return respond({ sent: false, reason: "marker_error" }); }

    const r: SendResult = await sendGa4(row, { secret: deps.apiSecret, fetchImpl: deps.fetchImpl, log });
    if (!r.sent) await deps.releaseMarker(eventName, id).catch(() => {}); // let a later retry through
    return respond({ ...r, validationMessages: undefined });
  } catch (_e) {
    // Never a 5xx the caller might retry into a duplicate, never an error text that could carry a secret.
    log("[gh-3051] ga4-mp-conversion: unexpected error");
    return respond({ sent: false, reason: "internal" });
  }
}
