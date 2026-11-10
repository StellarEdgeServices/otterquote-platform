import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { clearGeocodeFailures, Deps, handle } from "./handler.ts";
import { addressHash, objectName } from "./naip.ts";

const CID = "11111111-1111-4111-8111-111111111111";
const ADDR = "1 Main St, Zionsville, IN 46077";
const HASH = await addressHash(ADDR);
const NAME = objectName(HASH);
const jpeg = new Uint8Array(5000); jpeg.set([0xff, 0xd8, 0xff]);
function mk(over: Partial<Deps> = {}, calls: string[] = []): Deps {
  return {
    enabled: true,
    getUserId: async () => "u1",
    getClaim: async () => ({ id: CID, user_id: "u1", property_address: "1 Main St", property_city: "Zionsville", property_state: "IN", property_zip: "46077" }),
    list: async () => [],
    upload: async (p) => { calls.push("upload:" + p); },
    remove: async (p) => { calls.push("remove:" + p.join(",")); },
    fetchFn: (async (u: string | URL | Request) => {
      const s = String(u); calls.push(s.includes("geocoding.geo.census.gov") ? "geocode" : "naip");
      if (s.includes("geocoding")) return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -86.26, y: 39.95 } }] } }));
      return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
    }) as typeof fetch,
    ...over,
  };
}
const req = (body: unknown = { claim_id: CID }, auth = "Bearer t", method = "POST") =>
  new Request("https://x/fetch-roof-image", { method, headers: { Authorization: auth, Origin: "https://app.otterquote.com" }, body: method === "POST" ? JSON.stringify(body) : undefined });
const noGeo = (calls: string[]) => (async (u: string | URL | Request) => { calls.push(String(u).includes("geocoding") ? "geocode" : "naip"); return new Response(JSON.stringify({ result: { addressMatches: [] } })); }) as typeof fetch;

