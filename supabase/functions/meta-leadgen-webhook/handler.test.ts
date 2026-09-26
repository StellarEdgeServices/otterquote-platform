// gh-2154 P-5 — handler.ts tests (handlePost / handleVerification), with
// fully injected fakes: no network, no database. Run:
// deno test --allow-read=supabase/functions supabase/functions/meta-leadgen-webhook/
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { computeHmacSha256Hex, SIGNATURE_PREFIX } from "./signature.ts";
import {
  capHomeownerName,
  handlePost,
  handleVerification,
  interpretRateLimitResult,
  isDataRejectionError,
  normalizeHomeownerPhone,
  type WebhookDeps,
} from "./handler.ts";

const APP_SECRET = "meta-app-secret-fixture-not-real-000";
const VERIFY_TOKEN = "meta-leadgen-verify-token-fixture-not-real";
const PAGE_TOKEN = "meta-page-access-token-fixture-not-real";

const ALLOWLIST_RAW = JSON.stringify({
  "form_real_123": { agent_type: "re_agent", funnel_id: "meta-leadgen-re-2026" },
  "form_test_456": { agent_type: "insurance_agent", funnel_id: "meta-leadgen-test", is_test: true },
});

// #2123 HO-2: a form_id here is DISJOINT from ALLOWLIST_RAW above — a real
// Meta form_id can only ever appear in one form's config. consent_key/
// consent_text/privacy_url are REQUIRED per entry (REVIEW FAIL 5849223003
// defects 4/5) -- homeowner-allowlist.test.ts covers what happens when one
// is missing; every fixture entry here is deliberately complete so these
// handler-level tests exercise routing/registration, not allowlist parsing.
const CONSENT_KEY = "ho2_call_consent";
const CONSENT_TEXT = "By checking this box I agree Otter Quotes and a matched contractor may call/text me.";
const PRIVACY_URL = "https://otterquote.com/privacy.html";
const HOMEOWNER_ALLOWLIST_RAW = JSON.stringify({
  "form_ho2_789": { funnel_id: "ho-2", consent_key: CONSENT_KEY, consent_text: CONSENT_TEXT, privacy_url: PRIVACY_URL },
  "form_ho2_test_999": {
    funnel_id: "ho-2", is_test: true, consent_key: CONSENT_KEY, consent_text: CONSENT_TEXT, privacy_url: PRIVACY_URL,
  },
});

interface Counters {
  fetchCalls: number;
  registerCalls: number;
  duplicateCalls: number;
  rateLimitCalls: number;
  homeownerDuplicateCalls: number;
  homeownerFetchCalls: number;
  homeownerRegisterCalls: number;
  finalizeCalls: number;
}

function makeDeps(overrides: Partial<WebhookDeps> = {}, counters: Counters = {
  fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0,
  homeownerDuplicateCalls: 0, homeownerFetchCalls: 0, homeownerRegisterCalls: 0, finalizeCalls: 0,
}): WebhookDeps {
  return {
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    pageAccessToken: PAGE_TOKEN,
    allowlistRaw: ALLOWLIST_RAW,
    homeownerAllowlistRaw: HOMEOWNER_ALLOWLIST_RAW,
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
      return { duplicate: false, errored: false };
    },
    registerPartner: async () => {
      counters.registerCalls++;
      return { data: { id: "agent-fixture-id" }, error: null };
    },
    isDuplicateHomeownerLead: async () => {
      counters.homeownerDuplicateCalls++;
      return { existingId: null, roleSet: false, errored: false };
    },
    fetchHomeownerLead: async (_leadgenId, _token) => {
      counters.homeownerFetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: ["Pat Homeowner"] },
            { name: "email", values: ["pat@leadfixture.net"] },
            { name: "phone_number", values: ["+13175559999"] },
          ],
          custom_disclaimer_responses: [{ id: CONSENT_KEY, is_checked: true }],
          created_time: "2026-09-26T12:00:00+0000",
          ad_id: "ad_fixture_1",
          campaign_id: "campaign_fixture_1",
        },
        error: null,
      };
    },
    registerHomeownerLead: async () => {
      counters.homeownerRegisterCalls++;
      return { data: { id: "lead-fixture-id" }, error: null };
    },
    finalizeHomeownerLead: async () => {
      counters.finalizeCalls++;
      return { updated: true, error: null };
    },
    checkRateLimit: async () => {
      counters.rateLimitCalls++;
      return { allowed: true, errored: false };
    },
    log: () => {},
    ...overrides,
  };
}

function makeCounters(): Counters {
  return {
    fetchCalls: 0, registerCalls: 0, duplicateCalls: 0, rateLimitCalls: 0,
    homeownerDuplicateCalls: 0, homeownerFetchCalls: 0, homeownerRegisterCalls: 0, finalizeCalls: 0,
  };
}

