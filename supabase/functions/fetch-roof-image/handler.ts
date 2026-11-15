// gh-1413: request handler with injected dependencies so the Deno tests run with the network mocked.
import { addressHash, buildAddress, buildGeocodeUrl, buildNaipUrl, isJpeg, objectName, OBJECT_PREFIX, parseGeocode } from "./naip.ts";
import { buildCorsHeaders } from "./cors.ts";

export interface Claim {
  id: string; user_id: string;
  property_address?: string | null; property_city?: string | null; property_state?: string | null; property_zip?: string | null;
}
export interface Deps {
  enabled: boolean;                                   // ROOF_IMAGE_ENABLED === "true"; OFF by default
  getUserId(token: string): Promise<string | null>;
  getClaim(id: string): Promise<Claim | null>;
  list(claimId: string): Promise<string[]>;           // object names (not paths) currently stored under {claim_id}/
  upload(path: string, bytes: Uint8Array): Promise<void>; // upsert:false; throws Error(message) on failure
  remove(paths: string[]): Promise<void>;             // best-effort cleanup of superseded images
  fetchFn: typeof fetch;
  now?: () => number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALREADY_EXISTS = /already exists|duplicate|resource_already_exists/i;

// Short negative cache for failed geocodes (per isolate, best effort): a claim whose address does not geocode is not re-sent to the Census geocoder on every call.
export const GEOCODE_FAIL_TTL_MS = 10 * 60 * 1000;
const geocodeFailures = new Map<string, number>();
export const clearGeocodeFailures = () => geocodeFailures.clear();

export async function handle(req: Request, d: Deps): Promise<Response> {
  const cors = buildCorsHeaders(req);
  const j = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return j({ error: "method_not_allowed" }, 405);
  if (!d.enabled) return j({ skipped: "feature_flag_off" }, 200);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const uid = token ? await d.getUserId(token) : null;
  if (!uid) return j({ error: "unauthorized" }, 401);
  let body: { claim_id?: string } = {};
  try { body = await req.json(); } catch { /* falls through */ }
  const claimId = body.claim_id ?? "";
  if (!UUID.test(claimId)) return j({ error: "invalid_claim_id" }, 400);
  const claim = await d.getClaim(claimId);
  if (!claim || claim.user_id !== uid) return j({ error: "not_found" }, 404);

  const address = buildAddress(claim);
  if (!address) return j({ error: "no_address" }, 422);
  const hash = await addressHash(address);
  const name = objectName(hash);
  const path = `${claim.id}/${name}`;

  let existing: string[] = [];
  try { existing = await d.list(claim.id); } catch { return j({ error: "storage_unavailable" }, 502); }
  if (existing.includes(name)) return j({ path, cached: true }, 200);

  const now = (d.now ?? Date.now)();
  const failKey = `${claim.id}:${hash}`;
  const failedAt = geocodeFailures.get(failKey);
  if (failedAt !== undefined && now - failedAt < GEOCODE_FAIL_TTL_MS) return j({ error: "geocode_failed", cached: true }, 422);

  let geo: { lon: number; lat: number } | null = null;
  try {
    const r = await d.fetchFn(buildGeocodeUrl(address));
    if (r.ok) geo = parseGeocode(await r.json());
  } catch { /* geo stays null */ }
  if (!geo) { geocodeFailures.set(failKey, now); return j({ error: "geocode_failed" }, 422); }

  let bytes: Uint8Array;
  try {
    const r = await d.fetchFn(buildNaipUrl(geo.lon, geo.lat));
    if (!r.ok) return j({ error: "imagery_unavailable", status: r.status }, 502);
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch { return j({ error: "imagery_unavailable" }, 502); }
  if (!isJpeg(bytes)) return j({ error: "imagery_invalid" }, 502);

  try {
    await d.upload(path, bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // First-call race: a concurrent call stored the same image (same address hash) first. That is success.
    if (ALREADY_EXISTS.test(msg)) return j({ path, cached: true }, 200);
    return j({ error: "upload_failed" }, 500);
  }
  // Address changed since an earlier image: remove the superseded ones (best effort; a leftover is harmless because the caller uses the returned path).
  const stale = existing.filter((n) => n.startsWith(OBJECT_PREFIX) && n !== name).map((n) => `${claim.id}/${n}`);
  if (stale.length) { try { await d.remove(stale); } catch { /* ignore */ } }
  return j({ path, cached: false }, 200);
}
