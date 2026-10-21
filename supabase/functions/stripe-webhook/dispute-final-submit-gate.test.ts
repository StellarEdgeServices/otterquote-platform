// gh-2794 / gh-1759 — GATE 3: dispute evidence is DRAFT-ONLY unless
// DISPUTE_EVIDENCE_FINAL_SUBMIT_ENABLED is exactly "true".
//
// STRIPE WIRE CONTRACT (https://docs.stripe.com/api/disputes/update):
//   `submit` is a TOP-LEVEL boolean, "(the default)" true. `evidence` has no `submit` child.
// So the draft is only guaranteed by an explicit `submit=false`; a missing key is FINAL.
//
// These tests drive postDisputeEvidence() with a mocked fetch and decode the ACTUAL
// form-encoded request body that would reach POST /v1/disputes/{id}.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildDisputeRequestBody,
  evaluateDisputeRouting,
  FINAL_SUBMIT_ENV_VAR,
  isFinalSubmitEnabled,
  postDisputeEvidence,
  shouldSubmitFinalEvidence,
} from "./dispute-routing.ts";
import { stripComments } from "./test-source-utils.ts";

const REASONS = ["fraudulent", "general", "duplicate", "product_unacceptable", "credit_not_processed", "subscription_canceled", "unrecognized"];
const baseEvidence = () => ({
  "evidence[product_description]": "x",
  "evidence[service_documentation_text]": "homeowner + address",
});

interface Sent { url: string; method: string; contentType: string; raw: string; params: URLSearchParams }

// Mocked fetch: records exactly what was sent; returns a Stripe-like 200.
function mockFetch(sent: Sent[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = String(init?.body ?? "");
    sent.push({
      url: String(input),
      method: String(init?.method),
      contentType: headers.get("Content-Type") ?? "",
      raw,
      params: new URLSearchParams(raw),
    });
    return Promise.resolve(new Response(JSON.stringify({ id: "du_1", object: "dispute" }), { status: 200 }));
  }) as typeof fetch;
}

// Simulates handleDisputeCreated for one dispute: routing, then the Stripe call.
async function route(reason: string, amountCents: number, claim: boolean, fee: boolean, envValue: string | undefined) {
  const v = evaluateDisputeRouting({ reason, amountCents, claimResolved: claim });
  const sent: Sent[] = [];
  if (v.routing === "manual_queue") return { routing: v.routing, sent, result: null };
  const result = await postDisputeEvidence({
    disputeId: "du_test_1",
    stripeKey: "sk_test_x",
    evidence: baseEvidence(),
    claimResolved: claim,
    feeAcceptanceResolved: fee,
    finalSubmitEnabled: isFinalSubmitEnabled(envValue),
    fetchImpl: mockFetch(sent),
  });
  return { routing: v.routing, sent, result };
}

// What Stripe would do with a request body: `submit` defaults to TRUE when absent.
const stripeWouldSubmitFinal = (p: URLSearchParams) => (p.has("submit") ? p.get("submit") === "true" : true);

Deno.test("gh-2794: request goes to POST /v1/disputes/{id}, form-encoded", async () => {
  const r = await route("fraudulent", 18_054, true, true, undefined);
  assertEquals(r.sent.length, 1);
  assertEquals(r.sent[0].url, "https://api.stripe.com/v1/disputes/du_test_1");
  assertEquals(r.sent[0].method, "POST");
  assertEquals(r.sent[0].contentType, "application/x-www-form-urlencoded");
  assertEquals(r.sent[0].params.get("evidence[service_documentation_text]"), "homeowner + address");
});

