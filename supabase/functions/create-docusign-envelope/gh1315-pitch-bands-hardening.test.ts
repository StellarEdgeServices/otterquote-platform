// [gh-1315] contractors.pitch_bands is contractor-supplied JSON that renders on Exhibit A (a signed contract exhibit) through
// bucketByBands. Once the c4 column exists, a contractor's own UPDATE could write anything into it. These tests pin the strict
// validator (sanitizePitchBands / sanitizeBands / sanitizeTwoStoryAdder) and prove bucketByBands falls back to the
// documented Xactimate-aligned default on every malformed or hostile shape. No new user-facing wording.
// NEGATIVE CONTROL: against main's index.ts (48235598) the hostile-label, overlapping, negative, wrong-type and huge-array fixtures
// below are all ACCEPTED by bucketByBands (it only checked Array.isArray && length > 0), so every "falls back" assertion fails there.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

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
const fallbackStart = src.indexOf("const XACTIMATE_FALLBACK_BANDS = [");
const fallbackEnd = src.indexOf("];", fallbackStart) + 2;
const fallbackDecl = src.slice(fallbackStart, fallbackEnd);
const names = ["isPlainPitchObject", "isValidPitchLabel", "isValidPitchRate", "sanitizeBands", "sanitizeTwoStoryAdder", "sanitizePitchBands", "pitchOver12", "bucketByBands"];
const code = "// @ts-nocheck\n" + fallbackDecl + "\nexport const FALLBACK = XACTIMATE_FALLBACK_BANDS;\n" +
  names.map((n) => grab(n).replace(`function ${n}`, `export function ${n}`)).join("\n");
// deno-lint-ignore no-explicit-any
const m = await import("data:application/typescript," + encodeURIComponent(code)) as any;

const GOOD_BANDS = [
  { label: "Over 5/12", min_over_12: 5, max_over_12: 9, rate_per_square: 25 },
  { label: "10/12 to 12/12", min_over_12: 10, max_over_12: 12, rate_per_square: 55.5 },
];
const GOOD = { source: "contractor_rate_card", bands: GOOD_BANDS, two_story_adder: { label: "Two story", rate_per_square: 15 } };
const AREAS = [{ pitch: "6/12", squares: 10 }, { pitch: "11/12", squares: 5 }, { pitch: "24/12", squares: 2.8 }];
const fallbackLabels = () => m.FALLBACK.map((b: { label: string }) => b.label);

Deno.test("a well-formed rate card passes, normalized, and buckets by the contractor's bands", () => {
  const r = m.sanitizePitchBands(GOOD);
  assertEquals(r.bands.length, 2);
  assertEquals(r.twoStoryAdder, { label: "Two story", rate_per_square: 15 });
  const s = m.bucketByBands(AREAS, r.bands);
  assertEquals(s.usedFallback, false);
  assertEquals(s.buckets.map((b: { band: { label: string } }) => b.band.label), ["Over 5/12", "10/12 to 12/12"]);
  assertEquals(s.unbandedSquares, 2.8);
});

Deno.test("no rate card (null / undefined) means the documented fallback", () => {
  assertEquals(m.sanitizePitchBands(null), null);
  assertEquals(m.sanitizePitchBands(undefined), null);
  const s = m.bucketByBands(AREAS, null);
  assertEquals(s.usedFallback, true);
  assertEquals(s.buckets.map((b: { band: { label: string } }) => b.band.label), fallbackLabels());
});

Deno.test("two_story_adder is optional; null and absent both validate", () => {
  assertEquals(m.sanitizePitchBands({ source: "contractor_rate_card", bands: GOOD_BANDS }).twoStoryAdder, null);
  assertEquals(m.sanitizePitchBands({ source: "contractor_rate_card", bands: GOOD_BANDS, two_story_adder: null }).twoStoryAdder, null);
});

