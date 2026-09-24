// gh-2107 / D-330 -- Ben's return on the Test Events walk (#2078 5815458523): case B FAILED. The same PaymentIntent under a NEW Stripe event id made the
// webhook send a SECOND Purchase to Meta, and Meta received and processed both (two "Purchase / Server / Processed" rows in Test Events). The
// stripe_webhook_events ledger only dedupes the SAME `evt_` id; Meta only dedupes browser-vs-server, not two server sends with one event_id. So the CAPI
// send is deduplicated on the PaymentIntent, not the event: before sending, atomically CLAIM `measurement_purchase:<pi>` in a durable, unique-keyed
// store (a row in the existing stripe_webhook_events ledger, whose primary key is text `event_id`); if the claim already exists, skip with `already_sent`;
// if the claim cannot be verified, do not send (fail closed); if the send fails, RELEASE the claim so a retry can send.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildCapiEventId,
  CAPI_CLAIM_EVENT_TYPE,
  capiClaimKey,
  decideCapiClaim,
  sendCapiPurchaseOnce,
} from "./meta-capi.ts";

// -- an in-memory stand-in for the ledger: a unique key, like the real primary key (a duplicate insert is a 23505) ---------------------------------
function ledger() {
  const keys = new Set<string>();
  return {
    keys,
    insert(key: string): { code?: string } | null {
      if (keys.has(key)) return { code: "23505" };
      keys.add(key);
      return null;
    },
    remove(key: string): boolean {
      keys.delete(key);
      return true;
    },
  };
}

function harness(opts: { sendResults?: (boolean | "throw")[]; releaseOk?: boolean; claimOverride?: () => Promise<{ code?: string } | null> } = {}) {
  const l = ledger();
  const sends: string[] = [];
  const releases: string[] = [];
  const logs: string[] = [];
  const results = [...(opts.sendResults ?? [])];
  const run = (pi: string) =>
    sendCapiPurchaseOnce({
      claim: opts.claimOverride ?? (() => Promise.resolve(l.insert(capiClaimKey(pi)))),
      send: () => {
        sends.push(pi);
        const r = results.length ? results.shift()! : true;
        if (r === "throw") return Promise.reject(new Error("network down"));
        return Promise.resolve(r);
      },
      release: () => {
        releases.push(pi);
        return Promise.resolve(opts.releaseOk === false ? false : l.remove(capiClaimKey(pi)));
      },
      log: (m) => logs.push(m),
    });
  return { l, sends, releases, logs, run };
}

// -- the key ---------------------------------------------------------------------------------------------------------------------------------
Deno.test("claim key: it is the CAPI event_id, measurement_purchase:<pi>, and cannot collide with a Stripe event id (evt_...)", () => {
  assertEquals(capiClaimKey("pi_3Abc"), "measurement_purchase:pi_3Abc");
  assertEquals(capiClaimKey("pi_3Abc"), buildCapiEventId("pi_3Abc"));
  assert(!capiClaimKey("pi_3Abc").startsWith("evt_"));
  assertEquals(CAPI_CLAIM_EVENT_TYPE, "capi_purchase_claim");
});

// -- the decision ---------------------------------------------------------------------------------------------------------------------------
Deno.test("decideCapiClaim: no error means the claim is ours (send)", () => {
  assertEquals(decideCapiClaim(null), { send: true });
  assertEquals(decideCapiClaim(undefined), { send: true });
});

Deno.test("decideCapiClaim: a unique violation (23505) means already sent", () => {
  assertEquals(decideCapiClaim({ code: "23505" }), { send: false, reason: "already_sent" });
});

Deno.test("decideCapiClaim: ANY other error, or an error with no code, fails CLOSED (claim_failed)", () => {
  for (const e of [{ code: "42501" }, { code: "08006" }, { code: "PGRST301" }, { code: undefined }, {}, { code: "" }, { code: "23503" }]) {
    assertEquals(decideCapiClaim(e), { send: false, reason: "claim_failed" }, JSON.stringify(e));
  }
});