function leadgenBody(
  over: { leadgenId?: string; formId?: string; adId?: string; adgroupId?: string } = {},
): string {
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
              ...(over.adId ? { ad_id: over.adId } : {}),
              ...(over.adgroupId ? { adgroup_id: over.adgroupId } : {}),
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
  const counters: Counters = makeCounters();
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(counters.registerCalls, 1);
  assertEquals(counters.fetchCalls, 1);
});

Deno.test("POST: forged signature -> 401 AND zero writes, zero fetches, zero duplicate checks, zero rate-limit calls", async () => {
  const body = leadgenBody();
  const forgedSig = await sign(body, "attacker-guessed-secret");
  const counters: Counters = makeCounters();
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
  const counters: Counters = makeCounters();
  const { response, outcomes } = await handlePost(tampered, sig, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 401);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.fetchCalls, 0);
});

Deno.test("POST: missing X-Hub-Signature-256 header -> 401, zero writes", async () => {
  const body = leadgenBody();
  const counters: Counters = makeCounters();
  const { response, outcomes } = await handlePost(body, null, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 401);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
});

Deno.test("POST: unset META_APP_SECRET -> 401 even with a well-formed signature header, zero writes", async () => {
  const body = leadgenBody();
  const sig = await sign(body); // signed against APP_SECRET, but deps below has no secret configured
  const counters: Counters = makeCounters();
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({ appSecret: undefined }, counters));
  assertEquals(response.status, 401);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
});

// ── dedupe / allowlist / page-token / test-lead ─────────────────────────

Deno.test("POST: dedupe on leadgen_id -- already-seen id is skipped, no register call", async () => {
  const body = leadgenBody({ leadgenId: "leadgen_dup" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({ isDuplicate: async () => { counters.duplicateCalls++; return { duplicate: true, errored: false }; } }, counters));
  assertEquals(outcomes[0].outcome, "skipped_duplicate");
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.fetchCalls, 0);
});

Deno.test("POST: non-allowlisted form_id (e.g. a homeowner #2123 form) is skipped with 200, no write", async () => {
  const body = leadgenBody({ formId: "some_homeowner_form_999" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_not_allowlisted");
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.fetchCalls, 0);
});

Deno.test("POST: unset page access token skips with 200, no fetch attempted", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = makeCounters();
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
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    registerPartner: async (args) => {
      counters.registerCalls++;
      capturedIsTest = args.isTest;
      return { data: { id: "agent-fixture-id" }, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(capturedIsTest, true);
});

Deno.test("POST: a duplicate at the register_partner layer (race) is reported as a skip, not an error", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    registerPartner: async () => {
      counters.registerCalls++;
      return { data: null, error: { message: "duplicate_meta_lead" } };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "skipped_already_registered");
});

// gh-2154 P-5r (REVIEW FAIL 5833742114 must-fix 1, fail-first on 6fde3eac):
// a Graph fetch failure used to ack 200, so Meta never redelivered it and
// the lead was lost for good. FAILS on 6fde3eac (asserted 200 there); PASSES
// here (503 -- Meta retries).
Deno.test("POST (must-fix 1): Graph fetch failure returns non-2xx (503) so Meta retries, not 200", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    fetchLead: async () => {
      counters.fetchCalls++;
      return { data: null, error: "graph_api_500" };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 503);
  assertEquals(outcomes[0].outcome, "skipped_fetch_failed");
  assertEquals(counters.registerCalls, 0);
});

// gh-2154 P-5r (REVIEW FAIL 5833742114 must-fix 1, fail-first on 6fde3eac):
// a non-duplicate register_partner() error (e.g. rate_limited from the
// shared-bucket bug, or any other DB error) used to ack 200 and drop the
// lead forever. FAILS on 6fde3eac (200 there); PASSES here (503).
Deno.test("POST (must-fix 1): register_partner error other than duplicate/partner_exists returns 503, not 200", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    registerPartner: async () => {
      counters.registerCalls++;
      return { data: null, error: { message: "rate_limited: register_partner rate limit exceeded" } };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 503);
  assertEquals(outcomes[0].outcome, "error_register_failed");
});

// gh-2154 P-5r (REVIEW FAIL 5833742114 must-fix 1, fail-first on 6fde3eac):
// a dedupe-READ error used to be silently collapsed into "yes, duplicate" --
// a permanent 200 drop indistinguishable from a real duplicate. FAILS on
// 6fde3eac (outcome was skipped_duplicate/200 there); PASSES here (503,
// distinct outcome, and no register call was skipped based on a guess).
Deno.test("POST (must-fix 1): dedupe-read DB error returns 503, distinct from a real duplicate", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    isDuplicate: async () => {
      counters.duplicateCalls++;
      return { duplicate: false, errored: true };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 503);
  assertEquals(outcomes[0].outcome, "error_dedupe_check_failed");
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.fetchCalls, 0);
});

