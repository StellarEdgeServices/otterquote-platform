// [gh-2828 / D-386] The contract is created at selection, before the Platform Fee clears.
// Dustin's ruling (#2828, #2559, 2026-10-16): the homeowner's PHONE is not on that contract;
// her EMAIL stays, only as the signing address. index.ts is a single-file EF whose top level
// calls serve(), so (like template-invariant-wiring.test.ts) this extracts the real functions
// from the source text and runs them against a fake client.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

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
const modSrc = "// @ts-nocheck\n" + src.slice(hoStart, hoEnd) + "\n" + src.slice(apStart, apEnd) +
  "\nexport { autoPopulateFields };\n";
// deno-lint-ignore no-explicit-any
const { autoPopulateFields } = await import("data:application/typescript," + encodeURIComponent(modSrc)) as any;

const PHONE = "317-555-0142";
const PHONE_DIGITS = "3175550142";
const SIGNER_EMAIL = "homeowner.signer@example.com";
const TABLES: Record<string, Record<string, unknown>> = {
  claims: { id: "claim1", user_id: "u1", property_address: "12 Elm St", carrier_name: "Acme Mutual", claim_number: "C-1", trades: ["roofing"], funding_type: "insurance" },
  contractors: { id: "k1", company_name: "Roof Co", phone: "317-555-0999", email: "bids@roofco.example", address_line1: "1 Main", address_city: "Zionsville", address_state: "IN", address_zip: "46077" },
  quotes: { claim_id: "claim1", contractor_id: "k1", total_price: 12000, scope_summary: "{}" },
  profiles: { full_name: "Hannah Homeowner", email: SIGNER_EMAIL, phone: PHONE, address_city: "Zionsville", address_state: "IN", address_zip: "46077", address_street: "12 Elm St" },
  contractor_licenses: {},
};
// The fake honours .select(cols): a column that is not selected is not returned, exactly like PostgREST.
// deno-lint-ignore no-explicit-any
function fakeSupabase(selects: Record<string, string[]> = {}): any {
  return {
    from(table: string) {
      let cols: string[] | null = null;
      const row = () => {
        const full = TABLES[table] ?? {};
        if (!cols || cols[0] === "*") return { ...full };
        return Object.fromEntries(cols.filter((c) => c in full).map((c) => [c, full[c]]));
      };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select(c: string) { cols = c.split(",").map((x) => x.trim()); (selects[table] ??= []).push(...cols); return chain; },
        eq() { return chain; },
        limit() { return Promise.resolve({ data: table === "contractor_licenses" ? [] : [row()], error: null }); },
        single() { return Promise.resolve({ data: row(), error: null }); },
        maybeSingle() { return Promise.resolve({ data: row(), error: null }); },
      };
      return chain;
    },
  };
}

Deno.test("D-386: autoPopulateFields output carries no homeowner phone anywhere, but keeps her email as signer", async () => {
  const selects: Record<string, string[]> = {};
  const { fields } = await autoPopulateFields(fakeSupabase(selects), "claim1", "k1", "Contractor Signer", SIGNER_EMAIL, "contractor_sign");
  assert(!("customer_phone" in fields) || !fields.customer_phone, `customer_phone must be absent or empty, got ${JSON.stringify(fields.customer_phone)}`);
  const blob = JSON.stringify(fields);
  assert(!blob.includes(PHONE), "formatted homeowner phone leaked into merge fields");
  assert(!blob.replace(/\D/g, "").includes(PHONE_DIGITS), "homeowner phone digits leaked into merge fields");
  assertEquals(fields.customer_email, SIGNER_EMAIL);
  assertEquals(fields.contractor_phone, "317-555-0999", "the CONTRACTOR's own phone is unaffected");
  assertEquals(fields.customer_name, "Hannah Homeowner");
  assertEquals(fields.customer_address, "12 Elm St");
});

Deno.test("D-386: the homeowner's profile phone is not even read by the contract builder", async () => {
  const selects: Record<string, string[]> = {};
  await autoPopulateFields(fakeSupabase(selects), "claim1", "k1", "Contractor Signer", SIGNER_EMAIL, "contractor_sign");
  assert(!(selects.profiles ?? []).includes("phone"), `profiles.phone selected: ${JSON.stringify(selects.profiles)}`);
});

Deno.test("D-386: both handlers strip a caller-supplied customer_phone / homeowner_phone", () => {
  const i = mustFind("function stripHomeownerPhone(");
  const fn = src.slice(i, src.indexOf("async function autoPopulateFields(", i));
  assertStringIncludes(fn, "delete out.customer_phone");
  assertStringIncludes(fn, "delete out.homeowner_phone");
  assertEquals(src.split("let autoFields = stripHomeownerPhone(providedFields);").length - 1, 2);
  assertEquals(src.includes("let autoFields = providedFields || {};"), false);
});
