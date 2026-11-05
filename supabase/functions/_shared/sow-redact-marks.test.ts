// [gh-3461 / D-390 / LEGAL-READ 6669633277] A compatibility form must not print as a digit it was not typed as, and the pin exemption covers ASCII digits only.
// Both helper copies, through the REAL esc() from create-docusign-envelope/index.ts. NEGATIVE CONTROL: against the helper of head f421e5ff these tests fail.
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

const AR = (d: string) => [...d].map((c) => (/\d/.test(c) ? String.fromCharCode(0x0660 + Number(c)) : c)).join("");
const FW = (d: string) => [...d].map((c) => (/\d/.test(c) ? String.fromCharCode(0xff10 + Number(c)) : c)).join("");
const D = "·", B = "•";

// The legal read's table, then the other marks NFKC turns into a digit.
const PRICES: Array<[string, string]> = [
  ["$5,000¹", "$5,000"], ["Price $5,000³ see note", "Price $5,000 see note"], ["$1,250⁰", "$1,250"], ["$850₁", "$850"], ["$850①", "$850"], ["8/12¹ pitch", "8/12 pitch"],
  ["$5,000⁴", "$5,000"], ["$5,000⁹ net", "$5,000 net"], ["$5,000₀", "$5,000"], ["$5,000₉ net", "$5,000 net"], ["$850⓪", "$850"], ["$850⑳ net", "$850 net"],
  ["$850⑴", "$850"], ["$850⒈", "$850"], ["$850❶", "$850"], ["$5,000¹⁰", "$5,000"], ["$5,000¹ and $6,000³ total", "$5,000 and $6,000 total"],
  // marks that fold to a letter or a sign print nothing either
  ["$5,000ᵃ", "$5,000"], ["$5⁺", "$5"], ["20ℓ tank", "20 tank"], ["Phase Ⅰ done", "Phase done"],
  // fractions esc() does not fold: nothing is added to the figure
  ["$5,000⅓", "$5,000"], ["$850⅛ net", "$850 net"], ["$850↉", "$850"],
  // full-width and Arabic-Indic digits are the digits typed, so they print as themselves, and a mark after them adds nothing
  [`$${FW("5")}，${FW("000")}`, "$5,000"], [`＄${FW("5,000")}`, "$5,000"], [`$${FW("1,250.00")} total`, "$1,250.00 total"], [`$${FW("5,000")}¹`, "$5,000"],
  [`$${AR("850")}¹`, "$850"], [`Ref ${AR("2026")} ok`, "Ref 2026 ok"],
];
// esc() folds these on main as well, before and after the fee. Kept as they print today; recorded so a change is deliberate.
const AS_TODAY: Array<[string, string]> = [["$5,000²", "$5,0002"], ["$850½", "$8501/2"], ["$850¼", "$8501/4"], ["$850¾", "$8503/4"], ["40 ft²", "40 ft2"], ["1½ inch", "11/2 inch"]];

const NON_ASCII_PINS = [
  `${AR("317")}${D}${AR("555")}${D}${AR("0142")}`, `${FW("317")}${D}${FW("555")}${D}${FW("0142")}`, `${AR("317")} ${B} ${AR("555")} ${B} ${AR("0142")}`, `${FW("317")} ${B} ${FW("555")} ${B} ${FW("0142")}`,
  `${AR("317")} ${D} ${AR("555")} ${D} ${AR("0142")}`, `${FW("317")}${D}555${D}0142`, `317${D}${FW("555")}${D}0142`, `317${D}555${D}${AR("0142")}`,
  `１${D}317${D}555${D}0142`, `+١ 317${D}555${D}0142`, `317${D}555${D}0142${D}${FW("9")}`,
];

for (const [label, H] of [["shared", Shared], ["local copy", Local]] as const) {
  const before = (t: string) => H.redactSowTextOrRefuse(t, false) as string;
  Deno.test(`gh-3461 marks (${label}): a superscript, subscript, circled or similar mark never prints as part of a figure`, () => {
    for (const [t, want] of PRICES) {
      assertEquals(before(t), want, JSON.stringify(t));
      assertEquals(printsAs(before(t)), want, JSON.stringify(t));
    }
  });
  Deno.test(`gh-3461 marks (${label}): the characters esc() itself folds print as they do today`, () => {
    for (const [t, want] of AS_TODAY) {
      assertEquals(printsAs(t), want, `esc changed: ${JSON.stringify(t)}`);
      assertEquals(printsAs(before(t)), want, JSON.stringify(t));
    }
  });
  Deno.test(`gh-3461 marks (${label}): no digit prints that the typed text did not hold as a digit, for every BMP character after a price`, () => {
    for (let c = 0; c < 0x10000; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const ch = String.fromCharCode(c);
      if (/[\p{Nd}\p{Cc}]/u.test(ch) || /[²¼-¾]/.test(ch)) continue; // a typed digit prints; the esc() folds are AS_TODAY
      const p = printsAs(before(`$850${ch} net`));
      assert(/^\$850[^0-9]* net$/.test(p) || p.includes(H.REMOVED_TOKEN), `U+${c.toString(16)} -> ${p}`);
    }
  });
  Deno.test(`gh-3461 marks (${label}): a phone in non-ASCII digits gets no pin exemption and is removed`, () => {
    for (const t of NON_ASCII_PINS) {
      const p = printsAs(before(t));
      assert(p.includes(H.REMOVED_TOKEN), `kept: ${JSON.stringify(t)} -> ${p}`);
      assert(!/\d{3}/.test(p), `digits print: ${JSON.stringify(t)} -> ${p}`);
    }
  });
  Deno.test(`gh-3461 marks (${label}): the three pinned ASCII forms are unchanged, and after the fee everything is as typed`, () => {
    for (const t of [`317${D}555${D}0142`, `250 ${B} 500 ${B} 1000`, `250 ${D} 500 ${D} 1000`]) assertEquals(before(t), t);
    for (const t of [...PRICES.map((r) => r[0]), ...NON_ASCII_PINS]) assertEquals(H.redactSowTextOrRefuse(t, true), t);
  });
  Deno.test(`gh-3461 marks (${label}): a contact in compatibility or full-width characters still prints no contact`, () => {
    for (const t of [`${FW("3175550142")}`, `${AR("3175550142")}`, `${FW("317")}－${FW("555")}－${FW("0142")}`, "jane＠example.com", "jane@example．com", "317¹555¹0142", "jane¹@example.com", "jane@exam¹ple.com"]) {
      assert(printsAs(before(t)).includes(H.REMOVED_TOKEN), JSON.stringify(t));
    }
    for (const t of ["³¹⁷⁵⁵⁵⁰¹⁴²", "③①⑦⑤⑤⑤⓪①④②"]) assert(!/\d{3}/.test(printsAs(before(t))), JSON.stringify(t));
  });
}