// gh-2154 P-5r SHOULD-FIX (taken): a lead with a first name but no last name
// (e.g. the Meta form only asks "full name" as a single word, or asks for
// first/last separately and the visitor left last name blank) used to be
// dropped as skipped_incomplete_fields. It now registers with a clearly
// marked placeholder last name instead of being lost.
Deno.test("POST: first name with no last name registers with a placeholder last name, not dropped", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const captured: { firstName: string; lastName: string }[] = [];
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    fetchLead: async () => {
      counters.fetchCalls++;
      return {
        data: {
          field_data: [
            { name: "first_name", values: ["Cher"] },
            { name: "email", values: ["cher@example.com"] },
          ],
        },
        error: null,
      };
    },
    registerPartner: async (args) => {
      counters.registerCalls++;
      captured.push({ firstName: args.firstName, lastName: args.lastName });
      return { data: { id: "agent-fixture-id" }, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(captured[0]?.firstName, "Cher");
  assert(!!captured[0]?.lastName && captured[0].lastName.length > 0);
});

Deno.test("POST: rate-limited request (allowed:false) returns 429, no register call", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({ checkRateLimit: async () => { counters.rateLimitCalls++; return { allowed: false, errored: false }; } }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 429);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
});

// gh-2154 P-5 R-097 (issue comment 5825166960): checkRateLimit() used to
// fail OPEN on an RPC error, an inconsistency flagged in the risk brief
// relative to every other fail-closed guard in this branch. It now fails
// CLOSED: an RPC error or a malformed/unexpected RPC response both stop the
// request before any dedupe check, Graph API fetch, or register_partner()
// write. This is safe for Meta specifically because Meta retries webhook
// deliveries on any non-2xx response, and the re-delivered lead is made
// idempotent downstream by the meta_lead_id UNIQUE constraint plus the
// isDuplicate() check -- so a transient rate-limit RPC blip costs a retry,
// never a lost or duplicated partner.
Deno.test("POST: rate-limit RPC error fails CLOSED -- 503, zero dedupe/fetch/register calls", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({ checkRateLimit: async () => { counters.rateLimitCalls++; return { allowed: false, errored: true }; } }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 503);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.fetchCalls, 0);
  assertEquals(counters.duplicateCalls, 0);
});

Deno.test("POST: rate-limit RPC malformed response (errored flag set by the caller) fails CLOSED -- 503, zero dedupe/fetch/register calls", async () => {
  // The malformed-shape detection itself lives in index.ts's interpretation
  // of the raw RPC result (see interpretRateLimitResult in handler.ts) --
  // this exercises handlePost's side of the contract: any deps.checkRateLimit
  // call that reports errored:true, for whatever reason, must fail closed
  // identically to an outright RPC throw.
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({ checkRateLimit: async () => { counters.rateLimitCalls++; return { allowed: true, errored: true }; } }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 503);
  assertEquals(outcomes.length, 0);
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.fetchCalls, 0);
  assertEquals(counters.duplicateCalls, 0);
});

