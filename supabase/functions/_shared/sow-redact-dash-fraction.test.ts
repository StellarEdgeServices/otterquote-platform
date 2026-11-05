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
  ["12½ squares", "121/2 squares"], ["sheets@75—Tear off", "sheets@75-Tear off"], ["Drip edge 10pcs@12–14.Gutters excluded", "Drip edge 10pcs@12-14.Gutters excluded"],
  ["Paid 100–250, then 500–1000", "Paid 100-250, then 500-1000"], ["Bob’s roof at noon—call", "Bob's roof at noon-call"], ["$12.​​50", "$12.50"], ["$12.​50", "$12.50"],
];

for (const [label, H] of [["shared", Shared], ["local copy", Local]] as const) {
  const before = (t: string) => H.redactSowTextOrRefuse(t, false) as string;
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
