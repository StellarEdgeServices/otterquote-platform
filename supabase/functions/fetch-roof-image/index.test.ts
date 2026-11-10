import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Deps, handle } from "./handler.ts";

const CID = "11111111-1111-4111-8111-111111111111";
const jpeg = new Uint8Array(5000); jpeg.set([0xff, 0xd8, 0xff]);
function mk(over: Partial<Deps> = {}, calls: string[] = []): Deps {
  return {
    enabled: true,
    getUserId: async () => "u1",
    getClaim: async () => ({ id: CID, user_id: "u1", property_address: "1 Main St", property_city: "Zionsville", property_state: "IN", property_zip: "46077" }),
    exists: async () => false,
    upload: async (p) => { calls.push("upload:" + p); },
    fetchFn: (async (u: string | URL | Request) => {
      const s = String(u); calls.push(s.includes("geocoding.geo.census.gov") ? "geocode" : "naip");
      if (s.includes("geocoding")) return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -86.26, y: 39.95 } }] } }));
      return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
    }) as typeof fetch,
    ...over,
  };
}
const req = (body: unknown = { claim_id: CID }, auth = "Bearer t") =>
  new Request("https://x/fetch-roof-image", { method: "POST", headers: { Authorization: auth }, body: JSON.stringify(body) });

Deno.test("flag OFF: does nothing, touches no network", async () => {
  const calls: string[] = []; const r = await handle(req(), mk({ enabled: false }, calls));
  assertEquals((await r.json()).skipped, "feature_flag_off"); assertEquals(calls, []);
});
Deno.test("happy path: geocode, NAIP fetch, upload to {claim_id}/roof.jpg", async () => {
  const calls: string[] = []; const r = await handle(req(), mk({}, calls));
  assertEquals(r.status, 200); assertEquals((await r.json()).path, `${CID}/roof.jpg`);
  assertEquals(calls, ["geocode", "naip", `upload:${CID}/roof.jpg`]);
});
Deno.test("NEGATIVE: address that fails to geocode -> 422, nothing fetched from NAIP, nothing uploaded", async () => {
  const calls: string[] = [];
  const r = await handle(req(), mk({ fetchFn: (async (u: string | URL | Request) => { calls.push(String(u).includes("geocoding") ? "geocode" : "naip"); return new Response(JSON.stringify({ result: { addressMatches: [] } })); }) as typeof fetch, upload: async () => { calls.push("upload"); } }));
  assertEquals(r.status, 422); assertEquals((await r.json()).error, "geocode_failed"); assertEquals(calls, ["geocode"]);
});
Deno.test("NEGATIVE: geocoder network error -> 422", async () => {
  const r = await handle(req(), mk({ fetchFn: (() => Promise.reject(new Error("down"))) as typeof fetch }));
  assertEquals(r.status, 422);
});
Deno.test("NEGATIVE: non-JPEG from NAIP -> 502, no upload", async () => {
  const calls: string[] = [];
  const r = await handle(req(), mk({ upload: async () => { calls.push("upload"); }, fetchFn: (async (u: string | URL | Request) => String(u).includes("geocoding") ? new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -86, y: 39 } }] } })) : new Response("<html>err</html>")) as typeof fetch }));
  assertEquals(r.status, 502); assertEquals(calls, []);
});
Deno.test("NEGATIVE: caller who does not own the claim -> 404; no token -> 401; bad id -> 400", async () => {
  assertEquals((await handle(req(), mk({ getUserId: async () => "someone-else" }))).status, 404);
  assertEquals((await handle(req({ claim_id: CID }, ""), mk())).status, 401);
  assertEquals((await handle(req({ claim_id: "nope" }), mk())).status, 400);
});
Deno.test("cached object is not re-fetched", async () => {
  const calls: string[] = []; const r = await handle(req(), mk({ exists: async () => true }, calls));
  assertEquals((await r.json()).cached, true); assertEquals(calls, []);
});
Deno.test("claim with no address -> 422", async () => {
  assertEquals((await handle(req(), mk({ getClaim: async () => ({ id: CID, user_id: "u1" }) }))).status, 422);
});
