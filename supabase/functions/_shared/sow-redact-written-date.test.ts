// [gh-3506 / D-390 Amendment 1 / LEGAL-READ 6673925725 A1] A written date keeps its year in the Scope of Work. Before the fee, "Start 11/15/2026<break>1200<break>50" read as the
// phone 202-612-0050 across the breaks and printed "Start 11/15/[removed]". Runs against both copies of the helper, through the real esc().
// NEGATIVE CONTROL: at main (4c3aac0) the date rows are cut at the year ("Start 11/15/[removed]"), so the two per-copy tests fail; only the copy-agreement test passes there.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

const KEEPS_YEAR: Array<[string, string]> = [
  ["Start 11/15/2026\n1200\n50", "Start 11/15/2026 1200 50"], ["Nov 15, 2026\n850\n900", "Nov 15, 2026 850 900"], ["Nov 15 2026\n1200\n50", "Nov 15 2026 1200 50"],
  ["12/1/2026\n850\n900", "12/1/2026 850 900"], ["Date 11/15/2026\n1500\n25", "Date 11/15/2026 1500 25"], ["SEPT 3, 2026\n1200\n50", "SEPT 3, 2026 1200 50"],
  ["Start 11/15/2026\r\n1200\r\n50", "Start 11/15/2026 1200 50"],
];
// A phone that follows a written date is still removed (the year stays); a bare year or a date with no month or slashes gets no exemption.
const STILL_REMOVED: Array<[string, string]> = [
  ["Start 11/15/2026\n317\n555\n0142", "Start 11/15/2026 [removed]"], ["Nov 15, 2026\n317\n555\n0142", "Nov 15, 2026 [removed]"],
  ["Start 11/15/2026\n1200\n50 and call 317\n555\n0142", "Start 11/15/2026 1200 50 and call [removed]"], ["Start 11/15/317\n555\n0142", "Start 11/15/[removed]"],
  ["Start 2026\n1120\n50", "Start [removed]"], ["Start 3\u00b715\u00b72026\u00b7130", "Start [removed]"], ["Call 15 2026\n1200\n50", "Call 15 [removed]"],
  ["850\n900\n1200", "[removed]"], ["Quotes 850\n900\n1200\n1500", "Quotes [removed] 1500"], ["Permit 400\n500\n2026", "Permit [removed]"],
  ["Ring 317\n555\n0142", "Ring [removed]"],
];
for (const [name, H] of [["shared", Shared], ["local", Local]] as const) {
  Deno.test(`[gh-3506] ${name}: a written date keeps its year`, () => {
    for (const [typed, want] of KEEPS_YEAR) assertEquals(printsAs(H.redactSowText(typed)), want, JSON.stringify(typed));
  });
  Deno.test(`[gh-3506] ${name}: a phone after a written date, and every other split run, is still removed`, () => {
    for (const [typed, want] of STILL_REMOVED) assertEquals(printsAs(H.redactSowText(typed)), want, JSON.stringify(typed));
  });
}
Deno.test("[gh-3506] both copies agree on every row", () => {
  for (const [typed] of [...KEEPS_YEAR, ...STILL_REMOVED]) assertEquals(Local.redactSowText(typed), Shared.redactSowText(typed), JSON.stringify(typed));
});

// [ruling 6689811189 / Dustin "Accept (Recommended)" / D-390 best effort] ACCEPTED, NOT PROTECTED: a 201-209 area-code phone whose first four digits are typed straight after a written
// date (as though they were the year), with the rest after line breaks, prints. It is digit for digit the same as "Start 11/15/2026<break>1200<break>50", the row #3506 requires to print, so no
// pattern can keep one and remove the other. These rows pin today's output so a later change shows up; they are not a promise that such a phone is removed. 99/99/2025 is pinned too: the date is not checked for being real.
// Q1 of the same ruling: a bare year and a middle-dot date stay [removed].
const ACCEPTED_PRINTS: Array<[string, string]> = [
  ["Start 11/15/2025\n551\n234", "Start 11/15/2025 551 234"], ["Nov 15, 2025\n551\n234", "Nov 15, 2025 551 234"], ["Nov 15 2025\n551\n234", "Nov 15 2025 551 234"],
  ["Due 1/2/2032\n555\n014", "Due 1/2/2032 555 014"], ["Nov 1, 2025\n55\n0142", "Nov 1, 2025 55 0142"], ["11/1/2025\n55\n0142", "11/1/2025 55 0142"],
  ["Start 11/15/2065\n55\n0142", "Start 11/15/2065 55 0142"], ["May 3 2025\n550\n142", "May 3 2025 550 142"], ["Nov 1, 2025\n550142", "Nov 1, 2025 550142"],
  ["99/99/2025\n55\n0142", "99/99/2025 55 0142"],
];
const Q1_STAYS_REMOVED: Array<[string, string]> = [["Start 2026\n1120\n50", "Start [removed]"], ["Start 3\u00b715\u00b72026\u00b7130", "Start [removed]"]];
for (const [name, H] of [["shared", Shared], ["local", Local]] as const) {
  Deno.test(`[gh-3506 / ruling 6689811189] ${name}: the accepted best-effort phone shapes print as pinned`, () => {
    for (const [typed, want] of ACCEPTED_PRINTS) assertEquals(printsAs(H.redactSowText(typed)), want, JSON.stringify(typed));
  });
  Deno.test(`[gh-3506 / ruling 6689811189 Q1] ${name}: a bare year and a middle-dot date stay [removed]`, () => {
    for (const [typed, want] of Q1_STAYS_REMOVED) assertEquals(printsAs(H.redactSowText(typed)), want, JSON.stringify(typed));
  });
}
Deno.test("[gh-3506 / ruling 6689811189] both copies agree on the accepted rows", () => {
  for (const [typed] of [...ACCEPTED_PRINTS, ...Q1_STAYS_REMOVED]) assertEquals(Local.redactSowText(typed), Shared.redactSowText(typed), JSON.stringify(typed));
});
