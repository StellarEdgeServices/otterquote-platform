// [gh-3461 / D-390] Before the fee the helper returns the exact string the document prints, and the patterns ran on that string. Every row of REVIEW 6668694968,
// REVIEW 6668877014, LEGAL-READ 6668719622 and LEGAL-READ 6668877912 is here, for both helper copies and through the REAL esc() from
// create-docusign-envelope/index.ts. NEGATIVE CONTROL: against the helper of head 2891a9ff these tests fail.
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

const U = (...c: number[]) => String.fromCodePoint(...c);
const ZW = U(0x200b), SHY = U(0xad), EMO = U(0x1f642), D = U(0xb7), B = U(0x2022), EM = U(0x2003), THIN = U(0x2009), TICK = U(0x2713), TAB = "\t", NL = "\n";

// Typed text that holds a contact. What prints must hold no address and no phone, even with the spaces taken out.
const CONTACTS = [
  // REVIEW 6668694968
  `jane${D}@example.com`, `jane${B}@example.com`, `jane@exam${D}ple.com`, `317-${B}555-0142`, `jane@example${D}.com`, `jane@example.${B}com`, `jane(${D}at)example.com`,
  `jane${D} at example dot com`, `31755501${D}42`, `3175${D}550142`, `3${D}1${D}7${D}5${D}5${D}5${D}0${D}1${D}4${D}2`, `note 317.555.014${D}2`, `jane${D}@example.com${EMO}`,
  `317…555…0142`, `317––555––0142`, `317‘555‘0142`, `317“555“0142`, `317${EMO}-${EMO}-555-${ZW}-0142`, `5${EMO}317${EMO}555${EMO}0142`,
  `317${EMO}555${EMO}0142${EMO}9`, `jane@example${EMO}com`, `jane@example${D}com`, `jane@example。com`, `jane${NL}at${NL}example.com`,
  `317${EMO}555${EMO}0142`, `317é555é0142`, `jane${ZW}@example.com`, `jane${SHY}@example.com`, `jane@exam${ZW}ple.com`, `317${D}${EMO}555${D}${EMO}0142`,
  // REVIEW 6668877014 B1, B2
  `jane@exam${NL}ple.com`, `jane@example${NL}.com`, `jane@mail.${NL}example.com`, `jane(at)exam${NL}ple.com`, `jane at exam${NL}ple.com`, `jane @ exam${NL}ple.com`, `jane@exam${U(0x2028)}ple.com`,
  `jane@${ZW}${NL}example.com`, `jane${NL}${ZW}@example.com`, `jane@${EMO}${NL}example.com`,
  `317 ${D}555${D} 0142`, `317${D} 555${D} 0142`, `317 ${D}555 ${D}0142`, `317${D}555${B}0142`, `317${TAB}${D}${TAB}555${TAB}${D}${TAB}0142`,
  `+1 317${D}555${D}0142`, `1${D}317${D}555${D}0142`, `(317)${D}555${D}0142`,
  // LEGAL-READ 6668719622
  `jane${D}@example.com`, `jane@exam${B}ple.com`, `+1${D}317${D}555${D}0142`, `317${NL}555${NL}0142`, `317${TAB}555${TAB}0142`, `jane@${NL}example.com`, `jane@example.${NL}com`,
  // LEGAL-READ 6668877912 Blocking 1 and question 1
  `jane${ZW}@example.com${NL}Thanks`, `jane${EMO}@example.com${NL}Call me`, `jane${D}@example.com${NL}Thanks`, `jane${B}@example.com${NL}Thanks`, `jane@exam${ZW}ple.com${NL}Thanks`,
  `jane(${ZW}at)example.com${NL}Thanks`, `Reach me.${NL}jane${ZW}@example.com`, `Email me${NL}jane${ZW}@example.com`, `jane${ZW}@example.com${NL}123 Main`,
  `jane@example.c${NL}om`, `jane at example.${NL}com`, `Job 12.${NL}317${EMO}555${EMO}0142`, `Unit 5${NL}317${EMO}555${EMO}0142`,
  // the splits of an address next to another line, so the neighbour cannot carry it back
  `jane@exam${EMO}ple.com${NL}Thanks`, `jane@example.${NL}com${NL}Thanks`,
];
const holdsContact = (p: string): boolean => /\d{10}|jane@|example\.com|exampledotcom|example\(dot\)com/i.test(p.replaceAll(" ", "")) || /[a-z.]+@[a-z.]+/i.test(p);

