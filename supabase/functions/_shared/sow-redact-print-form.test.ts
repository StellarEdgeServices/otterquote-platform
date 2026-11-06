// [gh-3461 / D-390] The Scope of Work PDF prints every string through esc() (create-docusign-envelope/index.ts), which DROPS characters outside
// space..tilde AFTER the helper has redacted. A contact written with such characters between its digits or letters printed as a plain contact
// (review 6668236698 on #3456). These tests run the REAL esc() from index.ts on the helper's output and require that nothing which prints as a
// phone number or e-mail address survives, before the fee. NEGATIVE CONTROL: on main (helper without printForm) the "before the fee" tests that carry a contact fail; the after-fee, no-contact and fail-closed tests pass there by design.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as H from "./homeowner-text-redact.ts";

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
// What a reader of the PDF sees: esc() output with the PDF string escapes taken off again.
const printsAs = (t: string): string => String(esc(t)).replace(/\\([\\()])/g, "$1");
// Before the fee the helper's output is what prints: esc() has nothing left to drop or fold.
// A contact survives when the SOW patterns still match anything in what prints.
const survives = (t: string): boolean => H.redactSowText(printsAs(t)) !== printsAs(t);
const before = (t: string): string => H.redactSowTextOrRefuse(t, false) as string;

const U = (...cps: number[]) => String.fromCodePoint(...cps);
const ZW = U(0x200b), SHY = U(0x00ad), EMO = U(0x1f642), E = U(0xe9);

const PHONES = [
  `317${EMO}555${EMO}0142`, `317${E}555${E}0142`, `Ring 317${EMO}555${EMO}0142 today`,
  `317${U(0x4e2d)}555${U(0x4e2d)}0142`, `317${U(0x200d)}555${U(0x2060)}0142`, `(317)${EMO}555${EMO}0142`, `+1${EMO}317${EMO}555${EMO}0142`,
  `3${EMO}1${EMO}7${EMO}5${EMO}5${EMO}5${EMO}0${EMO}1${EMO}4${EMO}2`, `317́555́0142`, `317\t555\t0142`, `317\n555\n0142`, `317\r\n555\r\n0142`,
  `317${U(0xfe0f)}-555${U(0xfe0f)}-0142`, `317${U(0x2192)}555${U(0x2192)}0142`,
];
const EMAILS = [
  `jane${ZW}@example.com`, `jane${SHY}@example.com`, `jane@exam${ZW}ple.com`, `ja${EMO}ne@example.com`, `jane@example${EMO}.com`, `jane@example.${EMO}com`,
  `jane${E}@example.com`, `jane@${EMO}example.com`, `jane${U(0xfeff)}@example.com`, `jane\t@example.com`, `jane@example.c${ZW}om`,
  `JANE@EXAMPLE.COM`, `jane(${ZW}at)example.com`, `jane at exam${EMO}ple dot com`, `jane${EMO} at example dot com`,
];

Deno.test("gh-3461: a phone number with characters the document drops between its digits does not print, before the fee", () => {
  for (const t of PHONES) {
    const out = before(t);
    assert(!survives(out), `phone prints after redaction: ${JSON.stringify(t)} -> ${JSON.stringify(out)} -> ${printsAs(out)}`);
    assert(!/\d{10}/.test(printsAs(out)), `digits joined: ${printsAs(out)}`);
    assert(out.includes(H.REMOVED_TOKEN), `no token: ${JSON.stringify(out)}`);
  }
});

Deno.test("gh-3461: an e-mail address with characters the document drops inside it does not print, before the fee", () => {
  for (const t of EMAILS) {
    const out = before(t);
    assert(!survives(out), `e-mail prints after redaction: ${JSON.stringify(t)} -> ${JSON.stringify(out)} -> ${printsAs(out)}`);
    assert(!/example\.com|example dot com/i.test(printsAs(out)), `domain prints: ${printsAs(out)}`);
  }
});

Deno.test("gh-3461: the reviewer's inputs, as the notes, colour and brand fields would carry them", () => {
  // review 6668236698: these printed 3175550142 / jane@example.com
  const rows: Array<[string, RegExp]> = [
    [`317${EMO}555${EMO}0142`, /3175550142/], [`317${E}555${E}0142`, /3175550142/],
    [`jane${ZW}@example.com`, /jane@example\.com/], [`jane${SHY}@example.com`, /jane@example\.com/], [`jane@exam${ZW}ple.com`, /jane@example\.com/],
  ];
  for (const [t, bad] of rows) {
    assert(!bad.test(printsAs(before(`Leak. Ring ${t} or text`))), `still prints: ${t}`);
    assert(!bad.test(printsAs(before(`Charcoal ${t}`))), `colour still prints: ${t}`);
  }
});

