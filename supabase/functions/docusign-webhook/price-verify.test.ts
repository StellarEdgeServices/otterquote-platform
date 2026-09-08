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

// ── gh-1314 (2026-09-07): the field_absent promotion ────────────────────────
// Before this change every one of these unverifiable states FLAGGED and the
// contract proceeded to charge. `signed_price_unverified` fired three times in
// production (2026-08-31 -> 2026-09-03) and `signed_price_mismatch` never fired
// at all, because no production document carries a readable `contract_price` --
// so the reconciliation existed and had never once protected a charge.
import { dispositionFor } from "./price-verify.ts";

Deno.test("gh-1314: an absent contract_price HALTS, it no longer flags", () => {
  const verdict = evaluatePrice(null, 13560);
  assertEquals(verdict, {
    state: "unverified",
    reason: "field_absent",
    raw: null,
    expected: 13560,
  });
  assertEquals(dispositionFor(verdict), "halt");
});

Deno.test("gh-1314: an unparseable contract_price HALTS", () => {
  const verdict = evaluatePrice("see attached", 13560);
  assertEquals(verdict.state, "unverified");
  assertEquals(dispositionFor(verdict), "halt");
});

Deno.test("gh-1314: a missing accepted bid still only FLAGS", () => {
  // Asymmetry on purpose: halt when the DOCUMENT cannot be shown to agree with
  // the bid; flag when the question could not be asked because our own quote
  // row carries no price. Nothing the contractor typed could clear this one.
  const verdict = evaluatePrice("$13,560.00", null);
  assertEquals(verdict.state, "unverified");
  assertEquals(dispositionFor(verdict), "flag");
});

Deno.test("gh-1314: the original exposure — $15,000 signed against a $13,560 bid — HALTS", () => {
  const verdict = evaluatePrice("$15,000.00", 13560);
  assertEquals(verdict, { state: "mismatch", signed: 15000, expected: 13560, delta: 1440 });
  assertEquals(dispositionFor(verdict), "halt");
});

Deno.test("gh-1314: a contract signed at the accepted bid still PROCEEDS", () => {
  // The check must not become a wall. This is the case that must keep working.
  const verdict = evaluatePrice("$13,560.00", 13560);
  assertEquals(verdict, { state: "reconciled", signed: 13560, expected: 13560 });
  assertEquals(dispositionFor(verdict), "proceed");
});

Deno.test("gh-1314: every unverifiable-price state is covered by the table", () => {
  // A new `unverified` reason added later must be classified deliberately
  // rather than inheriting whichever branch happens to catch it.
  const reasons = ["no_expected", "field_absent", "unparseable"] as const;
  const seen = reasons.map((r) =>
    dispositionFor({ state: "unverified", reason: r, raw: null, expected: 1 })
  );
  assertEquals(seen, ["flag", "halt", "halt"]);
});

// ── gh-1314 FIX (2026-09-08): the halt is FAIL-CLOSED ───────────────────────
// LEGAL-READ (R-177) FAIL, ground F1: the first version of this halt was
// skipped entirely whenever BoldSign's GET /v1/document/properties failed, so
// the platform fee was charged on a contract whose price was never read. These
// tests exercise the failure itself -- the properties call THROWS -- and assert
// the halt, side by side with the pre-fix behaviour they replace.
import {
  priceVerdictFor,
  reconciliationErrorVerdict,
  remediationFor,
  resolveSignerStatus,
} from "./price-verify.ts";

/** The properties read, failing exactly as `fetchDocumentSignerStatus` does. */
function throwingPropertiesRead(): Promise<unknown[]> {
  return Promise.reject(
    new Error("BoldSign document/properties request failed: 502 Bad Gateway"),
  );
}

Deno.test("gh-1314 F1: a properties read that THROWS yields a halt, not a skip", async () => {
  const status = await resolveSignerStatus(throwingPropertiesRead);
  assertEquals(status.kind, "properties_error");
  const verdict = priceVerdictFor(status as never, 13560);
  assertEquals(verdict, {
    state: "unverified",
    reason: "properties_unreadable",
    raw: null,
    expected: 13560,
  });
  assertEquals(dispositionFor(verdict), "halt");
});

Deno.test("gh-1314 F1: resolveSignerStatus never throws, whatever the read throws", async () => {
  for (const thrown of [new Error("network"), "string failure", null, undefined]) {
    const status = await resolveSignerStatus(() => Promise.reject(thrown));
    assertEquals(status.kind, "properties_error");
    assertEquals(dispositionFor(priceVerdictFor(status as never, 1)), "halt");
  }
});