Deno.test("gh-2794: DEFAULT (switch unset) -> every auto_submit route sends top-level submit=false, never evidence[submit]", async () => {
  let routes = 0;
  for (const reason of REASONS) {
    for (const amount of [1, 18_054, 49_999]) {
      for (const claim of [true]) { // claim=false is manual_queue (no Stripe call)
        for (const fee of [true, false]) { // fee=false is the route the reviewer found on main
          const r = await route(reason, amount, claim, fee, undefined);
          assertEquals(r.routing, "auto_submit");
          assertEquals(r.sent.length, 1);
          const p = r.sent[0].params;
          const label = `${reason}/${amount}/fee=${fee}`;
          assertEquals(p.getAll("submit"), ["false"], `submit not exactly [false] for ${label}`);
          assert(!stripeWouldSubmitFinal(p), `Stripe would submit FINAL for ${label}`);
          for (const k of p.keys()) assert(!k.includes("evidence[submit]"), `evidence[submit] present for ${label}`);
          assert(!r.sent[0].raw.includes("evidence%5Bsubmit%5D") && !r.sent[0].raw.includes("evidence[submit]"));
          assertEquals(r.result!.submitFinal, false);
          routes++;
        }
      }
    }
  }
  assertEquals(routes, REASONS.length * 3 * 2);
});

Deno.test("gh-2794: claim resolved + fee acceptance NULL (the main-branch FINAL path) sends submit=false even with the switch ON", async () => {
  const r = await route("fraudulent", 18_054, true, false, "true");
  assertEquals(r.routing, "auto_submit");
  assertEquals(r.sent[0].params.get("submit"), "false");
});

Deno.test("gh-2794: switch ON + complete set -> submit=true, still no evidence[submit]", async () => {
  for (const reason of REASONS) {
    const r = await route(reason, 18_054, true, true, "true");
    assertEquals(r.sent[0].params.getAll("submit"), ["true"]);
    assertEquals(r.result!.submitFinal, true);
    for (const k of r.sent[0].params.keys()) assert(!k.includes("evidence[submit]"));
  }
});

Deno.test("gh-2794: submit=true ONLY with the switch on AND a complete set (full matrix)", async () => {
  for (const env of [undefined, "", "TRUE", "1", "yes", " true", "true ", "false", "true"]) {
    for (const claim of [true, false]) {
      for (const fee of [true, false]) {
        const sent: Sent[] = [];
        await postDisputeEvidence({
          disputeId: "du_m", stripeKey: "k", evidence: baseEvidence(),
          claimResolved: claim, feeAcceptanceResolved: fee,
          finalSubmitEnabled: isFinalSubmitEnabled(env), fetchImpl: mockFetch(sent),
        });
        const expectFinal = env === "true" && claim && fee;
        assertEquals(sent[0].params.get("submit"), expectFinal ? "true" : "false", `env=${JSON.stringify(env)} claim=${claim} fee=${fee}`);
      }
    }
  }
});

Deno.test("gh-2794: a stray submit / evidence[submit] key in the evidence is never forwarded", async () => {
  const sent: Sent[] = [];
  await postDisputeEvidence({
    disputeId: "du_s", stripeKey: "k",
    evidence: { ...baseEvidence(), "evidence[submit]": "true", submit: "true" },
    claimResolved: true, feeAcceptanceResolved: true, finalSubmitEnabled: false, fetchImpl: mockFetch(sent),
  });
  assertEquals(sent[0].params.getAll("submit"), ["false"]);
  assert(!sent[0].params.has("evidence[submit]"));
});

Deno.test("gh-2794: drafts still carry the evidence fields", async () => {
  const r = await route("fraudulent", 18_054, true, true, undefined);
  assertEquals([...r.sent[0].params.keys()].sort(), ["evidence[product_description]", "evidence[service_documentation_text]", "submit"]);
});

Deno.test("gh-2794: manual-queue routing makes NO Stripe call and is unchanged by the gate", async () => {
  for (const [reason, amt, claim] of [["product_not_received", 100, true], ["fraudulent", 50_000, true], ["fraudulent", 100, false]] as const) {
    const r = await route(reason, amt, claim, true, "true");
    assertEquals(r.routing, "manual_queue");
    assertEquals(r.sent.length, 0);
  }
});

Deno.test("gh-2794: a failed Stripe call reports not-ok and still says what was requested", async () => {
  const res = await postDisputeEvidence({
    disputeId: "du_f", stripeKey: "k", evidence: baseEvidence(), claimResolved: true, feeAcceptanceResolved: true,
    finalSubmitEnabled: false,
    fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 }))) as typeof fetch,
  });
  assertEquals(res.ok, false);
  assertEquals(res.error, "boom");
  assertEquals(res.requestBody["submit"], "false");
});

