import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  auditMessage,
  CLAIM_CLEAR,
  QUOTE_CLEAR,
  normalizeDocumentStatus,
  planReissue,
  vendorActionFor,
} from "./reissue-plan.ts";

const ENV = "c3ec3800-3ffa-4776-9626-01bc4550bd38";
const halted = { id: "4d764e19", signed_price_verdict: "mismatch", contract_signed_at: null, docusign_envelope_id: ENV };
const quote = [{ id: "ff1f8323", docusign_envelope_id: ENV }];
const base = { claim: halted, quotes: quote, documentStatus: "completed" as const, expectedEnvelopeId: ENV };

Deno.test("the 2026-10-05 fixture (mismatch, Completed) plans retain_completed, never revoke or delete", () => {
  const p = planReissue(base);
  if (!p.ok) throw new Error(JSON.stringify(p));
  assertEquals(p.vendorAction, "retain_completed");
  assertEquals(p.quoteIds, ["ff1f8323"]);
  assertEquals(p.envelopeId, ENV);
});

Deno.test("unverified halts are re-issuable too", () => {
  const p = planReissue({ ...base, claim: { ...halted, signed_price_verdict: "unverified" } });
  assertEquals(p.ok, true);
});

Deno.test("NEGATIVE: a reconciled or unrecorded claim is refused", () => {
  for (const v of ["reconciled", null]) {
    const p = planReissue({ ...base, claim: { ...halted, signed_price_verdict: v } });
    assertEquals(p.ok, false);
    if (!p.ok) assertEquals(p.code, "claim_not_halted");
  }
});

Deno.test("NEGATIVE: a claim with contract_signed_at set is refused (fee side effects already ran)", () => {
  const p = planReissue({ ...base, claim: { ...halted, contract_signed_at: "2026-10-05T00:00:00Z" } });
  assertEquals(p.ok, false);
  if (!p.ok) assertEquals(p.code, "already_signed");
});

Deno.test("NEGATIVE: stale or missing expected envelope id is refused", () => {
  for (const e of ["some-other-envelope", null, undefined, ""]) {
    const p = planReissue({ ...base, expectedEnvelopeId: e });
    assertEquals(p.ok, false);
    if (!p.ok) assertEquals(p.code, "expected_envelope_mismatch");
  }
});

Deno.test("NEGATIVE: no envelope on the claim, or no quote pointing at it", () => {
  const a = planReissue({ ...base, claim: { ...halted, docusign_envelope_id: null } });
  if (a.ok) throw new Error("expected refusal");
  assertEquals(a.code, "no_envelope_on_claim");
  const b = planReissue({ ...base, quotes: [{ id: "q9", docusign_envelope_id: "other" }] });
  if (b.ok) throw new Error("expected refusal");
  assertEquals(b.code, "no_quote_points_at_envelope");
});

Deno.test("only quotes carrying the envelope are detached", () => {
  const p = planReissue({ ...base, quotes: [...quote, { id: "q2", docusign_envelope_id: "other" }, { id: "q3", docusign_envelope_id: null }] });
  if (!p.ok) throw new Error("refused");
  assertEquals(p.quoteIds, ["ff1f8323"]);
});

Deno.test("vendor action by document status; unknown fails closed", () => {
  assertEquals(vendorActionFor("completed"), "retain_completed");
  assertEquals(vendorActionFor("inprogress"), "revoke");
  assertEquals(vendorActionFor("draft"), null); // not documented as revocable: refuse
  assertEquals(vendorActionFor("revoked"), "none");
  assertEquals(vendorActionFor("declined"), "none");
  assertEquals(vendorActionFor("expired"), "none");
  assertEquals(vendorActionFor("unknown"), null);
  const p = planReissue({ ...base, documentStatus: "unknown" });
  if (p.ok) throw new Error("expected refusal");
  assertEquals(p.code, "document_status_unreadable");
});

Deno.test("normalizeDocumentStatus maps BoldSign casing and junk", () => {
  assertEquals(normalizeDocumentStatus("Completed"), "completed");
  assertEquals(normalizeDocumentStatus("InProgress"), "inprogress");
  assertEquals(normalizeDocumentStatus(undefined), "unknown");
  assertEquals(normalizeDocumentStatus("Banana"), "unknown");
});

Deno.test("claim clear set removes the envelope pointer AND every halt marker the admin list filters on", () => {
  assertEquals(Object.keys(CLAIM_CLEAR).sort(), [
    "contract_sent_at", "docusign_envelope_id", "signed_contract_price", "signed_price_checked_at",
    "signed_price_raw", "signed_price_reason", "signed_price_verdict",
  ]);
  assertEquals(Object.values(CLAIM_CLEAR).every((v) => v === null), true);
  const p = planReissue(base);
  if (!p.ok) throw new Error("refused");
  p.claimClear.docusign_envelope_id = null;
  assertEquals(CLAIM_CLEAR.docusign_envelope_id, null); // plan holds a copy
});

Deno.test("audit message carries the prior halt values and says the document was not deleted", () => {
  const p = planReissue(base);
  if (!p.ok) throw new Error("refused");
  const m = auditMessage({
    claim: { ...halted, signed_contract_price: 13561, signed_price_raw: "$13,561.00", signed_price_reason: null },
    plan: p, adminEmail: "dustinstohler1@gmail.com", documentStatus: "completed",
  });
  for (const s of [ENV, "13561", "$13,561.00", "NOT deleted", "retain_completed", "ff1f8323"]) {
    assertEquals(m.includes(s), true, `missing ${s}`);
  }
});

Deno.test("draft is refused with document_status_not_revocable, not revoked", () => {
  const p = planReissue({ ...base, documentStatus: "draft" });
  if (p.ok) throw new Error("expected refusal");
  assertEquals(p.code, "document_status_not_revocable");
});

// F1 (review 6163971155): the fixture quote carries BOTH signing marks from the wrong-price document.
const marked = [{
  id: "ff1f8323", docusign_envelope_id: ENV,
  contractor_signed_at: "2026-10-05T18:00:00Z", homeowner_signed_at: "2026-10-05T18:05:00Z",
}];

Deno.test("F1: quote clear set removes the envelope pointer AND both signing marks", () => {
  assertEquals(Object.keys(QUOTE_CLEAR).sort(), ["contractor_signed_at", "docusign_envelope_id", "homeowner_signed_at"]);
  assertEquals(Object.values(QUOTE_CLEAR).every((v) => v === null), true);
  const p = planReissue({ ...base, quotes: marked });
  if (!p.ok) throw new Error("refused");
  assertEquals(p.quoteClear, { docusign_envelope_id: null, contractor_signed_at: null, homeowner_signed_at: null });
});

Deno.test("F1: prior signing marks are carried in the plan and in the audit text before they are cleared", () => {
  const p = planReissue({ ...base, quotes: marked });
  if (!p.ok) throw new Error("refused");
  assertEquals(p.quotePrior, [{ id: "ff1f8323", contractor_signed_at: "2026-10-05T18:00:00Z", homeowner_signed_at: "2026-10-05T18:05:00Z" }]);
  const m = auditMessage({ claim: halted, plan: p, adminEmail: "dustinstohler1@gmail.com", documentStatus: "completed" });
  for (const s of ["contractor_signed_at=2026-10-05T18:00:00Z", "homeowner_signed_at=2026-10-05T18:05:00Z"]) {
    assertEquals(m.includes(s), true, s);
  }
});
