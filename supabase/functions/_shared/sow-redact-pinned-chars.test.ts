// [gh-3461 / D-390 / review 6668694968 F1] sow-redact.test.ts pins the middle dot and the bullet as NON-separators for phone numbers only
// ("317·555·0142", "250 • 500 • 1000", "250 · 500 · 1000"). esc() drops both characters, so anywhere else they are just dropped characters and the
// contact they hide must be removed. Runs against BOTH copies of the helper (the shared one and send-message-notification's local copy) and
// through the REAL esc() from create-docusign-envelope/index.ts. NEGATIVE CONTROL: at head 85418643 the e-mail forms and the phone forms with a
// pinned character outside the pinned shape print a contact and these tests fail.
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

const D = String.fromCodePoint(0xb7), B = String.fromCodePoint(0x2022), EMO = String.fromCodePoint(0x1f642);
const MUST_REMOVE = [
  // e-mail (no pin covers any e-mail)
  `jane${D}@example.com`, `jane${B}@example.com`, `jane@exam${D}ple.com`, `jane@example${D}.com`, `jane@example.${B}com`, `jane(${D}at)example.com`,
  `jane${D} at example dot com`, `jane${D}@example.com${EMO}`,
  // phone: the pinned character is not between the digit groups of the pinned shape
  `317-${B}555-0142`, `317-${D}555-0142`, `31755501${D}42`, `3175${D}550142`, `3${D}1${D}7${D}5${D}5${D}5${D}0${D}1${D}4${D}2`,
  `3${B}1${B}7${B}5${B}5${B}5${B}0${B}1${B}4${B}2`, `note 317.555.014${D}2`, `317${D}${EMO}555${D}${EMO}0142`,
];
const MUST_STAY = [`317${D}555${D}0142`, `317${B}555${B}0142`, `Line items 250 ${B} 500 ${B} 1000`, `Line items 250 ${D} 500 ${D} 1000`, `Ring 317${D}555${D}0142 today`];

for (const [label, H] of [["shared", Shared], ["local copy", Local]] as const) {
  Deno.test(`gh-3461 F1 (${label}): a contact hidden with a middle dot or bullet outside the pinned phone shape is removed before the fee`, () => {
    for (const t of MUST_REMOVE) {
      const out = H.redactSowTextOrRefuse(t, false) as string;
      const p = printsAs(out);
      assert(out.includes(H.REMOVED_TOKEN), `no token: ${JSON.stringify(t)} -> ${JSON.stringify(out)}`);
      assert(H.redactSowText(p) === p, `still matches on the printed text: ${JSON.stringify(t)} -> ${p}`);
      assert(!/\d{10}|example\.?com|example dot com/i.test(p), `contact prints: ${JSON.stringify(t)} -> ${p}`);
    }
  });
  Deno.test(`gh-3461 F1 (${label}): the three pinned phone forms still print as typed (pin kept, ruling is F2)`, () => {
    for (const t of MUST_STAY) assertEquals(H.redactSowTextOrRefuse(t, false), t);
  });
  Deno.test(`gh-3461 F1 (${label}): after the fee everything prints as typed`, () => {
    for (const t of [...MUST_REMOVE, ...MUST_STAY]) assertEquals(H.redactSowTextOrRefuse(t, true), t);
  });
}
