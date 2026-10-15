// gh-2794 / gh-1759 — GATE 3: dispute evidence is DRAFT-ONLY unless
// DISPUTE_EVIDENCE_FINAL_SUBMIT_ENABLED is exactly "true".
//
// Every route that previously sent `evidence[submit]: "true"` is exercised
// below under the default (switch unset). On main there is no switch, so:
//   - the import of the gate functions fails (they do not exist), and
//   - the structural test on index.ts fails (it reads no switch).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  applySubmitDecision,
  evaluateDisputeRouting,
  FINAL_SUBMIT_ENV_VAR,
  isFinalSubmitEnabled,
  shouldSubmitFinalEvidence,
} from "./dispute-routing.ts";

const SUBMIT = "evidence[submit]";
const REASONS = ["fraudulent", "general", "duplicate", "product_unacceptable", "credit_not_processed", "subscription_canceled", "unrecognized"];
const baseEvidence = () => ({
  "evidence[product_description]": "x",
  "evidence[service_documentation_text]": "homeowner + address",
});

// Simulates handleDisputeCreated for one dispute: routing, then payload.
function route(reason: string, amountCents: number, claim: boolean, fee: boolean, flag: string | undefined) {
  const v = evaluateDisputeRouting({ reason, amountCents, claimResolved: claim });
  if (v.routing === "manual_queue") return { routing: v.routing, payload: null };
  return {
    routing: v.routing,
    payload: applySubmitDecision(baseEvidence(), {
      claimResolved: claim,
      feeAcceptanceResolved: fee,
      finalSubmitEnabled: isFinalSubmitEnabled(flag),
    }),
  };
}

Deno.test("gh-2794: default (switch unset) -> NO route sends submit=true, every previously-submitting route", () => {
  let routes = 0;
  for (const reason of REASONS) {
    for (const amount of [1, 18_054, 49_999]) {
      const r = route(reason, amount, true, true, undefined);
      assertEquals(r.routing, "auto_submit"); // still reaches the evidence-saving branch
      assert(r.payload !== null);
      assert(!(SUBMIT in r.payload), `submit present for ${reason}/${amount}`);
      routes++;
    }
  }
  assertEquals(routes, REASONS.length * 3);
});

Deno.test("gh-2794: default -> claim present but fee acceptance missing is also draft (no submit key)", () => {
  const r = route("fraudulent", 18_054, true, false, undefined);
  assert(!(SUBMIT in r.payload!));
});

Deno.test("gh-2794: default -> drafts are still saved (payload keeps its evidence fields)", () => {
  const r = route("fraudulent", 18_054, true, true, undefined);
  assertEquals(r.payload!["evidence[service_documentation_text]"], "homeowner + address");
  assertEquals(Object.keys(r.payload!).length, 2);
});

Deno.test("gh-2794: manual-queue routing is unchanged by the gate", () => {
  assertEquals(route("product_not_received", 100, true, true, undefined).routing, "manual_queue");
  assertEquals(route("fraudulent", 50_000, true, true, undefined).routing, "manual_queue");
  assertEquals(route("fraudulent", 100, false, false, undefined).routing, "manual_queue");
  assertEquals(route("fraudulent", 100, true, true, "true").routing, "auto_submit");
});

Deno.test("gh-2794: submit=true happens ONLY with the switch explicitly on (and evidence complete)", () => {
  const on = route("fraudulent", 18_054, true, true, "true");
  assertEquals(on.payload![SUBMIT], "true");
  // switch on but evidence incomplete: still draft (gate 2 intact)
  assert(!(SUBMIT in route("fraudulent", 18_054, true, false, "true").payload!));
  assert(!shouldSubmitFinalEvidence({ claimResolved: false, feeAcceptanceResolved: true, finalSubmitEnabled: true }));
});

Deno.test("gh-2794: switch is fail-closed - only the exact string 'true' enables it", () => {
  for (const v of [undefined, null, "", "TRUE", "True", "1", "yes", "on", " true", "true ", "false", "enabled"]) {
    assertEquals(isFinalSubmitEnabled(v as string | undefined), false, `value ${JSON.stringify(v)}`);
  }
  assertEquals(isFinalSubmitEnabled("true"), true);
  assertEquals(FINAL_SUBMIT_ENV_VAR, "DISPUTE_EVIDENCE_FINAL_SUBMIT_ENABLED");
});

Deno.test("gh-2794: applySubmitDecision strips a stray submit key when the switch is off", () => {
  const e = applySubmitDecision({ [SUBMIT]: "true" }, { claimResolved: true, feeAcceptanceResolved: true, finalSubmitEnabled: false });
  assert(!(SUBMIT in e));
});

// ---- Structural half: index.ts must route through the gate (FAILS on main) ----
const indexSrc = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("gh-2794: index.ts reads the switch and is the only code that sets evidence[submit] via the gate", () => {
  assert(/Deno\.env\.get\(FINAL_SUBMIT_ENV_VAR\)/.test(indexSrc), "index.ts does not read the final-submit switch");
  assert(/applySubmitDecision\(evidence,/.test(indexSrc), "evidence payload does not go through applySubmitDecision");
  // No direct assignment of the submit key anywhere in index.ts (code, not comments).
  const code = indexSrc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert(!/\["evidence\[submit\]"\]\s*=/.test(code), 'index.ts assigns evidence["evidence[submit]"] directly');
  assert(!/"evidence\[submit\]":\s*"true"/.test(code), "index.ts hard-codes evidence[submit]: true");
});
