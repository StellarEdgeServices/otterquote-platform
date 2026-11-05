// [gh-3461 / D-390 / REVIEW 6670027861, LEGAL-READ 6669938877] A folded character beside a contact must not hide it: the patterns must not read a folded dash as "-" or a
// fraction as digits when they look for where a contact ends. Both helper copies, through the REAL esc(). NEGATIVE CONTROL: against the helper of 3a861ef7 these fail.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as Shared from "./homeowner-text-redact.ts";
import * as Local from "../send-message-notification/homeowner-text-redact.ts";

const idx = await Deno.readTextFile(new URL("../create-docusign-envelope/index.ts", import.meta.url));
function grab(name: string): string {
  const start = idx.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`not found: ${name}`);
  let depth = 0;
  const open = idx.indexOf("{", start);
  for (let j = open; j < idx.length; j++) {
    if (idx[j] === "{") depth++;
    else if (idx[j] === "}") { depth--; if (depth === 0) return idx.slice(start, j + 1); }
  }
  throw new Error(`unbalanced: ${name}`);
}
const escSrc = "// @ts-nocheck\n" + grab("esc").replace("function esc", "export function esc");
// deno-lint-ignore no-explicit-any
const { esc } = await import("data:application/typescript," + encodeURIComponent(escSrc)) as any;
const printsAs = (t: string): string => String(esc(t)).replace(/\\([\\()])/g, "$1");
const U = (c: number) => String.fromCodePoint(c);

const DASHES = [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015].map(U);
const FRACTIONS = [0xbd, 0xbc, 0xbe].map(U);
const OTHER_FOLDS = [0xb2, 0x2026, 0x2018, 0x2019, 0x201c, 0x201d, 0xff0d].map(U); // the rest of what prints as something other than what was typed
const FOLDS = [...DASHES, ...FRACTIONS, ...OTHER_FOLDS];
const EMAILS = ["jane@gmail.com", "jane@example.co.uk", "jane@proton.me", "jane(at)example.com", "jane @ gmail.com", "jane at example dot com", "jane at example.com", "jane (at) example (dot) com"];
const PHONES = ["317-555-0142", "317.555.0142", "317 555 0142", "(317) 555-0142", "3175550142", "+1 317 555 0142", "13175550142"];
const holdsContact = (p: string) => /\d{7}|\d{3}[-. ]\d{3}[-. ]\d{4}|jane|gmail|example|proton/i.test(p);

// [typed, prints]
const TABLE: Array<[string, string]> = [
  ["jane@gmail.com—thanks", "[removed]-thanks"], ["jane@gmail.com—text is best", "[removed]-text is best"], ["Email jane@example.com—I check it daily", "Email [removed]-I check it daily"],
  ["Email jane@example.com–thanks", "Email [removed]-thanks"], ["jane(at)example.com—thanks", "[removed]-thanks"], ["jane at example dot com—thanks", "[removed]-thanks"],
  ["jane at example.com—thanks", "[removed]-thanks"], ["jane@proton.me—thanks", "[removed]-thanks"], ["Gutters—jane@example.com—Friday", "Gutters-[removed]-Friday"],
  ["jane@example.co.uk—thanks", "[removed]-thanks"], ["Deposit $500—317-555-0142", "Deposit $500-[removed]"], ["Call by 5—317-555-0142", "Call by 5-[removed]"], ["Unit 5–3175550142", "Unit 5-[removed]"],
  ["317-555-0142½", "[removed]1/2"], ["jane@example.com½", "[removed]1/2"], ["jane@example.com¼ mile", "[removed]1/4 mile"],
  // the word beside the dash stays
  ["Email me—jane@example.com", "Email me-[removed]"], ["Call—jane@example.com", "Call-[removed]"],
  // what the earlier detection removed with a mark inside it is still removed
  ["jane@p¹roton.me", "[removed]"], ["jane﹫example.com", "[removed]"], ["jane@proton﹒me", "[removed]"], ["jane@examªple.me", "[removed]"],
];
// Not contacts: all print.
const STAY: Array<[string, string]> = [
  ["$850–$900", "$850-$900"], ["100–250", "100-250"], ["11–15–2026", "11-15-2026"], ["250 – 500 – 1000", "250 - 500 - 1000"], ["Price 1,250–2,500", "Price 1,250-2,500"],
  ["12½ squares", "121/2 squares"], ["sheets@75—Tear off", "sheets@75-Tear off"], ["sheets—@75.Tear off", "sheets-@75.Tear off"], ["Drip edge 10pcs–@12.Gutters excluded", "Drip edge 10pcs-@12.Gutters excluded"], ["Decking ½@75.Tear off", "Decking 1/2@75.Tear off"], ["Drip edge 10pcs@12–14.Gutters excluded", "Drip edge 10pcs@12-14.Gutters excluded"],
  ["Paid 100–250, then 500–1000", "Paid 100-250, then 500-1000"], ["Bob’s roof at noon—call", "Bob's roof at noon-call"], ["$12.​​50", "$12.50"], ["$12.​50", "$12.50"],
];

