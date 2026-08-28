import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { evaluatePrice, extractSignedContractPrice, parseMoney } from "./price-verify.ts";

Deno.test("parseMoney normalises hand-typed currency", () => {
  assertEquals(parseMoney("$15,000.00"), 15000);
  assertEquals(parseMoney("15000"), 15000);
  assertEquals(parseMoney("13,560"), 13560);
  assertEquals(parseMoney(" $13,560.00 "), 13560);
});

Deno.test("parseMoney returns null (not 0) for unreadable input", () => {
  // The distinction that matters: an unreadable field must not look like a $0
  // contract, or a mismatch check would 'pass' against an accepted bid of 0.
  assertEquals(parseMoney(""), null);
  assertEquals(parseMoney("TBD"), null);
  assertEquals(parseMoney("$"), null);
  assertEquals(parseMoney(null), null);
  assertEquals(parseMoney(undefined), null);
});

Deno.test("extractSignedContractPrice finds the field on any signer", () => {
  const signers = [
    { formFields: [{ id: "customer_name", value: "Gregory Paulsen" }] },
    { formFields: [{ id: "contract_price", value: "$13,560.00" }] },
  ];
  assertEquals(extractSignedContractPrice(signers), "$13,560.00");
});

Deno.test("extractSignedContractPrice treats empty/whitespace as absent", () => {
  assertEquals(extractSignedContractPrice([{ formFields: [{ id: "contract_price", value: "   " }] }]), null);
  assertEquals(extractSignedContractPrice([{ formFields: [{ id: "contract_price", value: null }] }]), null);
  assertEquals(extractSignedContractPrice([{ formFields: [] }]), null);
  assertEquals(extractSignedContractPrice([]), null);
  assertEquals(extractSignedContractPrice(undefined as unknown as unknown[]), null);
});

Deno.test("evaluatePrice reconciles an exact match", () => {
  const r = evaluatePrice("$13,560.00", 13560);
  assertEquals(r.state, "reconciled");
});

Deno.test("evaluatePrice tolerates sub-cent float noise only", () => {
  assertEquals(evaluatePrice("13560.005", 13560).state, "reconciled");
  assertEquals(evaluatePrice("13560.02", 13560).state, "mismatch");
});

Deno.test("evaluatePrice flags the #1314 exposure", () => {
  // The exact scenario from the issue: $13,560 accepted, $15,000 signed.
  const r = evaluatePrice("$15,000.00", 13560);
  assertEquals(r.state, "mismatch");
  if (r.state === "mismatch") {
    assertEquals(r.signed, 15000);
    assertEquals(r.expected, 13560);
    assertEquals(r.delta, 1440);
  }
});

Deno.test("evaluatePrice catches an UNDER-statement too", () => {
  // Not just overcharging: a contract signed below the accepted bid is also a
  // reconciliation failure, and the fee would be charged on the wrong basis.
  assertEquals(evaluatePrice("$12,000.00", 13560).state, "mismatch");
});

Deno.test("evaluatePrice returns unverified, never mismatch, when it cannot read", () => {
  assertEquals(evaluatePrice(null, 13560), { state: "unverified", reason: "field_absent", raw: null, expected: 13560 });
  assertEquals(evaluatePrice("TBD", 13560), { state: "unverified", reason: "unparseable", raw: "TBD", expected: 13560 });
  assertEquals(evaluatePrice("$13,560.00", null), { state: "unverified", reason: "no_expected", raw: "$13,560.00", expected: null });
});
