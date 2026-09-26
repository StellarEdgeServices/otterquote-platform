// gh-2154 P-5 — field-mapping.ts tests.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mapFieldData } from "./field-mapping.ts";

Deno.test("mapFieldData: first_name + last_name fields map directly", () => {
  const mapped = mapFieldData([
    { name: "first_name", values: ["Jamie"] },
    { name: "last_name", values: ["Rivera"] },
    { name: "email", values: ["jamie@example.com"] },
  ]);
  assertEquals(mapped.firstName, "Jamie");
  assertEquals(mapped.lastName, "Rivera");
  assertEquals(mapped.fullName, "Jamie Rivera");
  assertEquals(mapped.email, "jamie@example.com");
});

Deno.test("mapFieldData: full_name is split into first/last when no discrete fields exist", () => {
  const mapped = mapFieldData([
    { name: "full_name", values: ["Taylor Morgan Reyes"] },
    { name: "email", values: ["taylor@example.com"] },
  ]);
  assertEquals(mapped.firstName, "Taylor");
  assertEquals(mapped.lastName, "Morgan Reyes");
  assertEquals(mapped.fullName, "Taylor Morgan Reyes");
});

Deno.test("mapFieldData: phone_number and company_name map", () => {
  const mapped = mapFieldData([
    { name: "phone_number", values: ["+13175551234"] },
    { name: "company_name", values: ["Rivera Realty"] },
  ]);
  assertEquals(mapped.phone, "+13175551234");
  assertEquals(mapped.company, "Rivera Realty");
});

Deno.test("mapFieldData: field names are matched case-insensitively", () => {
  const mapped = mapFieldData([{ name: "EMAIL", values: ["Case@Example.com"] }]);
  assertEquals(mapped.email, "Case@Example.com");
});

Deno.test("mapFieldData: empty/missing values yield nulls, not throws", () => {
  const mapped = mapFieldData([]);
  assertEquals(mapped, { firstName: null, lastName: null, fullName: null, email: null, phone: null, company: null });
});

Deno.test("mapFieldData: null field_data yields all nulls", () => {
  const mapped = mapFieldData(null);
  assertEquals(mapped.email, null);
});

Deno.test("mapFieldData: a field with an empty values array is ignored", () => {
  const mapped = mapFieldData([{ name: "email", values: [] }]);
  assertEquals(mapped.email, null);
});