// -- the three tests Ben asked for -----------------------------------------------------------------------------------------------------------------
Deno.test("the SAME PaymentIntent under two event ids sends ONCE (the case B defect)", async () => {
  const h = harness();
  assertEquals(await h.run("pi_A"), "sent"); // event evt_1
  assertEquals(await h.run("pi_A"), "already_sent"); // event evt_2, same PI
  assertEquals(h.sends, ["pi_A"], "exactly one Meta request");
});

Deno.test("a FAILED send releases the claim, and a RETRY then sends (and only once after it succeeded)", async () => {
  const h = harness({ sendResults: [false, true] });
  assertEquals(await h.run("pi_B"), "send_failed");
  assertEquals(h.releases, ["pi_B"], "the failed send released its claim");
  assert(!h.l.keys.has(capiClaimKey("pi_B")));
  assertEquals(await h.run("pi_B"), "sent", "the retry sends");
  assertEquals(await h.run("pi_B"), "already_sent", "and a third attempt does not");
  assertEquals(h.sends, ["pi_B", "pi_B"], "two requests in total: the failed one and the successful retry");
});

Deno.test("a send that THROWS (timeout, network) also releases the claim, then rethrows so the caller logs it as before", async () => {
  const h = harness({ sendResults: ["throw", true] });
  let threw = false;
  try { await h.run("pi_C"); } catch { threw = true; }
  assert(threw, "the error still reaches the webhook's own catch (nothing is swallowed here)");
  assertEquals(h.releases, ["pi_C"]);
  assertEquals(await h.run("pi_C"), "sent");
});

Deno.test("a DIFFERENT PaymentIntent still sends", async () => {
  const h = harness();
  assertEquals(await h.run("pi_D1"), "sent");
  assertEquals(await h.run("pi_D2"), "sent");
  assertEquals(h.sends, ["pi_D1", "pi_D2"]);
});

// -- fail closed, atomicity, and the release failing ------------------------------------------------------------------------------------------------------
Deno.test("FAIL CLOSED: a claim that errors (or throws) sends NOTHING and reports claim_failed", async () => {
  for (const claimOverride of [
    () => Promise.resolve({ code: "42501" }),
    () => Promise.resolve({}),
    () => Promise.reject(new Error("db down")),
  ]) {
    const h = harness({ claimOverride });
    assertEquals(await h.run("pi_E"), "claim_failed");
    assertEquals(h.sends.length, 0, "no Meta request when the claim cannot be verified");
    assertEquals(h.releases.length, 0, "and nothing to release");
  }
});

Deno.test("ATOMIC: two runs racing on the same PaymentIntent send exactly once", async () => {
  const h = harness();
  const results = await Promise.all([h.run("pi_F"), h.run("pi_F"), h.run("pi_F")]);
  assertEquals(results.filter((r) => r === "sent").length, 1);
  assertEquals(results.filter((r) => r === "already_sent").length, 2);
  assertEquals(h.sends.length, 1);
});

Deno.test("a release that FAILS is logged with fixed text, never thrown, and the outcome is still send_failed", async () => {
  const h = harness({ sendResults: [false], releaseOk: false });
  assertEquals(await h.run("pi_G"), "send_failed");
  assert(h.logs.some((l) => l.includes("release")), "the failed release is logged");
  for (const l of h.logs) assert(!/pi_G|@|network/.test(l), "fixed text only: " + l);
});

Deno.test("a release that THROWS is contained too", async () => {
  const sends: string[] = [];
  const logs: string[] = [];
  const outcome = await sendCapiPurchaseOnce({
    claim: () => Promise.resolve(null),
    send: () => { sends.push("x"); return Promise.resolve(false); },
    release: () => Promise.reject(new Error("db down")),
    log: (m) => logs.push(m),
  });
  assertEquals(outcome, "send_failed");
  assert(logs.some((l) => l.includes("release")));
});