Deno.test("OPTIONS preflight: 204 with CORS headers, no auth, no network", async () => {
  const calls: string[] = [];
  const r = await handle(new Request("https://x/fetch-roof-image", { method: "OPTIONS", headers: { Origin: "https://app.otterquote.com" } }), mk({}, calls));
  assertEquals(r.status, 204);
  assertEquals(r.headers.get("Access-Control-Allow-Origin"), "https://app.otterquote.com");
  assertEquals(r.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assertEquals((r.headers.get("Access-Control-Allow-Headers") ?? "").includes("Authorization"), true);
  assertEquals(calls, []);
});
Deno.test("responses carry CORS headers; unknown origin falls back to the first allowed origin", async () => {
  const r = await handle(new Request("https://x/f", { method: "POST", headers: { Origin: "https://evil.example" } }), mk({ enabled: false }));
  assertEquals(r.headers.get("Access-Control-Allow-Origin"), "https://otterquote.com");
});
Deno.test("flag OFF: does nothing, touches no network", async () => {
  const calls: string[] = []; const r = await handle(req(), mk({ enabled: false }, calls));
  assertEquals((await r.json()).skipped, "feature_flag_off"); assertEquals(calls, []);
});
Deno.test("happy path: geocode, NAIP fetch, upload to {claim_id}/roof-{hash}.jpg", async () => {
  clearGeocodeFailures();
  const calls: string[] = []; const r = await handle(req(), mk({}, calls));
  assertEquals(r.status, 200); assertEquals((await r.json()).path, `${CID}/${NAME}`);
  assertEquals(calls, ["geocode", "naip", `upload:${CID}/${NAME}`]);
});
Deno.test("regenerate on changed address: old image replaced under a new name and the old one removed", async () => {
  clearGeocodeFailures();
  const calls: string[] = []; const old = objectName("deadbeefdeadbeef");
  const r = await handle(req(), mk({ list: async () => [old] }, calls));
  assertEquals(r.status, 200); const b = await r.json();
  assertEquals(b.cached, false); assertEquals(b.path, `${CID}/${NAME}`);
  assertEquals(calls, ["geocode", "naip", `upload:${CID}/${NAME}`, `remove:${CID}/${old}`]);
});
Deno.test("same address: existing image is not re-fetched", async () => {
  const calls: string[] = []; const r = await handle(req(), mk({ list: async () => [NAME] }, calls));
  const b = await r.json(); assertEquals(b.cached, true); assertEquals(b.path, `${CID}/${NAME}`); assertEquals(calls, []);
});
Deno.test("upload error -> JSON 500 upload_failed (not a bare 500)", async () => {
  clearGeocodeFailures();
  const r = await handle(req(), mk({ upload: async () => { throw new Error("Bucket not found"); } }));
  assertEquals(r.status, 500); assertEquals(r.headers.get("Content-Type"), "application/json");
  assertEquals((await r.json()).error, "upload_failed");
});
Deno.test("first-call race: upload says already exists -> success (cached)", async () => {
  clearGeocodeFailures();
  const r = await handle(req(), mk({ upload: async () => { throw new Error("The resource already exists"); } }));
  assertEquals(r.status, 200); const b = await r.json(); assertEquals(b.cached, true); assertEquals(b.path, `${CID}/${NAME}`);
});
Deno.test("storage list failure -> JSON 502, nothing fetched", async () => {
  const calls: string[] = [];
  const r = await handle(req(), mk({ list: async () => { throw new Error("down"); } }, calls));
  assertEquals(r.status, 502); assertEquals((await r.json()).error, "storage_unavailable"); assertEquals(calls, []);
});
Deno.test("NEGATIVE: address that fails to geocode -> 422, nothing fetched from NAIP, nothing uploaded", async () => {
  clearGeocodeFailures();
  const calls: string[] = [];
  const r = await handle(req(), mk({ fetchFn: noGeo(calls), upload: async () => { calls.push("upload"); } }));
  assertEquals(r.status, 422); assertEquals((await r.json()).error, "geocode_failed"); assertEquals(calls, ["geocode"]);
});
Deno.test("failed geocode is cached briefly: second call returns 422 without calling the geocoder; retried after the TTL", async () => {
  clearGeocodeFailures();
  const calls: string[] = []; let t = 1_000_000;
  const deps = mk({ fetchFn: noGeo(calls), now: () => t });
  await handle(req(), deps);
  const r2 = await handle(req(), deps);
  assertEquals(r2.status, 422); assertEquals(calls, ["geocode"]);
  t += 11 * 60 * 1000; await handle(req(), deps);
  assertEquals(calls, ["geocode", "geocode"]);
});
Deno.test("NEGATIVE: geocoder network error -> 422", async () => {
  clearGeocodeFailures();
  const r = await handle(req(), mk({ fetchFn: (() => Promise.reject(new Error("down"))) as typeof fetch }));
  assertEquals(r.status, 422);
});
Deno.test("NEGATIVE: non-JPEG from NAIP -> 502, no upload", async () => {
  clearGeocodeFailures();
  const calls: string[] = [];
  const r = await handle(req(), mk({ upload: async () => { calls.push("upload"); }, fetchFn: (async (u: string | URL | Request) => String(u).includes("geocoding") ? new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -86, y: 39 } }] } })) : new Response("<html>err</html>")) as typeof fetch }));
  assertEquals(r.status, 502); assertEquals(calls, []);
});
Deno.test("NEGATIVE: caller who does not own the claim (e.g. a contractor) -> 404; no token -> 401; bad id -> 400", async () => {
  assertEquals((await handle(req(), mk({ getUserId: async () => "someone-else" }))).status, 404);
  assertEquals((await handle(req({ claim_id: CID }, ""), mk())).status, 401);
  assertEquals((await handle(req({ claim_id: "nope" }), mk())).status, 400);
});
Deno.test("claim with no address -> 422", async () => {
  assertEquals((await handle(req(), mk({ getClaim: async () => ({ id: CID, user_id: "u1" }) }))).status, 422);
});
