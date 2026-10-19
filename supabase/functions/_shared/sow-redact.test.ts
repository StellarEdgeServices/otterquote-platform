// gh-2559 / D-390, LEGAL-READ 6256737488 L4: the signed Scope of Work path has its own narrow redaction (redactSowText). Dates, dollar figures
// and ordinary prose must print exactly as typed; phone numbers and e-mail addresses must be removed. LEGACY_MODEL is a JS port of the seven
// patterns of public.d390_redact_contact at eec5544c (the function the SOW used before this change); the NEGATIVE CONTROL test shows it fails
// the must-survive rows, so these rows are a real check and not a tautology.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { redactSowText, redactSowTextOrRefuse, RedactionUnavailableError } from "./homeowner-text-redact.ts";

const A = "[\\p{L}\\p{N}]";
const LEGACY_PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(`${A.replace("]", "._%+-]")}+\\s*@\\s*[\\p{L}\\p{N}-]+(\\s*\\.\\s*[\\p{L}\\p{N}-]+)*`, "gu"), "[removed]"],
  [new RegExp(`${A.replace("]", "._%+-]")}+\\s*(?:[\\(\\[\\{<]\\s*at\\s*[\\)\\]\\}>]|\\s+at\\s+)\\s*\\p{L}[\\p{L}\\p{N}-]*(?:\\s*(?:\\.|[\\(\\[\\{<]\\s*dot\\s*[\\)\\]\\}>]|\\s+dot\\s+)\\s*\\p{L}[\\p{L}\\p{N}-]*)+`, "giu"), "[removed]"],
  [/\S+\s+at\s+\S+\s+dot\s+\S+/gi, "[removed]"],
  [/\S*@\S*/g, "[removed]"],
  [/\b\d{3}[/\\]\d{4}\b/g, "[removed]"],
  [/\(?\d{3}\)?[^\p{L}\p{N},\n]{1,3}\d{3}[^\p{L}\p{N},\n]{1,3}\d{4}(?!\d)/gu, "[removed]"],
  [/(\+?\d[\s().-]*){7,}/g, "[removed] "],
];
function legacyModel(t: string): string {
  let o = t.normalize("NFKD").replace(/([A-Za-z])[̀-ͯ]+/g, "$1").normalize("NFC");
  for (const [re, rep] of LEGACY_PATTERNS) o = o.replace(re, rep);
  return o;
}

const SURVIVE = [
  "Install by 11-15-2026 please",
  "Install by 11.15.2026",
  "Deadline 2026-11-15",
  "Adjuster approved $12500.00 for the roof",
  "Total 18450.75 approved",
  "Paid 1500 - 2000 - 3000",
  "Claim number 0012345678",
  "Claim number 123456789012",
  "Leak at chimney. Please replace flashing",
  "Work at front. Back slope is fine",
  "Work at front.Back slope is fine",
  "Shingles @ 400 per square",
  "Install by 11/15/2026, $1,250.00, 8/12 pitch, 2400 sq ft",
  "café — 40 ft² and ½ inch gap",
  "Call after 5 pm; ask for the 555-0142 line",
];
const REDACT: Array<[string, string]> = [
  ["call (317) 555-0142 today", "call [removed] today"],
  ["call 317-555-0142 today", "call [removed] today"],
  ["call 317.555.0142 today", "call [removed] today"],
  ["call +1 317 555 0142 today", "call [removed] today"],
  ["call 3175550142 today", "call [removed] today"],
  ["call 13175550142 today", "call [removed] today"],
  ["call ３１７－５５５－０１４２ today", "call [removed] today"],
  ["mail jane.doe@example.com now", "mail [removed] now"],
  ["mail jane.doe@example.com. Thanks", "mail [removed]. Thanks"],
  ["mail jane at example dot com now", "mail [removed] now"],
  ["mail jane (at) example (dot) com now", "mail [removed] now"],
  ["mail jane at example.com now", "mail [removed] now"],
  ["mail jane＠example.com now", "mail [removed] now"],
  ["Install by 11-15-2026, call 317-555-0142 or jane@example.com", "Install by 11-15-2026, call [removed] or [removed]"],
];

Deno.test("SOW redaction: every must-survive row prints verbatim", () => {
  for (const t of SURVIVE) assertEquals(redactSowText(t), t, t);
});

Deno.test("SOW redaction: every must-redact row has the contact detail cut out and nothing else changed", () => {
  for (const [t, want] of REDACT) assertEquals(redactSowText(t), want, t);
});

Deno.test("SOW redaction: no truncation (a 50000-character note is redacted whole and finishes quickly)", () => {
  const body = "Replace flashing at the chimney. ".repeat(1500) + "call 317-555-0142";
  const t0 = performance.now();
  const out = redactSowText(body);
  assertEquals(out, "Replace flashing at the chimney. ".repeat(1500) + "call [removed]");
  assert(out.length > 2000);
  const long = "a".repeat(60000);
  assertEquals(redactSowText(long), long);
  assert(performance.now() - t0 < 3000, "linear time");
});

Deno.test("NEGATIVE CONTROL: the eec5544c patterns (legacy model) FAIL the must-survive rows the new path passes", () => {
  const broken = SURVIVE.filter((t) => legacyModel(t) !== t);
  // the rows named in LEGAL-READ 6256737488 must each be damaged by the old rule
  for (const t of [
    "Install by 11-15-2026 please", "Install by 11.15.2026", "Deadline 2026-11-15", "Adjuster approved $12500.00 for the roof",
    "Total 18450.75 approved", "Paid 1500 - 2000 - 3000", "Claim number 0012345678", "Leak at chimney. Please replace flashing",
    "Work at front. Back slope is fine", "Shingles @ 400 per square",
  ]) assert(broken.includes(t), `legacy model should damage: ${t} -> ${legacyModel(t)}`);
  assertNotEquals(legacyModel("café"), "café"); // fold side effect on printed text
  for (const t of SURVIVE) assertEquals(redactSowText(t), t);
});

Deno.test("refusal stays meaningful: an engine error, a non-text value or a non-string result refuses; fee collected and empty text do not run the engine", () => {
  const boom = () => { throw new Error("regex engine failed"); };
  const e = assertThrows(() => redactSowTextOrRefuse("call 317-555-0142", false, boom), RedactionUnavailableError);
  assertEquals((e as RedactionUnavailableError).code, "d390_redaction_unavailable");
  assert(!String((e as Error).message).includes("317"));
  assertThrows(() => redactSowTextOrRefuse("x", false, (() => 42) as unknown as (t: string) => string), RedactionUnavailableError);
  assertThrows(() => redactSowTextOrRefuse({ a: 1 } as unknown as string, false), RedactionUnavailableError);
  assertEquals(redactSowTextOrRefuse("call 317-555-0142", true, boom), "call 317-555-0142");
  assertEquals(redactSowTextOrRefuse("", false, boom), "");
  assertEquals(redactSowTextOrRefuse(null, false, boom), null);
  assertEquals(redactSowTextOrRefuse(undefined, false, boom), null);
  assertEquals(redactSowTextOrRefuse("call 317-555-0142", false), "call [removed]");
  for (const flag of [false, null, undefined, "true", 1] as unknown[]) {
    assertEquals(redactSowTextOrRefuse("x@y.com", flag as boolean), "[removed]");
  }
});