Deno.test("POST: incomplete fields (no email) skips, no register call", async () => {
  const body = leadgenBody();
  const sig = await sign(body);
  const counters: Counters = makeCounters();
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

// ── #2123 HO-2: homeowner `leads` path ──────────────────────────────────
// The partner tests above all use ALLOWLIST_RAW's form ids and must keep
// passing UNCHANGED (byte-identical partner behaviour) — none of them are
// touched by this section. These exercise the NEW homeowner-form branch,
// keyed on HOMEOWNER_ALLOWLIST_RAW's disjoint form ids.

Deno.test("POST: a homeowner form_id (#2123 HO-2) writes to leads via registerHomeownerLead, not registerPartner, then finalizes", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_001" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let captured: unknown = null;
  let finalizeArgs: unknown = null;
  const deps = makeDeps({
    registerHomeownerLead: async (args) => {
      counters.homeownerRegisterCalls++;
      captured = args;
      return { data: { id: "lead-fixture-id" }, error: null };
    },
    finalizeHomeownerLead: async (leadId, metaLeadId, consent) => {
      counters.finalizeCalls++;
      finalizeArgs = { leadId, metaLeadId, consent };
      return { updated: true, error: null };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(counters.homeownerRegisterCalls, 1);
  assertEquals(counters.finalizeCalls, 1);
  assertEquals(counters.registerCalls, 0); // never touches the partner path
  assertEquals((captured as { funnelId: string }).funnelId, "ho-2");
  assertEquals((captured as { metaLeadId: string }).metaLeadId, "leadgen_ho2_001");
  assertEquals((captured as { isSynthetic: boolean }).isSynthetic, false);
  assertEquals((finalizeArgs as { leadId: string }).leadId, "lead-fixture-id");
  assertEquals((finalizeArgs as { metaLeadId: string }).metaLeadId, "leadgen_ho2_001");
  assertEquals((finalizeArgs as { consent: { consentGiven: boolean } }).consent.consentGiven, true);
  assertEquals((finalizeArgs as { consent: { consentKey: string } }).consent.consentKey, CONSENT_KEY);
});

Deno.test("POST: a homeowner Testing Tool form (is_test:true) registers with isSynthetic true", async () => {
  const body = leadgenBody({ formId: "form_ho2_test_999", leadgenId: "leadgen_ho2_test" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let capturedSynthetic: boolean | null = null;
  const deps = makeDeps({
    registerHomeownerLead: async (args) => {
      counters.homeownerRegisterCalls++;
      capturedSynthetic = args.isSynthetic;
      return { data: { id: "lead-fixture-id" }, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(capturedSynthetic, true);
});

// REVIEW FAIL 5849223003 item 7 (optional/cheap, taken) — parity with Arm F:
// a founder/internal/QA email is synthetic even when the form itself is not
// flagged is_test.
Deno.test("POST: a homeowner lead with a founder/internal email registers with isSynthetic true (item 7 parity)", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_founder" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let capturedSynthetic: boolean | null = null;
  const deps = makeDeps({
    fetchHomeownerLead: async () => {
      counters.homeownerFetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: ["Founder Test"] },
            { name: "email", values: ["dustin@otterquote.com"] },
          ],
          custom_disclaimer_responses: [{ id: CONSENT_KEY, is_checked: true }],
        },
        error: null,
      };
    },
    registerHomeownerLead: async (args) => {
      counters.homeownerRegisterCalls++;
      capturedSynthetic = args.isSynthetic;
      return { data: { id: "lead-fixture-id" }, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(capturedSynthetic, true);
});

// REVIEW FAIL item 6 — the webhook's own ad_id/adgroup_id become
// utm_content/utm_term.
Deno.test("POST: a homeowner lead's ad_id/adgroup_id (webhook payload) become utm_content/utm_term", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_utm", adId: "ad_999", adgroupId: "adgroup_888" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let captured: unknown = null;
  const deps = makeDeps({
    registerHomeownerLead: async (args) => {
      counters.homeownerRegisterCalls++;
      captured = args;
      return { data: { id: "lead-fixture-id" }, error: null };
    },
  }, counters);
  await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals((captured as { utmContent: string | null }).utmContent, "ad_999");
  assertEquals((captured as { utmTerm: string | null }).utmTerm, "adgroup_888");
});

// Negative control: a PARTNER form_id must still route to registerPartner /
// referral_agents, never to the new homeowner path, even though both
// allowlists are parsed on every request.
Deno.test("POST negative control: a partner form_id still routes to registerPartner, never registerHomeownerLead", async () => {
  const body = leadgenBody(); // defaults to form_real_123, the partner allowlist
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({}, counters));
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(counters.registerCalls, 1);
  assertEquals(counters.homeownerRegisterCalls, 0);
  assertEquals(counters.homeownerDuplicateCalls, 0);
});

// Negative control: a form_id in NEITHER allowlist is still rejected/logged,
// never written to either table.
Deno.test("POST negative control: an unknown form_id (in neither allowlist) is skipped, never written to leads or referral_agents", async () => {
  const body = leadgenBody({ formId: "totally_unknown_form_id" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({}, counters));
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_not_allowlisted");
  assertEquals(counters.registerCalls, 0);
  assertEquals(counters.homeownerRegisterCalls, 0);
  assertEquals(counters.fetchCalls, 0);
});

Deno.test("POST: homeowner dedupe on meta_lead_id -- already-registered (role already set) is skipped, no register call", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_dup" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    isDuplicateHomeownerLead: async () => {
      counters.homeownerDuplicateCalls++;
      return { existingId: "lead-existing-id", roleSet: true, errored: false };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "skipped_already_registered");
  assertEquals(counters.homeownerRegisterCalls, 0);
  assertEquals(counters.homeownerFetchCalls, 0);
});

// REVIEW FAIL 5849223003 defect 4: the recovery path now re-fetches the
// lead from Graph (read-only, idempotent) so consent evidence can be
// written before role is set, even on a redelivery. This intentionally
// changes the pre-fix invariant ("no re-fetch on recovery") -- see
// finalizeHomeownerLead's doc comment in handler.ts.
Deno.test("POST: homeowner recovery -- existing row with role NOT yet set re-fetches, writes consent, and finalizes instead of skipping", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_recover" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let finalizeArgs: unknown = null;
  const deps = makeDeps({
    isDuplicateHomeownerLead: async () => {
      counters.homeownerDuplicateCalls++;
      return { existingId: "lead-existing-id", roleSet: false, errored: false };
    },
    finalizeHomeownerLead: async (leadId, metaLeadId, consent) => {
      counters.finalizeCalls++;
      finalizeArgs = { leadId, metaLeadId, consent };
      return { updated: true, error: null };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(counters.finalizeCalls, 1);
  assertEquals(counters.homeownerRegisterCalls, 0); // no re-insert
  assertEquals(counters.homeownerFetchCalls, 1); // re-fetch IS expected now (consent evidence)
  assertEquals((finalizeArgs as { leadId: string }).leadId, "lead-existing-id");
});

// REVIEW FAIL defect 3: 0 rows touched by the conditional role update is a
// TERMINAL race (another delivery's finalize already won), never a 503 retry.
Deno.test("POST: homeowner recovery -- a concurrent finalize already won (0 rows updated) is a terminal skip, not a retry", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_race" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    isDuplicateHomeownerLead: async () => {
      counters.homeownerDuplicateCalls++;
      return { existingId: "lead-existing-id", roleSet: false, errored: false };
    },
    finalizeHomeownerLead: async () => {
      counters.finalizeCalls++;
      return { updated: false, error: null };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_already_registered");
});

// REVIEW FAIL defect 3: this is the case that used to be permanently stuck --
// a redelivery long after the old RPC's 30-minute window. The service-role
// conditional update has no such window, so this now succeeds.
Deno.test("POST: homeowner recovery -- redelivery arriving well past 30 minutes still finalizes (no RPC window any more)", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_late" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    isDuplicateHomeownerLead: async () => {
      counters.homeownerDuplicateCalls++;
      return { existingId: "lead-existing-id", roleSet: false, errored: false };
    },
    // The fake never even models a time window -- the point is that
    // finalizeHomeownerLead's contract (id + meta_lead_id + role IS NULL)
    // carries no time component at all, unlike the old set_lead_role() RPC.
    finalizeHomeownerLead: async () => {
      counters.finalizeCalls++;
      return { updated: true, error: null };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "registered");
});

// Double-delivery: two redeliveries of the same recovery both land; the
// first's finalize updates the row, the second's finalize (0 rows) is a
// terminal skip -- the alert fires exactly once either way.
Deno.test("POST: homeowner double-delivery -- second finalize call in a row sees 0 rows updated and is a terminal skip", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_double" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let calls = 0;
  const deps = makeDeps({
    isDuplicateHomeownerLead: async () => {
      counters.homeownerDuplicateCalls++;
      return { existingId: "lead-existing-id", roleSet: false, errored: false };
    },
    finalizeHomeownerLead: async () => {
      counters.finalizeCalls++;
      calls++;
      return { updated: calls === 1, error: null };
    },
  }, counters);
  const first = await handlePost(body, sig, "1.2.3.4", deps);
  const second = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(first.outcomes[0].outcome, "registered");
  assertEquals(second.response.status, 200);
  assertEquals(second.outcomes[0].outcome, "skipped_already_registered");
  assertEquals(counters.finalizeCalls, 2);
});

Deno.test("POST: homeowner dedupe-read DB error returns 503, distinct from a real duplicate", async () => {
  const body = leadgenBody({ formId: "form_ho2_789" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    isDuplicateHomeownerLead: async () => {
      counters.homeownerDuplicateCalls++;
      return { existingId: null, roleSet: false, errored: true };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 503);
  assertEquals(outcomes[0].outcome, "error_dedupe_check_failed");
  assertEquals(counters.homeownerRegisterCalls, 0);
});

// REVIEW FAIL defect 1 (BLOCKER): live leads.email is NOT NULL. This test
// used to assert "registered" against a MOCKED registerHomeownerLead, which
// proved nothing about the real insert -- it now asserts the correct
// rejection, with zero register calls, per the fix.
Deno.test("POST: homeowner lead with phone but no email IS dropped (defect 1 fix -- email is required)", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_phoneonly" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    fetchHomeownerLead: async () => {
      counters.homeownerFetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: ["Pat Homeowner"] },
            { name: "phone_number", values: ["+13175559999"] },
          ],
        },
        error: null,
      };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "skipped_incomplete_fields");
  assertEquals(counters.homeownerRegisterCalls, 0);
});