Deno.test("NEGATIVE CONTROL: with the claim step bypassed (always ours), the same PI under two events sends TWICE, which is exactly the walk's case B", async () => {
  const sends: string[] = [];
  const run = () => sendCapiPurchaseOnce({ claim: () => Promise.resolve(null), send: () => { sends.push("pi_A"); return Promise.resolve(true); }, release: () => Promise.resolve(true), log: () => {} });
  await run();
  await run();
  assertEquals(sends.length, 2);
});

// -- structure: wired into the handler, after every skip decision, before the Meta call, in the existing ledger ---------------------------------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const start = index.indexOf("async function handleMeasurementOrderCapiPurchase(");
const end = index.indexOf("// Entry point", start);
const handler = index.slice(start, end);

Deno.test("index.ts: the handler sends through sendCapiPurchaseOnce, exactly once, and the Meta fetch is only inside that call", () => {
  assert(start > 0 && end > start);
  assertEquals(handler.split("sendCapiPurchaseOnce(").length - 1, 1);
  assertEquals(handler.split("graph.facebook.com").length - 1, 1);
  assert(handler.indexOf("graph.facebook.com") > handler.indexOf("sendCapiPurchaseOnce("), "the Meta call is inside the once-wrapper");
});

Deno.test("index.ts: the claim is a unique-keyed insert into the EXISTING stripe_webhook_events ledger, keyed capiClaimKey(pi), typed capi_purchase_claim", () => {
  const at = handler.indexOf("sendCapiPurchaseOnce(");
  const block = handler.slice(at, at + 1500);
  assert(/\.from\("stripe_webhook_events"\)\s*\.insert\(\{\s*event_id:\s*capiClaimKey\(paymentIntent\.id\),\s*event_type:\s*CAPI_CLAIM_EVENT_TYPE\s*\}\)/.test(block), "claim insert: " + block.slice(0, 400));
});

Deno.test("index.ts: a failed send RELEASES the claim by deleting exactly that key from the ledger", () => {
  const at = handler.indexOf("sendCapiPurchaseOnce(");
  const block = handler.slice(at, at + 2500);
  assert(/\.from\("stripe_webhook_events"\)\s*\.delete\(\)\s*\.eq\("event_id",\s*capiClaimKey\(paymentIntent\.id\)\)/.test(block), "release delete");
  assert(/\.eq\("event_id",\s*capiClaimKey\(paymentIntent\.id\)\);\s*return !error;/.test(block), "the release reports whether the delete actually succeeded");
});

Deno.test("index.ts: the claim is taken AFTER every skip decision and after the payload is built (a skipped purchase never consumes a claim)", () => {
  const claimAt = handler.indexOf("sendCapiPurchaseOnce(");
  for (const before of ["shouldSkipForGpcMetadata", "shouldSkipForNonUsdMeasurement(", "decideCapiPerson(", "shouldSkipForAdSharingOptOut(", "shouldSkipForSuppression(", "shouldSendCapiEvent(", "buildCapiPurchasePayload("]) {
    const at = handler.indexOf(before);
    assert(at >= 0 && at < claimAt, `${before} comes before the claim`);
  }
});

Deno.test("index.ts: already_sent and claim_failed are logged with the PaymentIntent id and a fixed reason only, and do not send", () => {
  const at = handler.indexOf("sendCapiPurchaseOnce(");
  const after = handler.slice(at, at + 3500);
  assert(after.includes('if (outcome === "already_sent" || outcome === "claim_failed") {'), "the skip branch is live for BOTH reasons");
  assert(/console\.log\(`\[\$\{FN_NAME\}\] gh-2107: CAPI Purchase skipped for PI \$\{paymentIntent\.id\} \(\$\{outcome\}\)`\)/.test(after), "logged with the PI id and the fixed reason token");
  assert(!/console\.(log|error)\([^)]*(email|hashedEmail|digest)/i.test(after), "no email or digest in the log");
});
