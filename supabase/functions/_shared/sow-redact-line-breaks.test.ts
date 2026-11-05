// [gh-3461 / D-390 / LEGAL-READ 6668719622] esc() drops line breaks and tabs, so two lines of a note print joined. Detection on the printed form must
// not read "sheets@75.<break>Tear off" as an e-mail address and delete agreed words and prices from the signed Scope of Work. Runs against both copies
// of the helper. NEGATIVE CONTROL: at head 85418643 every MUST_SURVIVE row below is cut ("Decking 3 [removed] off included") and the survive test fails.
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

const LS = String.fromCodePoint(0x2028);
const MUST_SURVIVE = [
  "Decking 3 sheets@75.\nTear off included", "Use shingles@400.\nInstall Friday", "Drip edge 10pcs@12.\nGutters excluded", "Repair at house.\nCA rules apply",
  "Decking 3 sheets@75.\r\nTear off included", "Use shingles@400.\tInstall Friday", `Use shingles@400.${LS}Install Friday`, "Repair at house.\n\nCA rules apply",
  "Leak at front.\nin the valley", "Price $12500.00\nFinish by 11-15-2026\nGutters excluded",
];
const MUST_REMOVE = ["317\n555\n0142", "317\t555\t0142", "317\r\n555\r\n0142", "jane@\nexample.com", "jane\n@example.com", "jane @\n example.com", "Ring jane@\r\nexample.com now"];

for (const [label, H] of [["shared", Shared], ["local copy", Local]] as const) {
  Deno.test(`gh-3461 legal (${label}): agreed words and prices across a line break or tab print as typed before the fee`, () => {
    for (const t of MUST_SURVIVE) assertEquals(H.redactSowTextOrRefuse(t, false), t, `cut: ${JSON.stringify(t)}`);
  });
  Deno.test(`gh-3461 legal (${label}): a contact split by a line break or tab at the digits or beside the at-sign is still removed`, () => {
    for (const t of MUST_REMOVE) {
      const out = H.redactSowTextOrRefuse(t, false) as string;
      const p = printsAs(out);
      assert(out.includes(H.REMOVED_TOKEN), `kept: ${JSON.stringify(t)}`);
      assert(H.redactSowText(p) === p && !/\d{10}|example\.com/.test(p), `prints a contact: ${JSON.stringify(t)} -> ${p}`);
    }
  });
}