Deno.test("gh-2794: switch is fail-closed - only the exact string 'true' enables it", () => {
  for (const v of [undefined, null, "", "TRUE", "True", "1", "yes", "on", " true", "true ", "false", "enabled"]) {
    assertEquals(isFinalSubmitEnabled(v as string | undefined), false, `value ${JSON.stringify(v)}`);
  }
  assertEquals(isFinalSubmitEnabled("true"), true);
  assertEquals(FINAL_SUBMIT_ENV_VAR, "DISPUTE_EVIDENCE_FINAL_SUBMIT_ENABLED");
  assert(!shouldSubmitFinalEvidence({ claimResolved: false, feeAcceptanceResolved: true, finalSubmitEnabled: true }));
});

// ---- NEGATIVE CONTROLS: these model ced5d294 and must be detected as FINAL ----
Deno.test("gh-2794 NEGATIVE CONTROL: the ced5d294 wire shape (submit key omitted) is detected as a FINAL submission", () => {
  const headBody = new URLSearchParams(baseEvidence()); // what ced5d294 sent with the switch unset
  assert(stripeWouldSubmitFinal(headBody), "control broken: an omitted submit must read as FINAL");
  const mainBody = new URLSearchParams({ ...baseEvidence(), "evidence[submit]": "true" }); // what main sent
  assert(mainBody.has("evidence[submit]") && !mainBody.has("submit"));
  const fixed = new URLSearchParams(buildDisputeRequestBody(baseEvidence(), { claimResolved: true, feeAcceptanceResolved: true, finalSubmitEnabled: false }));
  assert(!stripeWouldSubmitFinal(fixed));
});

Deno.test("gh-2794 NEGATIVE CONTROL: a postDisputeEvidence that dropped the submit key would fail the default-route assertion", async () => {
  const sent: Sent[] = [];
  // Emulates ced5d294 behaviour by stripping `submit` inside the fetch the way the old code never sent it.
  const droppingFetch = ((u: string | URL | Request, init?: RequestInit) => {
    const p = new URLSearchParams(String(init?.body)); p.delete("submit");
    return mockFetch(sent)(u, { ...init, body: p.toString() });
  }) as typeof fetch;
  await postDisputeEvidence({ disputeId: "du_n", stripeKey: "k", evidence: baseEvidence(), claimResolved: true, feeAcceptanceResolved: false, finalSubmitEnabled: false, fetchImpl: droppingFetch });
  assertEquals(sent[0].params.getAll("submit"), [], "control body has no submit");
  assert(stripeWouldSubmitFinal(sent[0].params), "the default-route check must flag it");
});

// ---- Structural half (comments stripped, so a comment cannot satisfy these) ----
const indexCode = stripComments(await Deno.readTextFile(new URL("./index.ts", import.meta.url)));

Deno.test("gh-2794: index.ts sends disputes writes only through postDisputeEvidence and reads the switch", () => {
  assert(/postDisputeEvidence\(\{/.test(indexCode), "index.ts does not call postDisputeEvidence");
  assert(/Deno\.env\.get\(FINAL_SUBMIT_ENV_VAR\)/.test(indexCode), "index.ts does not read the final-submit switch");
  assert(/claimResolved:\s*claim !== null/.test(indexCode) && /feeAcceptanceResolved:\s*feeAcceptance !== null/.test(indexCode));
  assert(!/stripeRequest\(\s*`\/disputes/.test(indexCode), "index.ts POSTs /disputes through the generic stripeRequest again");
});

Deno.test("gh-2794: no code under supabase/functions sends evidence[submit]", async () => {
  const root = new URL("../", import.meta.url);
  const hits: string[] = [];
  async function walk(dir: URL) {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) { await walk(u); continue; }
      if (!/\.(ts|js|tsx)$/.test(e.name) || /\.test\.ts$/.test(e.name)) continue;
      if (/evidence\[submit\]/.test(stripComments(await Deno.readTextFile(u)))) hits.push(u.pathname);
    }
  }
  await walk(root);
  // dispute-routing.ts holds the one literal, used only to DROP a caller-supplied key.
  const unexpected = hits.filter((h) => !h.endsWith("/stripe-webhook/dispute-routing.ts"));
  assertEquals(unexpected, []);
});