// Typed text with no contact: every word and price must print. [typed, prints]
const AGREED: Array<[string, string]> = [
  // LEGAL-READ 6668719622
  [`Decking 3 sheets@75.${NL}Tear off included`, "Decking 3 sheets@75. Tear off included"], [`Use shingles@400.${NL}Install Friday`, "Use shingles@400. Install Friday"],
  [`Drip edge 10pcs@12.${NL}Gutters excluded`, "Drip edge 10pcs@12. Gutters excluded"], [`Repair at house.${NL}CA rules apply`, "Repair at house. CA rules apply"],
  // REVIEW 6668877014 B3
  [`Drip edge 10pcs@12.${EM}Gutters excluded`, "Drip edge 10pcs@12. Gutters excluded"], [`Use shingles@400.${THIN}Install Friday`, "Use shingles@400. Install Friday"],
  [`Drip edge 10pcs@12.${TICK}Gutters excluded`, "Drip edge 10pcs@12. Gutters excluded"], [`Decking 3 sheets@75.${B}Tear off included`, "Decking 3 sheets@75. Tear off included"],
  [`Repair at house.${ZW}CA rules apply`, "Repair at house. CA rules apply"], [`Use shingles@400.${SHY}Install Friday`, "Use shingles@400. Install Friday"],
  // LEGAL-READ 6668877912 Blocking 2
  [`Drip edge 10pcs@12.${EMO}Gutters excluded`, "Drip edge 10pcs@12. Gutters excluded"], [`Use shingles@400.${EMO}Install Friday`, "Use shingles@400. Install Friday"],
  [`Decking 3 sheets@${NL}75.Tear off`, "Decking 3 sheets@ 75.Tear off"], [`Shingles${NL}@75.Tear off`, "Shingles @75.Tear off"],
  // REVIEW 6668694968, over-redaction and ordinary text
  [`Shingles@store.${NL}Call me`, "Shingles@store. Call me"], [`Tax 250.${NL}300.${NL}1000 total`, "Tax 250. 300. 1000 total"],
  ["Charcoal", "Charcoal"], ["Weathered Wood", "Weathered Wood"], ["Barkwood®", "Barkwood"], ["Timberline® HDZ™ Pewter Gray", "Timberline HDZ Pewter Gray"],
  ["Driftwood — Rustic", "Driftwood - Rustic"], ["Roof pitch 6/12, 2,500 sq ft²", "Roof pitch 6/12, 2,500 sq ft2"], [`Gate code 4412.${NL}Install $1,250.00 by 11/15`, "Gate code 4412. Install $1,250.00 by 11/15"],
  // words that must not read as a TLD across a break
  [`Paid at closing.${NL}net 30 days $5000`, "Paid at closing. net 30 days $5000"], [`Leak at front.${NL}co op board`, "Leak at front. co op board"], [`Paid at closing.${NL}Net amount $5000`, "Paid at closing. Net amount $5000"],
  [`Look at the${NL}dot com era`, "Look at the dot com era"], [`Look at t${NL}he dot com era`, "Look at t he dot com era"], [`Meet @ th${EMO}e dot com booth`, "Meet @ th e dot com booth"], [`Decking 3 sheets@75.${NL}net 30`, "Decking 3 sheets@75. net 30"],
  // a multi-line note keeps every line; line breaks never printed as new lines (addWrappedText splits on spaces only), and now the lines no longer run together
  [`1. Drip edge included${NL}2. Gutters excluded${NL}${NL}3. Price $12,500.00`, "1. Drip edge included 2. Gutters excluded 3. Price $12,500.00"],
];

// Phone-shaped once printed, so removed under ruling 6256934420, exactly like the typed "Paid 250 500 1000" (KNOWN RESIDUAL in sow-redact.test.ts). For the legal reader.
const PHONE_SHAPED: Array<[string, string]> = [
  [`Squares:${NL}250${NL}300${NL}1000`, "Squares: [removed]"], [`Permit 400${NL}500${NL}2026`, "Permit [removed]"], [`Crew 250 300${NL}2026 start`, "Crew [removed] start"],
  [`Price 1250${NL}500${NL}1000`, "Price [removed]"], [`Bid $850${NL}900${NL}1200`, "Bid $[removed]"], [`Bids:${NL}850${NL}900${NL}1200`, "Bids: [removed]"],
  ["£250 £500 £1000", "[removed]"], [`250 ${TICK} 500 ${TICK} 1000`, "[removed]"], [`250 ● 500 ▪ 1000`, "[removed]"], ["250 → 500 → 1000", "[removed]"],
  ["250′ 300′ 1000′", "[removed]"], ["250° 300° 1000°", "[removed]"], ["250€ 500€ 1000€", "[removed]"], ["200×300×1000", "[removed]"],
];

const everyPosition = (s: string, gap: string): string[] => [...Array(s.length - 1).keys()].map((i) => s.slice(0, i + 1) + gap + s.slice(i + 1));
const SHAPES = ["jane@example.com", "jane at example dot com", "jane at example.com", "jane(at)example.com", "jane @ example.com", "jane@mail.example.com", "JANE@EXAMPLE.COM"];
const PHONE_SHAPES = ["317-555-0142", "3175550142", "(317) 555-0142", "+1 317 555 0142"];
const GAPS = [NL, "\r\n", TAB, U(0x2028), EMO, ZW, SHY, D, B, EM];