// REVIEW 6671216392: a quote, ellipsis, fraction or dash before "at" or "@" and a web address does not join a number, a price, a closing quote or a word set off by a space.
// Each prints whole, as on main. NEGATIVE CONTROL: at the helper of 0b5d62ce every row but the plain-quote one is cut.
const WEB_ROWS: Array<[string, string]> = [
  ["Vent 12” at lowes.com, $40", 'Vent 12" at lowes.com, $40'], ['Vent 12" at lowes.com', 'Vent 12" at lowes.com'], ["Ridge cap 33’ at gaf.com", "Ridge cap 33' at gaf.com"],
  ["GAF “Timberline” at gaf.com", 'GAF "Timberline" at gaf.com'], ["Colour “Charcoal” @gaf.com", 'Colour "Charcoal" @gaf.com'], ["Shingles $85½ at store.com", "Shingles $851/2 at store.com"],
  ["Shingles $85½ @acme.co", "Shingles $851/2 @acme.co"], ["Bundle 3¼ at gaf.com", "Bundle 31/4 at gaf.com"], ["Order shingles — at homedepot.com", "Order shingles - at homedepot.com"],
  ["Vent 12’ (at) lowes.com", "Vent 12' (at) lowes.com"], ["Bundle 3¾ (at) gaf.com", "Bundle 33/4 (at) gaf.com"], ["Price 85— at gaf.com", "Price 85- at gaf.com"], 
];
// Same shapes on main: printed. Kept as the review says the narrowing costs, and recorded so a change is deliberate.
const PRINT_AS_MAIN: Array<[string, string]> = [["jane’ at example.com", "jane' at example.com"], ["jane’@example.com", "jane'@example.com"]];
// An ellipsis reads as the three dots it prints as, and dots belong in a local part, so these are cut as "Gutters... at lowes.com" typed plainly is on main (the rule in REVIEW 6671850471).
const ELLIPSIS_ROWS: Array<[string, string]> = [["Gutters\u2026 at lowes.com", "[removed]"], ["Gutters\u2026@lowes.com", "[removed]"], ["jane\u2026 at example.com", "[removed]"], ["jane\u2026@example.com", "[removed]"]];

// REVIEW 6671850471, LEGAL QUESTION 6671472704: the result never depends on which quote a keyboard chose. NEGATIVE CONTROL: at the helper of bf22d662 every row here is cut.
const CURLY: Array<[string, string]> = [["\u2018", "'"], ["\u2019", "'"], ["\u201c", '"'], ["\u201d", '"'], ["\u2026", "..."]];
const QUOTE_ROWS: Array<[string, string]> = [
  ["Shingles $85 at \u201cgaf.com\u201d", 'Shingles $85 at "gaf.com"'], ["Vent 12 at \u201clowes.com\u201d $40", 'Vent 12 at "lowes.com" $40'], ["Order shingles at \u201chomedepot.com\u201d", 'Order shingles at "homedepot.com"'],
  ["Colour \u201cCharcoal\u201d @ \u201cgaf.com\u201d", 'Colour "Charcoal" @ "gaf.com"'], ["Vent 12 \u201cat lowes.com\u201d $40", 'Vent 12 "at lowes.com" $40'], ["Vent 12\u201dat lowes.com", 'Vent 12"at lowes.com'],
  ["Vent 12 at\u2026 lowes.com", "Vent 12 at... lowes.com"], ["Looked at\u2026 roof.com", "Looked at... roof.com"], ["Shingles $85 at \u201cstore.com\u201d", 'Shingles $85 at "store.com"'], ["Vent 12 at \u201cgaf.com\u201d", 'Vent 12 at "gaf.com"'],
  ["GAF at \u201cgaf.com\u201d, $400 per square", 'GAF at "gaf.com", $400 per square'], ["Shingles 400 at\u2026store.com", "Shingles 400 at...store.com"], ["Shop at Lowe\u2019s.com $40", "Shop at Lowe's.com $40"], ["$40 at Lowe\u2019s.com", "$40 at Lowe's.com"],
];
// What the straight form gives, contact or not, the curly form must give too.
const STRAIGHT_ROWS = [
  ...QUOTE_ROWS.map((r) => r[1]), "jane'@example.com", 'jane"@example.com', "jane...@example.com", "jane' at example.com", "jane@o'neil.com", 'jane@example.com"', "'jane@example.com'", '"jane at example dot com"', "jane@example.com's",
  "317'555'0142", '317"555"0142', "317...555...0142", "'317-555-0142'", "317-555-0142...", "Note...jane@example.com", "Bob's at o'neil.com", "250'500'1000'", "Ridge 25' 35' 45' 55' 65'", "$5,000' at gaf.com",
];

