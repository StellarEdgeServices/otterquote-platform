// gh-2154 P-5 — handler.ts tests (handlePost / handleVerification), with
// fully injected fakes: no network, no database. Run:
// deno test --allow-read=supabase/functions supabase/functions/meta-leadgen-webhook/
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { computeHmacSha256Hex, SIGNATURE_PREFIX } from "./signature.ts";
import { handlePost, handleVerification, type WebhookDeps } from "./handler.ts";

const APP_SECRET = "meta-app-secret-fixture-not-real-000";
const VERIFY_TOKEN = "meta-leadgen-verify-token-fixture-not-real";
const PAGE_TOKEN = "meta-page-access-token-fixture-not-real";

const ALLOWLIST_RAW = JSON.stringify({
  "form_real_123": { agent_type: "re_agent", funnel_id: "meta-leadgen-re-2026" },
  "form_test_456": { agent_type: "insurance_agent", funnel_id: "meta-leadgen-test", is_test: true },
});

interface Counters {
  fetchCalls: number;
  registerCalls: number;
  duplicateCalls: number;
  rateLimitCalls: number;
}

function makeDeps(overrides: Partial<WebhookDeps> = {}, counters: Counters = {
  fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0,
}): WebhookDeps {
  return {
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    pageAccessToken: PAGE_TOKEN,
    allowlistRaw: ALLOWLIST_RAW,
    fetchLead: async (_leadgenId, _token) => {
      counters.fetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: ["Jamie Rivera"] },
            { name: "email", values: ["jamie@example.com"] },
            { name: "phone_number", values: ["+13175551234"] },
            { name: "company_name", values: ["Rivera Realty"] },
          ],
        },
        error: null,
      };
    },
    isDuplicate: async () => {
      counters.duplicateCalls++;
      return false;
    },
    registerPartner: async () => {
      counters.registerCalls++;
      return { error: null };
    },
    checkRateLimit: async () => {
      counters.rateLimitCalls++;
      return { allowed: true, errored: false };
    },
    log: () => {},
    ...overrides,
  };
}

function leadgenBody(over: { leadgenId?: string; formId?: string } = {}): string {
  return JSON.stringify({
    entry: [
      {
        id: over.formId ?? "page_1",
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: over.leadgenId ?? "leadgen_001",
              form_id: over.formId ?? "form_real_123",
              page_id: "page_1",
              created_time: 1732400000,
            },
          },
        ],
      },
    ],
  });
}

async function sign(body: string, secret = APP_SECRET): Promise<string> {
  const hex = await computeHmacSha256Hex(secret, body);
  return `${SIGNATURE_PREFIX}${hex}`;
}

// ── GET / handshake ─────────────────────────────────────────────────────

Deno.test("GET handshake: ok token returns 200 + challenge text", () => {
  const url = new URL(`https://x/meta-leadgen-webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=999`);
  const res = handleVerification(url, { verifyToken: VERIFY_TOKEN, log: () => {} });
  assertEquals(res.status, 200);
});

Deno.test("GET handshake: wrong token returns 403", () => {
  const url = new URL(`https://x/meta-leadgen-webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=999`);
  const res = handleVerification(url, { verifyToken: VERIFY_TOKEN, log: () => {} });
  assertEquals(res.status, 403);
});

Deno.test("GET handshake: unset secret returns 403", () => {
  const url = new URL(`https://x/meta-leadgen-webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=999`);
  const res = handleVerification(url, { verifyToken: undefined, log: () => {} });
  assertEquals(res.status, 403);
});

// ── POST / signature — THE negative control ─────────────────────────────

Deno.test("POST: valid signature processes the lead and writes once", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(counters.registerCalls, 1);
  assertEquals(counters.fetchCalls, 1);
});

Deno.test("POST: forged signature -> 401 AND zero writes, zero fetches, zero duplicate checks, zero rate-limit calls", async () => {
  const body = leadgenBody();
  const forgedSig = await sign(body, "attacker-guessed-secret");
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const { response, outcomes } = await handlePost(body, forgedSig, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 401);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.fetchCalls, 0);
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.duplicateCalls, 0);
  assertEquals(counters.rateLimitCalls, 0);
});