// ---- hostile / malformed whole objects: every one must be rejected and bucketByBands must use the fallback ----
const big = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Band ${i}`, min_over_12: i, max_over_12: i, rate_per_square: 1 }));
// deno-lint-ignore no-explicit-any
const HOSTILE: Record<string, any> = {
  "string value": "Priced at $0",
  "number value": 42,
  "array at top level": GOOD_BANDS,
  "wrong source": { ...GOOD, source: "admin" },
  "missing source": { bands: GOOD_BANDS },
  "unknown top-level key": { ...GOOD, extra: "<script>alert(1)</script>" },
  "bands is a string": { ...GOOD, bands: "<b>free roof</b>" },
  "bands is an object": { ...GOOD, bands: { 0: GOOD_BANDS[0] } },
  "empty bands array": { ...GOOD, bands: [] },
  "huge bands array (13)": { ...GOOD, bands: big(13) },
  "huge bands array (100000)": { ...GOOD, bands: big(100000) },
  "band is a string": { ...GOOD, bands: ["Over 5/12"] },
  "band is null": { ...GOOD, bands: [null] },
  "band is an array": { ...GOOD, bands: [[1, 2]] },
  "markup in label": { ...GOOD, bands: [{ label: "<script>alert(1)</script>", min_over_12: 5, max_over_12: null, rate_per_square: 25 }] },
  "markup in label (img)": { ...GOOD, bands: [{ label: "<img src=x onerror=alert(1)>", min_over_12: 5, max_over_12: null }] },
  "markup in label (angle only)": { ...GOOD, bands: [{ label: "Over 5/12 >", min_over_12: 5, max_over_12: null }] },
  "backslash in label": { ...GOOD, bands: [{ label: "a\\b", min_over_12: 5, max_over_12: null }] },
  "newline in label": { ...GOOD, bands: [{ label: "line\nbreak", min_over_12: 5, max_over_12: null }] },
  "non-ASCII in label": { ...GOOD, bands: [{ label: "Steep ‮ slope", min_over_12: 5, max_over_12: null }] },
  "label too long": { ...GOOD, bands: [{ label: "A".repeat(61), min_over_12: 5, max_over_12: null }] },
  "huge label (1 MB)": { ...GOOD, bands: [{ label: "A".repeat(1_000_000), min_over_12: 5, max_over_12: null }] },
  "blank label": { ...GOOD, bands: [{ label: "   ", min_over_12: 5, max_over_12: null }] },
  "label not a string": { ...GOOD, bands: [{ label: { toString: "x" }, min_over_12: 5, max_over_12: null }] },
  "missing label": { ...GOOD, bands: [{ min_over_12: 5, max_over_12: null }] },
  "negative min": { ...GOOD, bands: [{ label: "Neg", min_over_12: -3, max_over_12: 4 }] },
  "negative max": { ...GOOD, bands: [{ label: "Neg", min_over_12: 0, max_over_12: -1 }] },
  "min greater than max": { ...GOOD, bands: [{ label: "Backwards", min_over_12: 9, max_over_12: 5 }] },
  "non-integer pitch": { ...GOOD, bands: [{ label: "Frac", min_over_12: 5.5, max_over_12: 9 }] },
  "pitch above 24": { ...GOOD, bands: [{ label: "Tall", min_over_12: 5, max_over_12: 400 }] },
  "pitch as string": { ...GOOD, bands: [{ label: "Str", min_over_12: "5", max_over_12: null }] },
  "pitch NaN": { ...GOOD, bands: [{ label: "NaN", min_over_12: NaN, max_over_12: null }] },
  "pitch Infinity": { ...GOOD, bands: [{ label: "Inf", min_over_12: 0, max_over_12: Infinity }] },
  "overlapping bands": { ...GOOD, bands: [{ label: "A", min_over_12: 5, max_over_12: 9 }, { label: "B", min_over_12: 9, max_over_12: 12 }] },
  "overlapping via open ends": { ...GOOD, bands: [{ label: "A", min_over_12: 5, max_over_12: null }, { label: "B", min_over_12: 10, max_over_12: 12 }] },
  "identical bands": { ...GOOD, bands: [GOOD_BANDS[0], GOOD_BANDS[0]] },
  "two fully open bands": { ...GOOD, bands: [{ label: "A" }, { label: "B" }] },
  "unknown band key": { ...GOOD, bands: [{ label: "A", min_over_12: 5, max_over_12: null, note: "x" }] },
  "negative rate": { ...GOOD, bands: [{ label: "A", min_over_12: 5, max_over_12: null, rate_per_square: -25 }] },
  "rate as string": { ...GOOD, bands: [{ label: "A", min_over_12: 5, max_over_12: null, rate_per_square: "25" }] },
  "rate NaN": { ...GOOD, bands: [{ label: "A", min_over_12: 5, max_over_12: null, rate_per_square: NaN }] },
  "rate Infinity": { ...GOOD, bands: [{ label: "A", min_over_12: 5, max_over_12: null, rate_per_square: Infinity }] },
  "rate absurdly large": { ...GOOD, bands: [{ label: "A", min_over_12: 5, max_over_12: null, rate_per_square: 1e12 }] },
  "adder is a string": { ...GOOD, two_story_adder: "free" },
  "adder is an array": { ...GOOD, two_story_adder: [15] },
  "adder negative rate": { ...GOOD, two_story_adder: { rate_per_square: -1 } },
  "adder rate string": { ...GOOD, two_story_adder: { rate_per_square: "15" } },
  "adder markup label": { ...GOOD, two_story_adder: { label: "<b>x</b>", rate_per_square: 15 } },
  "adder unknown key": { ...GOOD, two_story_adder: { rate_per_square: 15, extra: 1 } },
};
// Cases where the bands array itself is fine and only the envelope / adder is bad: bucketByBands alone has nothing to reject.
const ENVELOPE_ONLY = (n: string) => n.startsWith("adder") || n === "wrong source" || n === "missing source" || n === "unknown top-level key" || n === "array at top level";
for (const [name, raw] of Object.entries(HOSTILE)) {
  Deno.test(`hostile pitch_bands is rejected and falls back: ${name}`, () => {
    assertEquals(m.sanitizePitchBands(raw), null);
    if (ENVELOPE_ONLY(name)) return;
    // bucketByBands handed the hostile value directly (a future caller that skips sanitizePitchBands) also falls back.
    const s = m.bucketByBands(AREAS, raw?.bands !== undefined ? raw.bands : raw);
    assertEquals(s.usedFallback, true, "bucketByBands must use the fallback");
    for (const b of s.buckets) assert(fallbackLabels().includes(b.band.label), `unexpected label ${b.band.label}`);
  });
}

Deno.test("fallback output contains only fallback labels, never a hostile label", () => {
  const s = m.bucketByBands(AREAS, HOSTILE["markup in label"].bands);
  assert(s.buckets.length > 0);
  for (const b of s.buckets) assert(fallbackLabels().includes(b.band.label), `unexpected label ${b.band.label}`);
  assert(!JSON.stringify(s).includes("<script>"));
});

Deno.test("prototype-polluted and exotic objects are rejected", () => {
  class Evil { source = "contractor_rate_card"; bands = GOOD_BANDS; }
  assertEquals(m.sanitizePitchBands(new Evil()), null);
  assertEquals(m.sanitizePitchBands(Object.create({ source: "contractor_rate_card", bands: GOOD_BANDS })), null);
  assertEquals(m.sanitizePitchBands(new Map()), null);
  assertEquals(m.sanitizePitchBands(() => GOOD), null);
});

Deno.test("sanitizer does not mutate its input and returns fresh objects", () => {
  const input = JSON.parse(JSON.stringify(GOOD));
  const frozen = JSON.stringify(input);
  const r = m.sanitizePitchBands(input);
  assertEquals(JSON.stringify(input), frozen);
  assert(r.bands[0] !== input.bands[0]);
});

Deno.test("huge array is rejected before it is iterated (fast)", () => {
  const input = { source: "contractor_rate_card", bands: big(5_000_000) };
  const t = performance.now();
  assertEquals(m.sanitizePitchBands(input), null);
  assert(performance.now() - t < 50, "a huge array must be refused by length, not walked");
});

Deno.test("parentheses in a label are allowed because esc() in the PDF writer escapes them", () => {
  assert(m.sanitizePitchBands({ source: "contractor_rate_card", bands: [{ label: "Steep (7/12 and up)", min_over_12: 7 }] }) !== null);
  assert(src.includes('.replace(/\\(/g, "\\\\(").replace(/\\)/g, "\\\\)")'), "esc() must still escape parentheses");
});

Deno.test("adjacent non-overlapping bands and a single open-ended band are accepted", () => {
  assert(m.sanitizePitchBands({ source: "contractor_rate_card", bands: [{ label: "Low", max_over_12: 4 }, { label: "Mid", min_over_12: 5, max_over_12: 9 }, { label: "High", min_over_12: 10 }] }) !== null);
  assert(m.sanitizePitchBands({ source: "contractor_rate_card", bands: [{ label: "All steep", min_over_12: 5, rate_per_square: 20 }] }) !== null);
});

Deno.test("source wiring: the call site validates, and the rate rows skip the fallback", () => {
  assert(src.includes("sanitizePitchBands(contractorData?.pitch_bands)?.bands ?? null"));
  assert(src.includes("sanitizePitchBands(contractorData?.pitch_bands)?.twoStoryAdder ?? null"));
  assert(!src.includes("contractorData?.pitch_bands?.bands"), "raw column read must be gone");
  assert(src.includes("split.usedFallback ? [] : split.buckets"));
});