// REVIEW 6670618986 B1: a folded character inside the address, right before the at-sign or in the domain.
const INSIDE_FORMS = (c: string) => [
  `jane${c}@example.com`, `Email jane${c}@gmail.com`, `jane${c}@proton.me`, `jane${c}(at)example.com`, `jane${c} at example dot com`, `jane${c} @ example.com`, `jane${c} at example.com`, `jane${c} (at) proton.me`,
];
const IN_DOMAIN_FORMS = (c: string) => [`jane@pro${c}ton.me`, `jane@exam${c}ple.com`, `jane@my${c}site.co.uk`, `jane(at)pro${c}ton.me`, `jane at exam${c}ple.com`, `jane @ exam${c}ple.com`, `jane at exam${c}ple dot com`, `JANE@PRO${c}TON.ME`];
const FRACTION_REST = /1\/[24]@|3\/4@/;

for (const [label, H] of [["shared", Shared], ["local copy", Local]] as const) {
  const before = (t: string) => H.redactSowTextOrRefuse(t, false) as string;
  Deno.test(`gh-3461 folds (${label}): a dash or fraction right before the at-sign, or a dash in the domain, prints no address`, () => {
    for (const c of [...DASHES, ...FRACTIONS]) {
      for (const t of INSIDE_FORMS(c)) {
        const p = printsAs(before(t));
        assert(p.includes(H.REMOVED_TOKEN), `no token: ${JSON.stringify(t)} -> ${p}`);
        assert(!holdsContact(p) && !FRACTION_REST.test(p), `prints: ${JSON.stringify(t)} -> ${p}`);
      }
    }
    for (const c of DASHES) {
      for (const t of IN_DOMAIN_FORMS(c)) {
        const p = printsAs(before(t));
        assert(p.includes(H.REMOVED_TOKEN) && !holdsContact(p), `prints: ${JSON.stringify(t)} -> ${p}`);
      }
    }
  });
  Deno.test(`gh-3461 folds (${label}): words and prices before a web address print as on main, and the joined addresses stay removed`, () => {
    for (const [t, want] of ELLIPSIS_ROWS) assertEquals(before(t), want, JSON.stringify(t));
    for (const [t, want] of [...WEB_ROWS, ...PRINT_AS_MAIN]) {
      assertEquals(before(t), want, JSON.stringify(t));
      assertEquals(printsAs(before(t)), want);
    }
    for (const t of ["jane—@example.com", "jane½@example.com", "jane@pro—ton.me", "jane— at example dot com", "jane–(at)example.com", "j2½@gmail.com", "jane.doe—@gmail.com"]) assertEquals(before(t), H.REMOVED_TOKEN, JSON.stringify(t));
  });
  Deno.test(`gh-3461 folds (${label}): a curly quote, apostrophe or ellipsis gives exactly what the straight character gives, everywhere`, () => {
    for (const r of STRAIGHT_ROWS) {
      for (const [curly, straight] of CURLY) {
        const typedCurly = r.replaceAll(straight, curly);
        assertEquals(before(typedCurly), before(r), JSON.stringify(typedCurly));
      }
    }
    for (const [t, want] of QUOTE_ROWS) assertEquals(before(t), want, JSON.stringify(t));
    // the one place the two differ: main's detection cuts the second address beside an ellipsis, and a contact main removes stays removed
    assertEquals(before("x@y.com\u2026z@w.com"), "[removed]...[removed]");
  });
  Deno.test(`gh-3461 folds (${label}): long hostile runs finish in linear time`, () => {
    const n = 200000;
    const runs = ["\u200b".repeat(n), `end.${"\u200b".repeat(n)}x`, `\u0301`.repeat(n), `.\u0301`.repeat(n / 2), "-".repeat(n), "\u2014".repeat(n), `-\u2014`.repeat(n / 2), `a${"\u2014".repeat(n)}@b.com`, `\u2014@`.repeat(n / 2), `\u00bd`.repeat(n), `${" ".repeat(n)}@`, ` at `.repeat(n / 4), `x\u2014`.repeat(n / 2)];
    runs.push("\u201d".repeat(n), `\u201d @`.repeat(n / 3), `${"a".repeat(n)}\u2014@b`, `a\u00bd @`.repeat(n / 4));
    // REVIEW 6671850471: the word "at" repeated, separated by a dropped or quote character
    runs.push(...["at\n", "at\u{1f642}", "at\u2019", "at\u2026", "x\nat\n", "a at\n", "a@\n", "at\n.", "dot\n", "a\ndot\n", "at\u200b"].map((u) => u.repeat(Math.floor(n / u.length))));
    for (const t of runs) {
      const t0 = performance.now();
      before(t);
      const ms = performance.now() - t0;
      assert(ms < 1500, `${JSON.stringify(t.slice(0, 12))} took ${ms} ms`);
    }
  });
  Deno.test(`gh-3461 folds (${label}): the rows of both comments print as the earlier detection left them`, () => {
    for (const [t, want] of TABLE) {
      assertEquals(before(t), want, JSON.stringify(t));
      assertEquals(printsAs(before(t)), want, JSON.stringify(t));
    }
  });
  Deno.test(`gh-3461 folds (${label}): every dash, fraction and other folded character, on either side of every contact form, prints no contact`, () => {
    for (const c of FOLDS) {
      for (const contact of [...EMAILS, ...PHONES]) {
        for (const t of [`${contact}${c}`, `${c}${contact}`, `${c}${contact}${c}`, `${contact}${c}thanks`, `Note${c}${contact}`, `Note${c}${contact}${c}thanks`, `$500${c}${contact}`, `Unit 5${c}${contact}${c}Friday`]) {
          const p = printsAs(before(t));
          assert(p.includes(H.REMOVED_TOKEN), `no token: ${JSON.stringify(t)} -> ${p}`);
          assert(!holdsContact(p), `contact prints: ${JSON.stringify(t)} -> ${p}`);
        }
      }
    }
  });
  Deno.test(`gh-3461 folds (${label}): the neighbouring word and figure are kept beside a folded dash`, () => {
    for (const c of DASHES) {
      for (const contact of [...EMAILS, ...PHONES]) {
        const p = printsAs(before(`Note $500${c}${contact}${c}thanks`));
        assertEquals(p, "Note $500-[removed]-thanks", JSON.stringify(contact));
      }
    }
  });
  Deno.test(`gh-3461 folds (${label}): text with a dash or fraction and no contact prints whole`, () => {
    for (const [t, want] of STAY) assertEquals(before(t), want, JSON.stringify(t));
  });
  Deno.test(`gh-3461 folds (${label}): a split contact beside a folded character prints no contact`, () => {
    for (const c of FOLDS) {
      for (const t of [`jane@exam\u{1f642}ple.com${c}thanks`, `jane\u{1f642}@example.com${c}thanks`, `317\u{1f642}555\u{1f642}0142${c}thanks`, `Unit 5${c}317\u{1f642}555\u{1f642}0142`]) {
        const p = printsAs(before(t));
        assert(p.includes(H.REMOVED_TOKEN) && !holdsContact(p), `prints: ${JSON.stringify(t)} -> ${p}`);
      }
    }
  });
  Deno.test(`gh-3461 folds (${label}): after the fee everything is as typed, and the output leaves esc() nothing to change`, () => {
    for (const [t] of [...TABLE, ...STAY]) {
      assertEquals(H.redactSowTextOrRefuse(t, true), t);
      assertEquals(printsAs(before(t)), before(t));
    }
  });
}
