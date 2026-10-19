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
  // fix2880d B1 (item@price) and B2 (figure lists with spaced separators)
  "3 bundles@32.50 each",
  "Drip edge 10pcs@12.50",
  "Shingles@400.00/sq",
  "Shingles @400 per square",
  "Shingles@ 400 per sq",
  "2 rolls@85",
  "ice & water 2 rolls @ 85.00",
  "Paid 250 - 500 - 1000",
  "Paid 250 . 500 . 1000",
  "Bids 850, 900, 1200",
  "Policy 123456789012",
  "Window 10:30-12:00 on 11/15",
  "Meet at gate dot five",
  "Leak at back dot matrix",
  "Paid at closing.Net amount $5000",
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
  // fix2880d B3 (regression: spaces around the at-sign, case-insensitive (at)/(dot), space before the dot) and advisories
  ["jane @ gmail.com", "[removed]"],
  ["jane@ gmail.com", "[removed]"],
  ["jane @gmail.com", "[removed]"],
  ["jane@gmail .com", "[removed]"],
  ["jane(AT)gmail.com", "[removed]"],
  ["jane (AT) gmail (DOT) com", "[removed]"],
  ["jane AT gmail DOT com", "[removed]"],
  ["JANE@GMAIL.COM", "[removed]"],
  ["jane at gmail.co.uk", "[removed]"],
  ["jane at gmail dot co dot uk", "[removed]"],
  ["jane at yahoo.ca", "[removed]"],
  ["jane at proton.me", "[removed]"],
  ["jane at mail.dev", "[removed]"],
  ["jane at mail.io", "[removed]"],
  ["mail jane@example.com.", "mail [removed]."],
  ["317/555-0142", "[removed]"],
  ["317\u00b7555\u00b70142", "[removed]"],
  ["317 \u2022 555 \u2022 0142", "[removed]"],
  ["317_555_0142", "[removed]"],
  ["317\u2013555\u20130142", "[removed]"],
  ["(317)555-0142", "[removed]"],
  ["317-555-0142 ext 12", "[removed] ext 12"],
  ["Install by 11-15-2026, call 317-555-0142 or jane@example.com", "Install by 11-15-2026, call [removed] or [removed]"],
];

Deno.test("SOW redaction: every must-survive row prints verbatim", () => {
  for (const t of SURVIVE) assertEquals(redactSowText(t), t, t);
});

Deno.test("SOW redaction: every must-redact row has the contact detail cut out and nothing else changed", () => {
  for (const [t, want] of REDACT) assertEquals(redactSowText(t), want, t);
});

// KNOWN RESIDUAL (carve-out question for Ben, not solved here): these are phone-shaped and ARE removed. Asserting the current behaviour keeps it visible.
Deno.test("KNOWN RESIDUAL: bare 3-3-4 figures with groups starting 2-9, and 10-digit numbers starting 2-9, are removed as phone-shaped", () => {
  assertEquals(redactSowText("Paid 250-500-1000"), "Paid [removed]");
  assertEquals(redactSowText("Paid 250 500 1000"), "Paid [removed]");
  assertEquals(redactSowText("Policy 9876543210"), "Policy [removed]");
  assertEquals(redactSowText("Looked at roof.com was not involved"), "[removed] was not involved"); // spelled-at plus common TLD cannot tell a word from a handle
});

// the patterns of head 2f6d1753 (one-separator rule, letters-only TLD and the B3 forms were absent); a second negative control
const PREV_SEP = "[ \\t\\u00a0\\u00ad\\u200b-\\u200d\\u2060\\ufeff.\\-\\u2010-\\u2015]";
const PREV_LOCAL = "(?<![A-Za-z0-9._%+\\-])[A-Za-z0-9._%+\\-]+";
const PREV_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9\\-]*[A-Za-z0-9])?";
const PREV_DOT = "(?:[ \\t]*[\\(\\[\\{<][ \\t]*dot[ \\t]*[\\)\\]\\}>][ \\t]*|[ \\t]+dot[ \\t]+)";
const PREV_PATTERNS: RegExp[] = [
  new RegExp(`(?<!\\d)(?<!\\d[.,\\-])(?:\\+?1${PREV_SEP}*)?(?:\\(\\s*[2-9]\\d{2}\\s*\\)|[2-9]\\d{2})${PREV_SEP}*[2-9]\\d{2}${PREV_SEP}*\\d{4}(?!\\d)(?![.,]\\d)`, "g"),
  new RegExp(`${PREV_LOCAL}(?:@|[ \\t]*[\\(\\[\\{<][ \\t]*at[ \\t]*[\\)\\]\\}>][ \\t]*)${PREV_LABEL}(?:(?:${PREV_DOT}|\\.)${PREV_LABEL})+(?![A-Za-z0-9\\-])`, "g"),
  new RegExp(`${PREV_LOCAL}[ \\t]+at[ \\t]+${PREV_LABEL}(?:\\.${PREV_LABEL})*${PREV_DOT}${PREV_LABEL}(?:(?:${PREV_DOT}|\\.)${PREV_LABEL})*(?![A-Za-z0-9\\-])`, "gi"),
  new RegExp(`${PREV_LOCAL}[ \\t]+at[ \\t]+${PREV_LABEL}(?:\\.${PREV_LABEL})*\\.(?:com|net|org|edu|gov|io|co|us|biz|info)(?![A-Za-z0-9\\-])`, "gi"),
];
const prevModel = (t: string) => PREV_PATTERNS.reduce((o, re) => o.replace(re, "[removed]"), t);

Deno.test("NEGATIVE CONTROL 2 (head 2f6d1753): the previous SOW patterns damage the fix2880d must-survive rows and leak the B3 / advisory forms", () => {
  for (const t of ["3 bundles@32.50 each", "Drip edge 10pcs@12.50", "Shingles@400.00/sq", "Paid 250 - 500 - 1000", "Paid 250 . 500 . 1000"]) {
    assertNotEquals(prevModel(t), t, `previous patterns should damage: ${t}`);
  }
  for (const t of ["jane @ gmail.com", "jane@ gmail.com", "jane @gmail.com", "jane@gmail .com", "jane(AT)gmail.com", "jane (AT) gmail (DOT) com", "317/555-0142", "317\u00b7555\u00b70142", "jane at yahoo.ca", "jane at gmail.co.uk"]) {
    assert(!/^\[removed\]$/.test(prevModel(t)), `previous patterns should leak (not fully redact): ${t} -> ${prevModel(t)}`);
    assertEquals(redactSowText(t), "[removed]", t);
  }
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
