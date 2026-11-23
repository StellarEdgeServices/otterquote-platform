// [gh-1413 / D-317 cl. 6] Roof image on the homeowner Scope of Work (Exhibit A). Dark behind ROOF_IMAGE_ENABLED; fee-gated; fails closed.
// NEGATIVE CONTROL: on main (24bcaa04) generateRetailScopeOfWorkPdf ignores a roofImage argument, so the "embeds the image" test fails there
// (no /DCTDecode in the output) and ./roof-image-exhibit.ts does not exist; both pass here. The no-image output is pinned byte-identical to the flag-off output.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildAddress, currentRoofImageName, jpegInfo, loadRoofImageForExhibit, mayEmbedRoofImage, roofImageExhibitEnabled, ROOF_IMAGE_EXHIBIT_CAPTION, ROOF_IMAGE_OBJECT_PREFIX, withTimeout } from "./roof-image-exhibit.ts";
import { addressHash, ATTRIBUTION, buildAddress as naipBuildAddress, objectName, OBJECT_PREFIX } from "../fetch-roof-image/naip.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
function grab(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`not found: ${name}`);
  let depth = 0;
  const open = src.indexOf("{", start);
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced: ${name}`);
}
const names = ["base64EncodeBinary", "pitchOver12", "pitchRangeLabel", "bucketByBands", "contractorAuthoredMessage", "mergeSowSelections", "resolveMeasurementShape", "insurerScopeRows", "sowDripEdgeFromBid", "sowContingenciesRowExists", "generateRetailScopeOfWorkPdf"]
  .filter((n) => src.includes(`function ${n}(`));
const code = "// @ts-nocheck\n" + names.map((n) => grab(n).replace(`function ${n}`, `export function ${n}`)).join("\n");
// deno-lint-ignore no-explicit-any
const m = await import("data:application/typescript," + encodeURIComponent(code)) as any;

const JPG = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAtADwDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHoopwAIrlbscmFws8TNwg1e19RtFP2ijaKXMjv/sXEd1+P+Qyin7RTD1oTucmKwFTDJObWvb/AIYKKKKZxBT16UynKRilLY9bJpKNdtu2n6odRSZHrRketQfS+1p/zL7xajPU0/I9aYetVE8XOpxlTjZ31CiiiqPngooooAKKKKACiiigAooooA//2Q=="), (c) => c.charCodeAt(0)); // synthetic 60x45 RGB JPEG, not a real property
const CLAIM = "11111111-2222-3333-4444-555555555555";
const ADDR = { property_address: "1 Main St", property_city: "Zionsville", property_state: "IN", property_zip: "46077" };
const CL = { id: CLAIM, ...ADDR };
const NAME = await currentRoofImageName(ADDR) as string;
// deno-lint-ignore no-explicit-any
const sow = (extra: any = {}) => m.generateRetailScopeOfWorkPdf({
  homeownerName: "Test Homeowner", contractorName: "Test Roofing", propertyAddress: "1 Main St", claimId: "abcdefgh12345678", trades: ["roofing"],
  contractPrice: 12000, valueAdds: {}, declarations: null, bidBrand: "GAF", projectConfirmation: null, measurements: null, fundingType: "retail", insurance: null, ...extra,
}) as string;
const bin = (b64: string) => atob(b64);
const IMG = { bytes: JPG, width: 60, height: 45, components: 3, caption: ROOF_IMAGE_EXHIBIT_CAPTION };

Deno.test("jpegInfo reads the fixture and rejects non-JPEG, truncated and CMYK", () => {
  assertEquals(jpegInfo(JPG), { width: 60, height: 45, components: 3 });
  assertEquals(jpegInfo(new Uint8Array([1, 2, 3, 4, 5])), null);
  assertEquals(jpegInfo(JPG.slice(0, 12)), null);
  const cmyk = JPG.slice(); for (let i = 0; i < cmyk.length - 9; i++) if (cmyk[i] === 0xff && cmyk[i + 1] === 0xc0) { cmyk[i + 9] = 4; break; }
  assertEquals(jpegInfo(cmyk), null);
});

Deno.test("embeds the image as a DCTDecode XObject with exact xref offsets and the existing credit line only", () => {
  const pdf = bin(sow({ roofImage: IMG }));
  assert(pdf.includes("/Subtype /Image") && pdf.includes("/Filter /DCTDecode") && pdf.includes("/Im1 Do"), "image object and draw operator present");
  assert(pdf.includes("(Imagery: USDA/USGS NAIP)"), "credit line printed");
  // every xref entry points at "N 0 obj"
  const xref = pdf.slice(pdf.lastIndexOf("\nxref\n") + 1);
  const rows = xref.split("\n").slice(3).filter((l) => /^\d{10} 00000 n/.test(l));
  assert(rows.length >= 6);
  rows.forEach((r, i) => assertEquals(pdf.slice(Number(r.slice(0, 10)), Number(r.slice(0, 10)) + String(i + 1).length + 6), `${i + 1} 0 obj`));
  // the JPEG bytes survive untouched
  const raw = String.fromCharCode(...JPG);
  assert(pdf.includes(raw), "JPEG bytes unchanged inside the stream");
});

Deno.test("no image: output is byte-identical to a call that never mentions roofImage (flag off / not fee-collected / no stored image)", () => {
  assertEquals(sow({ roofImage: null }), sow());
  assert(!bin(sow({ roofImage: null })).includes("/DCTDecode"));
});

Deno.test("gate: both flags, the collected fee and the selected contractor are all required", () => {
  assertEquals(roofImageExhibitEnabled(undefined), false);
  assertEquals(roofImageExhibitEnabled("TRUE"), false);
  assertEquals(roofImageExhibitEnabled("true"), true);
  const all = { enabled: true, inContractEnabled: true, feeCollected: true, callerIsSelectedContractor: true };
  assertEquals(mayEmbedRoofImage(all), true);
  for (const k of Object.keys(all)) assertEquals(mayEmbedRoofImage({ ...all, [k]: false }), false, `${k} off`);
  // the homeowner-page flag alone (the B4 case) does not open the contractor-bound document
  assertEquals(mayEmbedRoofImage({ ...all, inContractEnabled: false }), false);
});

Deno.test("address binding matches fetch-roof-image exactly (parity with naip.ts)", async () => {
  for (const c of [ADDR, { property_address: " 12  Oak Ave ", property_city: "Carmel", property_state: "IN", property_zip: null }, { property_address: "9 B St" }]) {
    assertEquals(buildAddress(c), naipBuildAddress(c));
    assertEquals(await currentRoofImageName(c), objectName(await addressHash(naipBuildAddress(c))));
  }
  assertEquals(await currentRoofImageName({}), null);
});

Deno.test("loader: reads only claim-roof-images/{claim}/{current-address name} and fails closed", async () => {
  const seen: string[] = [];
  const ok = { list: async () => [NAME], download: async (p: string) => { seen.push(p); return JPG; } };
  const got = await loadRoofImageForExhibit(CL, ok);
  assertEquals(got?.width, 60); assertEquals(seen, [`${CLAIM}/${NAME}`]);
  assertEquals(await loadRoofImageForExhibit(CL, { list: async () => [], download: async () => JPG }), null);
  assertEquals(await loadRoofImageForExhibit(CL, { list: async () => ["measurements.pdf"], download: async () => JPG }), null, "other objects ignored");
  assertEquals(await loadRoofImageForExhibit(CL, { list: async () => [NAME], download: async () => new Uint8Array(3 * 1024 * 1024) }), null, "oversize");
  assertEquals(await loadRoofImageForExhibit(CL, { list: async () => [NAME], download: async () => new Uint8Array([1, 2, 3, 4]) }), null, "not a JPEG");
  assertEquals(await loadRoofImageForExhibit(CL, { list: async () => { throw new Error("x"); }, download: async () => JPG }), null, "storage error");
  assertEquals(await loadRoofImageForExhibit({ ...CL, id: "../claim-documents" }, ok), null, "path-shaped claim id refused");
});

Deno.test("B2: address edited after the image was stored -> no image (and the old name is never downloaded)", async () => {
  const seen: string[] = [];
  const stored = { list: async () => [NAME], download: async (p: string) => { seen.push(p); return JPG; } }; // image of the OLD address
  const edited = { ...CL, property_address: "99 Elm Ct" };
  assertEquals(await loadRoofImageForExhibit(edited, stored), null);
  assertEquals(seen, []);
  assertEquals(await loadRoofImageForExhibit({ id: CLAIM }, stored), null, "no address at all");
  // several stored images (old and new): only the current one is used
  const both = { list: async () => ["roof-0000000000000000.jpg", NAME], download: async (p: string) => { seen.push(p); return JPG; } };
  assert((await loadRoofImageForExhibit(CL, both)) !== null); assertEquals(seen, [`${CLAIM}/${NAME}`]);
});

Deno.test("B3: a stalled list or a stalled download yields no image quickly, and the Exhibit A is still produced", async () => {
  const never = () => new Promise<never>(() => {});
  const t0 = Date.now();
  assertEquals(await loadRoofImageForExhibit(CL, { list: never, download: async () => JPG }, 30), null);
  assertEquals(await loadRoofImageForExhibit(CL, { list: async () => [NAME], download: never }, 30), null);
  assert(Date.now() - t0 < 1000, "bounded by the timeout");
  assertEquals(await withTimeout(never(), 10), null);
  assertEquals(await withTimeout(Promise.reject(new Error("x")), 10), null);
  assertEquals(await withTimeout(Promise.resolve(5), 10), 5);
  const img = await loadRoofImageForExhibit(CL, { list: never, download: async () => JPG }, 30);
  const pdf = bin(sow({ roofImage: img }));
  assert(pdf.startsWith("%PDF-1.4") && pdf.includes("%%EOF") && pdf.includes("contractor_initial_sow") && !pdf.includes("/DCTDecode"), "document minted without the image");
});

Deno.test("jpegInfo accepts only baseline / extended / progressive Huffman frames", () => {
  const lossless = JPG.slice(); for (let i = 0; i < lossless.length - 9; i++) if (lossless[i] === 0xff && lossless[i + 1] === 0xc0) { lossless[i + 1] = 0xc3; break; }
  assertEquals(jpegInfo(lossless), null);
});

Deno.test("a tall image is scaled to fit the page (drawn at most 300 x 300 pt)", () => {
  const pdf = bin(sow({ roofImage: { ...IMG, width: 300, height: 3000 } }));
  const m = pdf.match(/q (\d+) 0 0 (\d+) 50 (-?\d+) cm \/Im1 Do Q/)!;
  assert(Number(m[2]) <= 300 && Number(m[3]) > 0, `drawn ${m[1]}x${m[2]} at y=${m[3]}`);
});

Deno.test("wiring: caption equals the function's credit line; call site carries every gate; no URL or public bucket is created", async () => {
  assertEquals(ROOF_IMAGE_OBJECT_PREFIX, OBJECT_PREFIX);
  assertEquals(ROOF_IMAGE_EXHIBIT_CAPTION, ATTRIBUTION);
  assert(src.includes('Deno.env.get("ROOF_IMAGE_IN_CONTRACT_ENABLED")') && src.includes("callerIsSelectedContractor:") && src.includes("feeCollected: d390FeeCollected"));
  const mod = await Deno.readTextFile(new URL("./roof-image-exhibit.ts", import.meta.url));
  assert(!/createSignedUrl|getPublicUrl|claim-documents\/|createBucket/.test(mod.replace(/\/\/.*$/gm, "")));
});