Deno.test("POST: body tampered after signing -> 401 AND zero writes/fetches", async () => {
  const original = leadgenBody({ leadgenId: "leadgen_original" });
  const tampered = leadgenBody({ leadgenId: "leadgen_swapped" });
  const sig = await sign(original);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const { response, outcomes } = await handlePost(tampered, sig, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 401);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.fetchCalls, 0);
});

Deno.test("POST: missing X-Hub-Signature-256 header -> 401, zero writes", async () => {
  const body = leadgenBody();
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const { response, outcomes } = await handlePost(body, null, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 401);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
});

Deno.test("POST: unset META_APP_SECRET -> 401 even with a well-formed signature header, zero writes", async () => {
  const body = leadgenBody();
  const sig = await sign(body); // signed against APP_SECRET, but deps below has no secret configured
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({ appSecret: undefined }, counters));
  assertEquals(response.status, 401);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
});

// ── dedupe / allowlist / page-token / test-lead ─────────────────────────

Deno.test("POST: dedupe on leadgen_id -- already-seen id is skipped, no register call", async () => {
  const body = leadgenBody({ leadgenId: "leadgen_dup" });
  const sig = await sign(body);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({ isDuplicate: async () => { counters.duplicateCalls++; return true; } }, counters));
  assertEquals(outcomes[0].outcome, "skipped_duplicate");
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.fetchCalls, 0);
});

Deno.test("POST: non-allowlisted form_id (e.g. a homeowner #2123 form) is skipped with 200, no write", async () => {
  const body = leadgenBody({ formId: "some_homeowner_form_999" });
  const sig = await sign(body);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_not_allowlisted");
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.fetchCalls, 0);
});

Deno.test("POST: unset page access token skips with 200, no fetch attempted", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({ pageAccessToken: undefined }, counters));
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_page_token_unset");
  assertEquals(counters.fetchCalls, 0);
  assertEquals(counters.registerCalls, 0);
});

Deno.test("POST: a Testing Tool form (is_test:true in the allowlist) registers with isTest true", async () => {
  const body = leadgenBody({ formId: "form_test_456", leadgenId: "leadgen_test_lead" });
  const sig = await sign(body);
  let capturedIsTest: boolean | null = null;
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const deps = makeDeps({
    registerPartner: async (args) => {
      counters.registerCalls++;
      capturedIsTest = args.isTest;
      return { error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(capturedIsTest, true);
});

Deno.test("POST: a duplicate at the register_partner layer (race) is reported as a skip, not an error", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const deps = makeDeps({
    registerPartner: async () => {
      counters.registerCalls++;
      return { error: { message: "duplicate_meta_lead" } };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "skipped_already_registered");
});

Deno.test("POST: fetch failure skips with 200, no register call", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const deps = makeDeps({
    fetchLead: async () => {
      counters.fetchCalls++;
      return { data: null, error: "graph_api_500" };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_fetch_failed");
  assertEquals(counters.registerCalls, 0);
});

Deno.test("POST: rate-limited request (allowed:false) returns 429, no register call", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const deps = makeDeps({ checkRateLimit: async () => { counters.rateLimitCalls++; return { allowed: false, errored: false }; } }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 429);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
});

Deno.test("POST: rate-limit RPC error fails OPEN (processing continues)", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const deps = makeDeps({ checkRateLimit: async () => { counters.rateLimitCalls++; return { allowed: false, errored: true }; } }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "registered");
});

Deno.test("POST: incomplete fields (no email) skips, no register call", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = { fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0 };
  const deps = makeDeps({
    fetchLead: async () => {
      counters.fetchCalls++;
      return { data: { field_data: [{ name: "full_name", values: ["No Email Here"] }] }, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "skipped_incomplete_fields");
  assertEquals(counters.registerCalls, 0);
});
