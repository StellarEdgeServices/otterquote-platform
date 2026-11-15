import { assertEquals, assertAlmostEquals, assert, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { addressHash, objectName, ATTRIBUTION, buildAddress, buildBbox, buildNaipUrl, isJpeg, lonLatToWebMercator, parseGeocode } from "./naip.ts";

Deno.test("attribution credit line is exact", () => assertEquals(ATTRIBUTION, "Imagery: USDA/USGS NAIP"));
Deno.test("web mercator of (0,0) is origin", () => { const p = lonLatToWebMercator(0, 0); assertAlmostEquals(p.x, 0, 1e-6); assertAlmostEquals(p.y, 0, 1e-6); });
Deno.test("bbox is 4:3 and ground width is constant across latitudes", () => {
  for (const lat of [30, 40, 45]) {
    const [x0, y0, x1, y1] = buildBbox(-86.26, lat);
    assertAlmostEquals((x1 - x0) / (y1 - y0), 800 / 600, 1e-9);
    assertAlmostEquals((x1 - x0) * Math.cos((lat * Math.PI) / 180), 150, 1e-6);
  }
});
Deno.test("bbox is centred on the point", () => {
  const c = lonLatToWebMercator(-86.26, 39.95); const [x0, y0, x1, y1] = buildBbox(-86.26, 39.95);
  assertAlmostEquals((x0 + x1) / 2, c.x, 1e-6); assertAlmostEquals((y0 + y1) / 2, c.y, 1e-6);
});
Deno.test("buildNaipUrl carries size, format and SR, and no key", () => {
  const u = new URL(buildNaipUrl(-86.26, 39.95));
  assertEquals(u.hostname, "imagery.nationalmap.gov");
  assertEquals(u.searchParams.get("size"), "800,600"); assertEquals(u.searchParams.get("format"), "jpg");
  assertEquals(u.searchParams.get("bboxSR"), "3857"); assertEquals(u.searchParams.get("bbox")!.split(",").length, 4);
  assert(![...u.searchParams.keys()].some((k) => /key|token/i.test(k)));
});
Deno.test("invalid coordinates throw", () => { assertThrows(() => buildBbox(NaN, 40)); assertThrows(() => buildBbox(0, 89)); });
Deno.test("parseGeocode: match and no-match", () => {
  assertEquals(parseGeocode({ result: { addressMatches: [{ coordinates: { x: -86.2, y: 39.9 } }] } }), { lon: -86.2, lat: 39.9 });
  assertEquals(parseGeocode({ result: { addressMatches: [] } }), null);
  assertEquals(parseGeocode(null), null);
});
Deno.test("isJpeg", () => { const b = new Uint8Array(3000); b.set([0xff, 0xd8, 0xff]); assert(isJpeg(b)); assert(!isJpeg(new Uint8Array(3000))); assert(!isJpeg(new Uint8Array([0xff, 0xd8, 0xff]))); });
Deno.test("buildAddress joins parts and skips blanks", () => {
  assertEquals(buildAddress({ property_address: "1 Main St", property_city: "Zionsville", property_state: "IN", property_zip: "46077" }), "1 Main St, Zionsville, IN 46077");
  assertEquals(buildAddress({}), "");
});
Deno.test("addressHash: stable, case/whitespace-insensitive, differs for a different address", async () => {
  const a = await addressHash("1 Main St, Zionsville, IN 46077");
  assertEquals(a.length, 16);
  assertEquals(a, await addressHash("  1  MAIN st, zionsville, in 46077 "));
  assert(a !== await addressHash("2 Main St, Zionsville, IN 46077"));
  assertEquals(objectName(a), `roof-${a}.jpg`);
});