Deno.test("gh-1314 F1: an unreadable document OUTRANKS a missing accepted bid", () => {
  // Both facts are true at once: the read failed AND our quote row has no
  // price. That must halt, not flag -- a document we could not read is a
  // document failure, and `no_expected` is the one reason that only flags.
  const verdict = priceVerdictFor({ kind: "properties_error", error: new Error("502") }, null);
  assertEquals(verdict.state, "unverified");
  if (verdict.state === "unverified") assertEquals(verdict.reason, "properties_unreadable");
  assertEquals(dispositionFor(verdict), "halt");
});

Deno.test("gh-1314 F1: a successful read still reconciles normally", async () => {
  const status = await resolveSignerStatus(() =>
    Promise.resolve([{ formFields: [{ id: "contract_price", value: "$13,560.00" }] }] as unknown[])
  );
  assertEquals(status.kind, "properties");
  const verdict = priceVerdictFor(status as never, 13560);
  assertEquals(verdict, { state: "reconciled", signed: 13560, expected: 13560 });
  assertEquals(dispositionFor(verdict), "proceed");
});

Deno.test("gh-1314 F1: an error inside the reconciliation halts too", () => {
  const verdict = reconciliationErrorVerdict(13560);
  assertEquals(verdict, {
    state: "unverified",
    reason: "reconciliation_error",
    raw: null,
    expected: 13560,
  });
  assertEquals(dispositionFor(verdict), "halt");
});

Deno.test("gh-1314 F1: NEGATIVE CONTROL — the pre-fix call site charges, the fixed one halts", async () => {
  // PRE-FIX, reproduced literally from index.ts before this fix: a nullable
  // `signerStatus` assigned inside the D-269 try whose catch is commented
  // "Loud but fail-open", and the whole price block gated on `if (signerStatus)`.
  async function preFix(read: () => Promise<unknown[]>, expected: number | null) {
    let signerStatus: unknown[] | null = null;
    try {
      signerStatus = await read();
    } catch {
      // "Loud but fail-open" — falls through.
    }
    if (signerStatus) {
      return dispositionFor(evaluatePrice(extractSignedContractPrice(signerStatus), expected));
    }
    // Block skipped entirely — control reaches the D-127 charge block.
    return "CHARGED WITHOUT READING THE PRICE";
  }

  async function fixed(read: () => Promise<unknown[]>, expected: number | null) {
    return dispositionFor(priceVerdictFor(await resolveSignerStatus(read) as never, expected));
  }

  assertEquals(await preFix(throwingPropertiesRead, 13560), "CHARGED WITHOUT READING THE PRICE");
  assertEquals(await fixed(throwingPropertiesRead, 13560), "halt");

  // And the case that must keep working is unchanged by the fix.
  const good = () =>
    Promise.resolve([{ formFields: [{ id: "contract_price", value: "13560" }] }] as unknown[]);
  assertEquals(await preFix(good, 13560), "proceed");
  assertEquals(await fixed(good, 13560), "proceed");
});

Deno.test("gh-1314 F1: every unverified reason carries operator remediation", () => {
  const reasons = [
    "no_expected",
    "field_absent",
    "unparseable",
    "properties_unreadable",
    "reconciliation_error",
  ] as const;
  for (const r of reasons) {
    const text = remediationFor(r);
    assertEquals(typeof text, "string");
    assertEquals(text.length > 40, true);
  }
  // The two new reasons must not be described as "the document does not carry
  // a readable contract price" — that is a different fact and misdirects ops.
  assertEquals(remediationFor("properties_unreadable").includes("document/properties"), true);
  assertEquals(remediationFor("reconciliation_error").includes("errored"), true);
});

Deno.test("gh-1314 F1: the disposition table covers ALL five unverified reasons", () => {
  // Supersedes the three-reason version above: a reason added later must be
  // classified deliberately rather than inheriting whichever branch catches it.
  const reasons = [
    "no_expected",
    "field_absent",
    "unparseable",
    "properties_unreadable",
    "reconciliation_error",
  ] as const;
  const seen = reasons.map((r) =>
    dispositionFor({ state: "unverified", reason: r, raw: null, expected: 1 })
  );
  assertEquals(seen, ["flag", "halt", "halt", "halt", "halt"]);
});
