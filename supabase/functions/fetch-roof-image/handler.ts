// gh-1413: request handler with injected dependencies so the Deno tests run with the network mocked.
import { buildAddress, buildGeocodeUrl, buildNaipUrl, isJpeg, parseGeocode } from "./naip.ts";

export interface Claim {
  id: string; user_id: string;
  property_address?: string | null; property_city?: string | null; property_state?: string | null; property_zip?: string | null;
}
export interface Deps {
  enabled: boolean;                                   // ROOF_IMAGE_ENABLED === "true"; OFF by default
  getUserId(token: string): Promise<string | null>;
  getClaim(id: string): Promise<Claim | null>;
  exists(path: string): Promise<boolean>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  fetchFn: typeof fetch;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const j = (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

export async function handle(req: Request, d: Deps): Promise<Response> {
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
  const path = `${claim.id}/roof.jpg`;
  if (await d.exists(path)) return j({ path, cached: true }, 200);

  const address = buildAddress(claim);
  if (!address) return j({ error: "no_address" }, 422);
  let geo: { lon: number; lat: number } | null = null;
  try {
    const r = await d.fetchFn(buildGeocodeUrl(address));
    if (r.ok) geo = parseGeocode(await r.json());
  } catch { /* geo stays null */ }
  if (!geo) return j({ error: "geocode_failed" }, 422);

  let bytes: Uint8Array;
  try {
    const r = await d.fetchFn(buildNaipUrl(geo.lon, geo.lat));
    if (!r.ok) return j({ error: "imagery_unavailable", status: r.status }, 502);
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch { return j({ error: "imagery_unavailable" }, 502); }
  if (!isJpeg(bytes)) return j({ error: "imagery_invalid" }, 502);
  await d.upload(path, bytes);
  return j({ path, cached: false }, 200);
}
