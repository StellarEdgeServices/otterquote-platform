// [gh-2881 / D-390] Order of events (D-058): contract signing, then the Platform Fee is charged, then project confirmation. On that path
// claims.platform_fee_charged is already true when the project_confirmation document is built and the notes print as typed (test 2). This guards the
// other case, a document built while platform_fee_charged is not true: the two free-text notes the homeowner typed (work_not_done, project_notes)
// go through the same in-process redaction the Scope of Work uses, so phone-shaped numbers and e-mail addresses are removed (Ben 6256934420) while
// dates, dollar figures and ordinary prose are left as typed. Like no-homeowner-phone.test.ts, this extracts the real autoPopulateFields from
// index.ts (a single-file EF whose top level calls serve()) and runs it against a fake client. NEGATIVE CONTROL: the unpatched source (the two pc
// lines restored) is built from the same slice and must FAIL the same assertions, so the test is a real check and not a tautology.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { redactSowTextOrRefuse, RedactionUnavailableError } from "../_shared/homeowner-text-redact.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  return i;
}
const hoStart = mustFind("async function getHomeownerName(");
const hoEnd = mustFind("const FUNCTION_NAME", hoStart);
const apStart = mustFind("async function autoPopulateFields(");
const apEnd = mustFind("// [gh-1315] Look up the contractor_templates row", apStart);
const slice = src.slice(hoStart, hoEnd) + "\n" + src.slice(apStart, apEnd);

// The extracted functions call redactSowTextOrRefuse as a free identifier; supply the REAL helper (not a stub) through globalThis.
// deno-lint-ignore no-explicit-any
(globalThis as any).redactSowTextOrRefuse = redactSowTextOrRefuse;

async function load(code: string, tag: string) {
  const mod = "// @ts-nocheck\n" + code + `\nexport { autoPopulateFields };\n//${tag}\n`;
  // deno-lint-ignore no-explicit-any
  return (await import("data:application/typescript," + encodeURIComponent(mod)) as any).autoPopulateFields;
}
const autoPopulateFields = await load(slice, "patched");

// The patched statements, as they appear in index.ts. The negative control swaps them back to the pre-gh-2881 lines.
const PATCHED_WND = `work_not_done: redactSowTextOrRefuse(pc.workNotBeingDone ?? null, claimData.platform_fee_charged === true) || "",`;
const PATCHED_PN = `project_notes: redactSowTextOrRefuse(pc.homeownerNotes ?? null, claimData.platform_fee_charged === true) || ""`;
assert(slice.includes(PATCHED_WND), "work_not_done line is not the redacted form in index.ts");
assert(slice.includes(PATCHED_PN), "project_notes line is not the redacted form in index.ts");
const unpatched = slice.replace(PATCHED_WND, `work_not_done: pc.workNotBeingDone || "",`).replace(PATCHED_PN, `project_notes: pc.homeownerNotes || ""`);
const autoPopulateUnpatched = await load(unpatched, "unpatched");

const PHONE = "317-555-0142";
const EMAIL = "jane@example.com";
function tables(feeCharged: boolean | null, pc: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return {
    claims: { id: "claim1", user_id: "u1", property_address: "12 Elm St", trades: ["roofing"], funding_type: "insurance", platform_fee_charged: feeCharged, project_confirmation: pc },
    contractors: { id: "k1", company_name: "Roof Co", phone: "317-555-0999", email: "bids@roofco.example" },
    quotes: { claim_id: "claim1", contractor_id: "k1", total_price: 12000, scope_summary: "{}" },
    profiles: { full_name: "Hannah Homeowner", email: "h@example.com", phone: PHONE },
    contractor_licenses: {},
  };
}
// deno-lint-ignore no-explicit-any
function fake(t: Record<string, Record<string, unknown>>): any {
  return {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        limit() { return Promise.resolve({ data: table === "contractor_licenses" ? [] : [t[table] ?? {}], error: null }); },
        single() { return Promise.resolve({ data: t[table] ?? {}, error: null }); },
        maybeSingle() { return Promise.resolve({ data: t[table] ?? {}, error: null }); },
      };
      return chain;
    },
  };
}
const NOTES = {
  workNotBeingDone: `Fence repair, call ${PHONE} or ${EMAIL}. Finish by 11-15-2026, budget $12500.00, Shingles @ 400 per square`,
  homeownerNotes: `Gate code 4412; text ${PHONE}`,
  shingleManufacturer: "GAF",
};
const run = (fn: typeof autoPopulateFields, fee: boolean | null) =>
  fn(fake(tables(fee, NOTES)), "claim1", "k1", "Hannah Homeowner", "h@example.com", "project_confirmation");

Deno.test("gh-2881: before the fee, work_not_done and project_notes lose phone and e-mail but dates, figures and prose print as typed", async () => {
  for (const fee of [false, null]) {
    const { fields } = await run(autoPopulateFields, fee);
    assert(!fields.work_not_done.includes(PHONE) && !fields.work_not_done.includes(EMAIL), `work_not_done leaked: ${fields.work_not_done}`);
    assert(!fields.project_notes.includes(PHONE), `project_notes leaked: ${fields.project_notes}`);
    assertEquals(fields.work_not_done, "Fence repair, call [removed] or [removed]. Finish by 11-15-2026, budget $12500.00, Shingles @ 400 per square");
    assertEquals(fields.project_notes, "Gate code 4412; text [removed]");
    assertEquals(fields.shingle_manufacturer, "GAF"); // other fields untouched
  }
});

Deno.test("gh-2881: after the fee (platform_fee_charged === true) the notes print unchanged", async () => {
  const { fields } = await run(autoPopulateFields, true);
  assertEquals(fields.work_not_done, NOTES.workNotBeingDone);
  assertEquals(fields.project_notes, NOTES.homeownerNotes);
});

Deno.test("gh-2881: empty or absent notes stay empty strings", async () => {
  const { fields } = await autoPopulateFields(fake(tables(false, { shingleManufacturer: "GAF" })), "claim1", "k1", "H", "h@example.com", "project_confirmation");
  assertEquals(fields.work_not_done, "");
  assertEquals(fields.project_notes, "");
});

Deno.test("gh-2881: a note that cannot be redacted refuses (RedactionUnavailableError), it never prints raw", async () => {
  // a non-text value reaches the helper as the jsonb value: the helper refuses it
  await assertRejects(
    () => autoPopulateFields(fake(tables(false, { workNotBeingDone: { not: "text" } })), "claim1", "k1", "H", "h@example.com", "project_confirmation"),
    RedactionUnavailableError,
  );
});

Deno.test("NEGATIVE CONTROL: the pre-gh-2881 lines print the raw phone and e-mail into work_not_done and project_notes", async () => {
  const { fields } = await run(autoPopulateUnpatched, false);
  assert(fields.work_not_done.includes(PHONE) && fields.work_not_done.includes(EMAIL), "the unpatched source should leak work_not_done");
  assert(fields.project_notes.includes(PHONE), "the unpatched source should leak project_notes");
});