Deno.test("gh-3461: after the fee the text is returned exactly as typed", () => {
  for (const t of [...PHONES, ...EMAILS]) assertEquals(H.redactSowTextOrRefuse(t, true), t);
});

Deno.test("gh-3461: text with no contact, including non-ASCII characters, loses no word or figure before the fee", () => {
  const rows: Array<[string, string]> = [
    [`Leak near chimney ${EMO} please call after 5`, "Leak near chimney please call after 5"], [`caf${E} ${U(0xbd)} ft${U(0xb2)} 12500.00`, "caf 1/2 ft2 12500.00"],
    [`Budget 1,250.00 by 11-15-2026 ${ZW}ok`, "Budget 1,250.00 by 11-15-2026 ok"], [`Limits 250/500/1000`, "Limits 250/500/1000"], [`Shingles @ 400 per square`, "Shingles @ 400 per square"],
    [`Gate code 4412${EMO}5512`, "Gate code 4412 5512"], [`Claim 123456789012${EMO}34`, "Claim 123456789012 34"], [`Meet at 5${EMO}30${EMO}pm`, "Meet at 5 30 pm"],
  ];
  for (const [t, want] of rows) assertEquals(before(t), want, `over-redacted: ${JSON.stringify(t)}`);
});

Deno.test("gh-3461: only the contact is cut out; the words around it still print", () => {
  assertEquals(before(`caf${E} ${EMO} call 317${EMO}555${EMO}0142 ${E}nd`), `caf call ${H.REMOVED_TOKEN} nd`);
  assertEquals(before(`a ${U(0xbd)} jane${ZW}@example.com b`), `a 1/2 ${H.REMOVED_TOKEN} b`);
});

Deno.test("gh-3461: the middle dot and the bullet are dropped characters like any other (ruling 6669920816)", () => {
  assertEquals(before(`317${U(0xb7)}555${U(0xb7)}0142`), H.REMOVED_TOKEN);
  assertEquals(before(`Line items 250 ${U(0x2022)} 500 ${U(0x2022)} 1000`), `Line items ${H.REMOVED_TOKEN}`);
  assert(!survives(before(`317${U(0xb7)}${EMO}555${U(0xb7)}${EMO}0142`)));
});

Deno.test("gh-3461: still fails closed for the pre-fee case", () => {
  let threw = false;
  try { H.redactSowTextOrRefuse(`317${EMO}555${EMO}0142`, false, () => { throw new Error("boom"); }); } catch (e) { threw = e instanceof H.RedactionUnavailableError; }
  assert(threw);
  threw = false;
  try { H.redactSowTextOrRefuse(`317${EMO}555${EMO}0142`, null as unknown as boolean, () => 5 as unknown as string); } catch (e) { threw = e instanceof H.RedactionUnavailableError; }
  assert(threw);
});

Deno.test("gh-3461: for every BMP character and a sample of astral ones, printForm leaves esc() nothing to drop, and nothing joins", () => {
  const printForm = H.printForm;
  const cps: number[] = [];
  for (let c = 0; c < 0x10000; c++) if (c < 0xd800 || c > 0xdfff) cps.push(c);
  for (const c of [0x1f642, 0x10000, 0x1d7d8, 0x10ffff]) cps.push(c);
  for (const c of cps) {
    const ch = String.fromCodePoint(c);
    const t = `a${ch}b`;
    const { printed, marked } = printForm(t);
    assertEquals(printsAs(printed), printed, `esc would still change U+${c.toString(16)}`);
    assertEquals(marked.length, printed.length);
    const typedKept = printsAs(t) !== "ab"; // esc prints something for it: same result, folds included (compatibility forms print their plain form)
    if (typedKept) assertEquals(printed, printsAs(t), `differs from esc for U+${c.toString(16)}`);
    assert(/^a.*b$/.test(printed), `U+${c.toString(16)}: ${printed}`);
    if (!typedKept && printed === "ab") assert(/[\p{Cf}\p{Mn}\p{Me}]/u.test(ch.normalize("NFKC")), `U+${c.toString(16)} joined the words but has width`);
  }
});