for (const [label, H] of [["shared", Shared], ["local copy", Local]] as const) {
  const before = (t: string) => H.redactSowTextOrRefuse(t, false) as string;
  Deno.test(`gh-3461 printed (${label}): every contact row of the four reviews prints no contact, through the real esc()`, () => {
    for (const t of CONTACTS) {
      const out = before(t), p = printsAs(out);
      assertEquals(p, out, `esc changed the output of ${JSON.stringify(t)}`);
      assert(!holdsContact(p), `contact prints: ${JSON.stringify(t)} -> ${p}`);
      assert(p.includes(H.REMOVED_TOKEN), `no token: ${JSON.stringify(t)} -> ${p}`);
    }
  });
  Deno.test(`gh-3461 printed (${label}): every agreed-words row of the four reviews prints all its words and prices, through the real esc()`, () => {
    for (const [t, want] of AGREED) {
      assertEquals(before(t), want, JSON.stringify(t));
      assertEquals(printsAs(want), want);
    }
  });
  Deno.test(`gh-3461 printed (${label}): a figure list that prints phone-shaped is removed, as the typed form is (for the legal reader)`, () => {
    for (const [t, want] of PHONE_SHAPED) assertEquals(before(t), want, JSON.stringify(t));
  });
  Deno.test(`gh-3461 printed (${label}): a dropped character at every position of an address or phone prints no plain contact`, () => {
    for (const gap of GAPS) {
      for (const shape of SHAPES) {
        for (const t of everyPosition(shape, gap)) {
          for (const v of [t, `${t}${NL}Thanks`, `Email me${NL}${t}`]) {
            const p = printsAs(before(v));
            assert(!holdsContact(p), `prints: ${JSON.stringify(v)} -> ${p}`);
          }
        }
      }
      for (const shape of PHONE_SHAPES) {
        for (const t of everyPosition(shape, gap)) {
          const p = printsAs(before(t));
          assert(p.includes(H.REMOVED_TOKEN) && !/\d{4}/.test(p), `prints: ${JSON.stringify(t)} -> ${p}`);
        }
      }
    }
  });
  Deno.test(`gh-3461 printed (${label}): any dropped character after an agreed price keeps the words and the price`, () => {
    for (const c of [NL, "\r\n", TAB, EM, THIN, U(0x3000), U(0x202f), U(0x1c), U(0x1d), U(0x1e), U(0x1f), EMO, TICK, B, D, ZW, SHY, U(0x200d), U(0xfeff), "é", U(0x2192)]) {
      assertEquals(before(`Drip edge 10pcs@12.${c}Gutters excluded`), "Drip edge 10pcs@12. Gutters excluded", JSON.stringify(c));
    }
  });
  Deno.test(`gh-3461 printed (${label}): plain ASCII text with no contact is returned untouched, and printing again changes nothing`, () => {
    for (const t of ["Install by 11-15-2026, $1,250.00, 8/12 pitch", "Two  spaces stay", "Paid 250 - 500 - 1000", "Limits 250/500/1000", "(a) back\\slash"]) assertEquals(before(t), t);
    for (const [t] of [...AGREED, ...PHONE_SHAPED]) assertEquals(H.redactSowText(printsAs(before(t))), printsAs(before(t)), JSON.stringify(t));
  });
  Deno.test(`gh-3461 printed (${label}): after the fee the typed text is returned exactly, and a failure still refuses`, () => {
    for (const t of [...CONTACTS, ...AGREED.map((r) => r[0])]) assertEquals(H.redactSowTextOrRefuse(t, true), t);
    let code = "";
    try { H.redactSowTextOrRefuse(CONTACTS[0], false, () => { throw new Error("boom"); }); } catch (e) { code = (e as InstanceType<typeof H.RedactionUnavailableError>).code; }
    assertEquals(code, "d390_redaction_unavailable");
  });
  Deno.test(`gh-3461 printed (${label}): the forms once pinned print no digits, and esc() has nothing left to drop (ruling 6669920816)`, () => {
    for (const t of [`317${D}555${D}0142`, `250 ${B} 500 ${B} 1000`, `250 ${D} 500 ${D} 1000`, `Ring 317${D}555${D}0142 today`, `Line items 250 ${B} 500 ${B} 1000${NL}Next`, `317${B}555${B}0142`, `317 ${B}555 ${B}0142`, `317  ${D}  555  ${D}  0142`, `317${D}555${D}0142${D}9`, `1${ZW}317${D}555${D}0142`, `+1${SHY}317${D}555${D}0142`, `1\u2013317${D}555${D}0142`, `(1)317${D}555${D}0142`, `jane@317${D}555${D}0142.com`, `jane at 317${D}555${D}0142.com`]) {
      const out = before(t);
      assert(out.includes(H.REMOVED_TOKEN), t);
      assertEquals(printsAs(out), out, t);
      assert(!/\d{10}/.test(out), `${t} -> ${out}`);
    }
  });
  Deno.test(`gh-3461 printed (${label}): a long hostile note stays quick`, () => {
    const t0 = performance.now();
    for (const t of [`a${EMO}`.repeat(25000), `a@b${EMO}`.repeat(12000), `a at b${EMO}c `.repeat(6000), `1${EMO}`.repeat(25000), `x.${NL}`.repeat(20000), `a@${"b.".repeat(25000)}`, `jane at ${"x".repeat(50000)}${EMO}`]) before(t);
    assert(performance.now() - t0 < 3000, `took ${performance.now() - t0} ms`);
  });
}