Deno.test("POST: homeowner lead with no name is dropped (incomplete_fields), no register call", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_noname" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    fetchHomeownerLead: async () => {
      counters.homeownerFetchCalls++;
      return { data: { field_data: [{ name: "email", values: ["noname@example.com"] }] }, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "skipped_incomplete_fields");
  assertEquals(counters.homeownerRegisterCalls, 0);
});

Deno.test("POST: homeowner lead with a name and email but no phone IS registered (phone is still optional)", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_noPhone" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    fetchHomeownerLead: async () => {
      counters.homeownerFetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: ["Pat NoPhone"] },
            { name: "email", values: ["pat.nophone@example.com"] },
          ],
          custom_disclaimer_responses: [{ id: CONSENT_KEY, is_checked: true }],
        },
        error: null,
      };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered");
});

Deno.test("POST: a homeowner registerHomeownerLead unique-violation race is reported as a skip, not an error", async () => {
  const body = leadgenBody({ formId: "form_ho2_789" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    registerHomeownerLead: async () => {
      counters.homeownerRegisterCalls++;
      return { data: null, error: { message: "duplicate_meta_lead" } };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_already_registered");
});

Deno.test("POST: a homeowner finalizeHomeownerLead transient error (e.g. consent write failed) returns 503, not 200", async () => {
  const body = leadgenBody({ formId: "form_ho2_789" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    finalizeHomeownerLead: async () => {
      counters.finalizeCalls++;
      return { updated: false, error: { message: "consent_write_failed" } };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 503);
  assertEquals(outcomes[0].outcome, "error_register_failed");
});

Deno.test("POST: unset page access token skips homeowner lead with 200, no fetch attempted", async () => {
  const body = leadgenBody({ formId: "form_ho2_789" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", makeDeps({ pageAccessToken: undefined }, counters));
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_page_token_unset");
  assertEquals(counters.homeownerFetchCalls, 0);
  assertEquals(counters.homeownerRegisterCalls, 0);
});

// ── #2123 HO-2 D-299 consent evidence (defect 4) ────────────────────────

Deno.test("POST: unticked consent checkbox still registers the lead, with consent_given=false (Arm F semantics: both outcomes are evidence)", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_unticked" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let finalizeArgs: unknown = null;
  const deps = makeDeps({
    fetchHomeownerLead: async () => {
      counters.homeownerFetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: ["Pat Unticked"] },
            { name: "email", values: ["pat.unticked@example.com"] },
          ],
          custom_disclaimer_responses: [{ id: CONSENT_KEY, is_checked: false }],
        },
        error: null,
      };
    },
    finalizeHomeownerLead: async (leadId, metaLeadId, consent) => {
      counters.finalizeCalls++;
      finalizeArgs = consent;
      return { updated: true, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered"); // NOT dropped -- the lead is still written
  assertEquals((finalizeArgs as { consentGiven: boolean }).consentGiven, false);
});

Deno.test("POST: a missing checkbox answer (no custom_disclaimer_responses at all) still registers, with consent_given=false", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_nocheckbox" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let finalizeArgs: unknown = null;
  const deps = makeDeps({
    fetchHomeownerLead: async () => {
      counters.homeownerFetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: ["Pat NoCheckbox"] },
            { name: "email", values: ["pat.nocheckbox@example.com"] },
          ],
          // no custom_disclaimer_responses field at all
        },
        error: null,
      };
    },
    finalizeHomeownerLead: async (leadId, metaLeadId, consent) => {
      counters.finalizeCalls++;
      finalizeArgs = consent;
      return { updated: true, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals((finalizeArgs as { consentGiven: boolean }).consentGiven, false);
});

// A missing consent config (allowlist entry missing consent_key/text/
// privacy_url) is covered by homeowner-allowlist.test.ts's parse-level
// tests -- the entry never reaches the allowlist handlePost sees, so the
// form_id it would have keyed is simply not_allowlisted here.
Deno.test("POST: a homeowner form_id whose allowlist entry has no consent config at all is not_allowlisted (config error)", async () => {
  const rawWithBadEntry = JSON.stringify({
    form_ho2_noconsent: { funnel_id: "ho-2" }, // missing consent_key/consent_text/privacy_url
  });
  const body = leadgenBody({ formId: "form_ho2_noconsent" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const logs: string[] = [];
  const deps = makeDeps({
    homeownerAllowlistRaw: rawWithBadEntry,
    log: (_level, message) => logs.push(message),
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_not_allowlisted");
  assertEquals(counters.homeownerRegisterCalls, 0);
  assert(logs.some((m) => m.includes("form_ho2_noconsent")));
});

// ── interpretRateLimitResult — index.ts's check_rate_limit() RPC result ──
// interpretation, extracted as a pure function so the malformed-shape case
// (the RPC succeeding but returning something that isn't `{ allowed: bool }`)
// is unit-testable without a real Supabase client or network access.

Deno.test("interpretRateLimitResult: RPC error -> errored:true, allowed:false", () => {
  const result = interpretRateLimitResult(null, { message: "connection reset" });
  assertEquals(result, { allowed: false, errored: true });
});

Deno.test("interpretRateLimitResult: well-formed { allowed: true } -> errored:false, allowed:true", () => {
  const result = interpretRateLimitResult({ allowed: true }, null);
  assertEquals(result, { allowed: true, errored: false });
});

Deno.test("interpretRateLimitResult: well-formed { allowed: false } -> errored:false, allowed:false", () => {
  const result = interpretRateLimitResult({ allowed: false }, null);
  assertEquals(result, { allowed: false, errored: false });
});

Deno.test("interpretRateLimitResult: null data (no error) -> malformed, fails closed", () => {
  const result = interpretRateLimitResult(null, null);
  assertEquals(result, { allowed: false, errored: true });
});

Deno.test("interpretRateLimitResult: data missing the allowed field -> malformed, fails closed", () => {
  const result = interpretRateLimitResult({ reason: "burst_limit" }, null);
  assertEquals(result, { allowed: false, errored: true });
});

Deno.test("interpretRateLimitResult: allowed is a non-boolean (e.g. string) -> malformed, fails closed", () => {
  const result = interpretRateLimitResult({ allowed: "true" }, null);
  assertEquals(result, { allowed: false, errored: true });
});

// ── REVIEW FAIL 5849684429 fix 1: normalizeHomeownerPhone (Arm F parity) ───

Deno.test("normalizeHomeownerPhone: +13175551234 becomes 3175551234", () => {
  assertEquals(normalizeHomeownerPhone("+13175551234"), "3175551234");
});

Deno.test("normalizeHomeownerPhone: 11 digits with a leading 1 drops the 1", () => {
  assertEquals(normalizeHomeownerPhone("1-317-555-1234"), "3175551234");
});

Deno.test("normalizeHomeownerPhone: bare 10 digits pass through unchanged", () => {
  assertEquals(normalizeHomeownerPhone("(317) 555-1234"), "3175551234");
});

Deno.test("normalizeHomeownerPhone: a 25-character international/extension value becomes null", () => {
  assertEquals(normalizeHomeownerPhone("+44 20 7946 0958 ext 123"), null);
});

Deno.test("normalizeHomeownerPhone: too short becomes null", () => {
  assertEquals(normalizeHomeownerPhone("5551234"), null);
});

Deno.test("normalizeHomeownerPhone: null/empty input becomes null", () => {
  assertEquals(normalizeHomeownerPhone(null), null);
  assertEquals(normalizeHomeownerPhone(""), null);
});

// ── REVIEW FAIL 5849684429 fix 2: capHomeownerName ──────────────────────────

Deno.test("capHomeownerName: a name at or under 200 chars is unchanged", () => {
  const name = "Pat Homeowner";
  assertEquals(capHomeownerName(name), name);
});

Deno.test("capHomeownerName: a name over 200 chars is truncated to exactly 200", () => {
  const name = "A".repeat(250);
  const capped = capHomeownerName(name);
  assertEquals(capped.length, 200);
  assertEquals(capped, "A".repeat(200));
});

Deno.test("capHomeownerName: truncation never leaves a dangling high surrogate", () => {
  // An emoji ("😀") is a surrogate pair; put its high half exactly at index 200.
  const name = "B".repeat(199) + "😀" + "C".repeat(50);
  const capped = capHomeownerName(name);
  assert(capped.length <= 200);
  const last = capped.charCodeAt(capped.length - 1);
  assertFalse(last >= 0xd800 && last <= 0xdbff);
});

// ── REVIEW FAIL 5849684429 fix 3: isDataRejectionError classification ──────

Deno.test("isDataRejectionError: 23502 (not_null_violation) is a data rejection", () => {
  assert(isDataRejectionError("23502"));
});

Deno.test("isDataRejectionError: 23514 (check_violation) is a data rejection", () => {
  assert(isDataRejectionError("23514"));
});

Deno.test("isDataRejectionError: a 22xxx data-exception class is a data rejection", () => {
  assert(isDataRejectionError("22001"));
});

Deno.test("isDataRejectionError: 23505 (unique_violation) is NOT a data rejection -- handled as terminal duplicate separately", () => {
  assertFalse(isDataRejectionError("23505"));
});

Deno.test("isDataRejectionError negative control: 08006 (connection failure) is NOT a data rejection -- stays transient", () => {
  assertFalse(isDataRejectionError("08006"));
});

Deno.test("isDataRejectionError: undefined/null code is NOT a data rejection", () => {
  assertFalse(isDataRejectionError(undefined));
  assertFalse(isDataRejectionError(null));
});

// ── REVIEW FAIL 5849684429 -- handler-level wiring for phone/name/data-rejection ──

Deno.test("POST: homeowner phone is normalised to 10 digits before registerHomeownerLead is called", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_phonefmt" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let seenPhone: string | null | undefined;
  const deps = makeDeps({
    fetchHomeownerLead: async () => {
      counters.homeownerFetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: ["Pat Homeowner"] },
            { name: "email", values: ["pat@leadfixture.net"] },
            { name: "phone_number", values: ["+1 (317) 555-1234"] },
          ],
          custom_disclaimer_responses: [{ id: CONSENT_KEY, is_checked: true }],
        },
        error: null,
      };
    },
    registerHomeownerLead: async (args) => {
      counters.homeownerRegisterCalls++;
      seenPhone = args.phone;
      return { data: { id: "lead-fixture-id" }, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(seenPhone, "3175551234");
});

Deno.test("POST: a 25-character, non-US-shaped homeowner phone is stored as null and registration still succeeds", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_badphone" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let seenPhone: string | null | undefined = "not set";
  const deps = makeDeps({
    fetchHomeownerLead: async () => {
      counters.homeownerFetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: ["Pat Homeowner"] },
            { name: "email", values: ["pat@leadfixture.net"] },
            { name: "phone_number", values: ["+44 20 7946 0958 ext 12"] },
          ],
          custom_disclaimer_responses: [{ id: CONSENT_KEY, is_checked: true }],
        },
        error: null,
      };
    },
    registerHomeownerLead: async (args) => {
      counters.homeownerRegisterCalls++;
      seenPhone = args.phone;
      return { data: { id: "lead-fixture-id" }, error: null };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "registered");
  assertEquals(seenPhone, null);
});

Deno.test("POST: an over-200-char homeowner name is capped, not dropped, and registration still succeeds", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_longname" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  let seenName: string | undefined;
  const longName = "Patricia " + "Middlename".repeat(25); // well over 200 chars
  const deps = makeDeps({
    fetchHomeownerLead: async () => {
      counters.homeownerFetchCalls++;
      return {
        data: {
          field_data: [
            { name: "full_name", values: [longName] },
            { name: "email", values: ["pat.longname@leadfixture.net"] },
          ],
          custom_disclaimer_responses: [{ id: CONSENT_KEY, is_checked: true }],
        },
        error: null,
      };
    },
    registerHomeownerLead: async (args) => {
      counters.homeownerRegisterCalls++;
      seenName = args.name;
      return { data: { id: "lead-fixture-id" }, error: null };
    },
  }, counters);
  const { outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(outcomes[0].outcome, "registered");
  assert(seenName !== undefined && seenName.length === 200);
  assertEquals(seenName, longName.slice(0, 200));
});

Deno.test("POST: registerHomeownerLead rejected_invalid_data (e.g. mocked 23514 check_violation) is a terminal 200 skip, not a 503 retry", async () => {
  const body = leadgenBody({ formId: "form_ho2_789" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    registerHomeownerLead: async () => {
      counters.homeownerRegisterCalls++;
      return { data: null, error: { message: "rejected_invalid_data" } };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_invalid_data");
});

Deno.test("POST negative control: registerHomeownerLead's other (transient, e.g. mocked 08006 connection) errors still return 503, still retry", async () => {
  const body = leadgenBody({ formId: "form_ho2_789" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    registerHomeownerLead: async () => {
      counters.homeownerRegisterCalls++;
      return { data: null, error: { message: "connection reset" } };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 503);
  assertEquals(outcomes[0].outcome, "error_register_failed");
});

Deno.test("POST: finalizeHomeownerLead rejected_invalid_data (e.g. mocked lead_consents 23502) is a terminal 200 skip, not a 503 retry", async () => {
  const body = leadgenBody({ formId: "form_ho2_789" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    finalizeHomeownerLead: async () => {
      counters.finalizeCalls++;
      return { updated: false, error: { message: "rejected_invalid_data" } };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_invalid_data");
});

Deno.test("POST negative control: finalizeHomeownerLead's other transient errors still return 503, still retry", async () => {
  const body = leadgenBody({ formId: "form_ho2_789" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    finalizeHomeownerLead: async () => {
      counters.finalizeCalls++;
      return { updated: false, error: { message: "consent_write_failed" } };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 503);
  assertEquals(outcomes[0].outcome, "error_register_failed");
});

Deno.test("POST: homeowner recovery path's finalizeHomeownerLead rejected_invalid_data is also a terminal 200 skip, not a 503 retry", async () => {
  const body = leadgenBody({ formId: "form_ho2_789", leadgenId: "leadgen_ho2_recover_baddata" });
  const sig = await sign(body);
  const counters: Counters = makeCounters();
  const deps = makeDeps({
    isDuplicateHomeownerLead: async () => {
      counters.homeownerDuplicateCalls++;
      return { existingId: "existing-lead-id", roleSet: false, errored: false };
    },
    finalizeHomeownerLead: async () => {
      counters.finalizeCalls++;
      return { updated: false, error: { message: "rejected_invalid_data" } };
    },
  }, counters);
  const { response, outcomes } = await handlePost(body, sig, "1.2.3.4", deps);
  assertEquals(response.status, 200);
  assertEquals(outcomes[0].outcome, "skipped_invalid_data");
});
