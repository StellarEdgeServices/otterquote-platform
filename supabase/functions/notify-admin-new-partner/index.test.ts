// gh-2154 P-3 — working test, written first (#2121 rule 2). The module this
// imports (./index.ts) does not exist yet. It is a direct structural copy of
// notify-admin-new-contractor (see that function's own index.ts): same
// pg_net-trigger-on-INSERT pattern, same test-account filter, same
// idempotency-via-notifications-table design, pointed at `referral_agents`
// instead of `contractors`.
//
// Export shape assumed for the future index.ts (documented choice, since
// notify-admin-new-contractor itself exports nothing — everything lives
// inline in its `serve()` callback, which is not stubbable). This test
// instead follows the dependency-injection convention already used
// elsewhere in this tree (see send-home-profile-prompt/index.ts's
// `ProcessClaimSupabase` + injected-fetch pattern in its index.test.ts):
//
//   export const ADMIN_EMAIL: string;
//   export const NOTIFICATION_TYPE: string; // "admin_new_partner"
//   export function isTestAccount(email: string): boolean;
//   export interface PartnerDeps {
//     serviceRoleKey: string;
//     mailgunKey: string;
//     mailgunDomain: string;
//     supabase: PartnerSupabase;   // structural fake, like ProcessClaimSupabase
//     fetchImpl: typeof fetch;     // injected so tests never hit real Mailgun
//   }
//   export function handleNotifyAdminNewPartner(req: Request, deps: PartnerDeps): Promise<Response>;
//
// If the real build instead follows notify-admin-new-contractor's fully
// inline shape with no injected fetch/deps, this test's harness (fakeFetch +
// fakeSupabase below) will need a matching adjustment when P-3 is built —
// noted in the task report.
import { assertEquals, assertMatch } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  ADMIN_EMAIL,
  handleNotifyAdminNewPartner,
  isTestAccount,
  NOTIFICATION_TYPE,
  type PartnerDeps,
  type PartnerRow,
} from "./index.ts";

const SERVICE_ROLE_KEY = "fake-service-role-key";
const MAILGUN_DOMAIN = "mail.otterquote.test";

const PARTNER: PartnerRow = {
  id: "a1111111-2222-3333-4444-555555555555",
  user_id: "u1111111-2222-3333-4444-555555555555",
  agent_type: "realtor",
  first_name: "Jamie",
  last_name: "Partner",
  email: "jamie.partner@example.invalid",
  company: "Jamie Realty Co",
  funnel_id: "re-1",
  fbclid: "super-secret-fbclid-value-should-never-leak",
  is_test: false,
  created_at: new Date().toISOString(),
};

function fakeSupabase(opts: {
  partner?: PartnerRow | null;
  existingNotifications?: number;
  onCall?: (event: string) => void;
}): {
  supabase: PartnerDeps["supabase"];
  inserted: Record<string, unknown>[];
  selects: { table: string; filters: Record<string, unknown> }[];
} {
  const inserted: Record<string, unknown>[] = [];
  const selects: { table: string; filters: Record<string, unknown> }[] = [];
  const partner = opts.partner === undefined ? PARTNER : opts.partner;
  const existingCount = opts.existingNotifications ?? 0;
  const onCall = opts.onCall ?? (() => {});

  const supabase: PartnerDeps["supabase"] = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        select(_cols: string) {
          return chain;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        limit(_n: number) {
          selects.push({ table, filters: { ...filters } });
          if (table === "notifications") {
            onCall("read:notifications");
            const rows = existingCount > 0 ? [{ id: "n-1" }] : [];
            return Promise.resolve({ data: rows, error: null });
          }
          onCall(`read:${table}`);
          return Promise.resolve({ data: [], error: null });
        },
        single() {
          selects.push({ table, filters: { ...filters } });
          if (table === "referral_agents") {
            onCall("read:referral_agents");
            return Promise.resolve(
              partner ? { data: partner, error: null } : { data: null, error: { message: "not found" } },
            );
          }
          onCall(`read:${table}`);
          return Promise.resolve({ data: null, error: { message: "unexpected table " + table } });
        },
        insert(row: Record<string, unknown>) {
          onCall(`insert:${table}`);
          inserted.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  };
  return { supabase, inserted, selects };
}

/** Extracts a readable string from a Mailgun FormData body for assertions. */
function formDataToText(body: unknown): string {
  if (body instanceof FormData) {
    const parts: string[] = [];
    for (const [key, value] of body.entries()) {
      parts.push(`${key}=${typeof value === "string" ? value : "[blob]"}`);
    }
    return parts.join("\n");
  }
  return String(body);
}

function fakeFetch(
  impl: (input: string | Request | URL, init?: RequestInit) => Promise<Response>,
): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = ((input: string | Request | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return impl(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function buildDeps(overrides: Partial<PartnerDeps> = {}, opts: { partner?: PartnerRow | null; existingNotifications?: number } = {}): {
  deps: PartnerDeps;
  inserted: Record<string, unknown>[];
  selects: { table: string; filters: Record<string, unknown> }[];
  fetchCalls: { url: string; init?: RequestInit }[];
} {
  const { supabase, inserted, selects } = fakeSupabase(opts);
  const { fetchImpl, calls } = fakeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ id: "<partner-msg-1@mail.otterquote.test>" }), { status: 200 }))
  );
  const deps: PartnerDeps = {
    serviceRoleKey: SERVICE_ROLE_KEY,
    mailgunKey: "fake-mailgun-key",
    mailgunDomain: MAILGUN_DOMAIN,
    supabase,
    fetchImpl,
    ...overrides,
  };
  return { deps, inserted, selects, fetchCalls: calls };
}

function makeRequest(body: unknown, opts: { bearer?: string | null } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.bearer !== null) {
    headers["Authorization"] = `Bearer ${opts.bearer ?? SERVICE_ROLE_KEY}`;
  }
  return new Request("https://x.supabase.co/functions/v1/notify-admin-new-partner", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// (a) Valid INSERT payload for a non-test partner sends exactly ONE admin
// email, naming name/agent_type/email/company/funnel_id and fbclid
// presence-only (never the raw value, never a secret).
// ---------------------------------------------------------------------------
Deno.test("(a) valid non-test partner insert sends exactly one admin email with the right fields, no raw fbclid, no secret", async () => {
  const { deps, inserted, fetchCalls } = buildDeps();
  const req = makeRequest({ partner_id: PARTNER.id });

  const res = await handleNotifyAdminNewPartner(req, deps);
  const json = await res.json();

  assertEquals(res.status, 200);
  assertEquals(json.success, true);

  // Exactly one outbound send (to Mailgun, this repo's provider).
  const mailgunCalls = fetchCalls.filter((c) => c.url.includes("api.mailgun.net"));
  assertEquals(mailgunCalls.length, 1);

  const sentBody = formDataToText(mailgunCalls[0].init?.body);
  // recipient is the admin, read from the module's own constant — never
  // hardcoded here as a guess.
  assertEquals(ADMIN_EMAIL.length > 0, true);
  assertMatch(sentBody, /jamie\.partner@example\.invalid/); // partner email named
  assertMatch(sentBody, new RegExp(PARTNER.company!.replace(/\s/g, "\\s")));
  assertMatch(sentBody, /Jamie/);
  assertMatch(sentBody, /realtor/i); // agent_type
  assertMatch(sentBody, /re-1/); // funnel_id
  // fbclid presence-only: "yes"/"present", never the raw token.
  assertMatch(sentBody, /fbclid[^a-z0-9]{0,20}(yes|present|true)/i);
  assertEquals(sentBody.includes(PARTNER.fbclid!), false);
  // No secret leaks into the email body.
  assertEquals(sentBody.includes(SERVICE_ROLE_KEY), false);
  assertEquals(sentBody.includes(deps.mailgunKey), false);

  // Exactly one notifications row recorded as sent.
  assertEquals(inserted.filter((i) => i.table === "notifications").length, 1);
  assertEquals((inserted[0].row as Record<string, unknown>).notification_type, NOTIFICATION_TYPE);
});

// ---------------------------------------------------------------------------
// (b) Idempotency: same partner id twice gives one send.
// ---------------------------------------------------------------------------
Deno.test("(b) idempotency: a second call for the same partner id sends zero more emails", async () => {
  // First call: no prior notification.
  const first = buildDeps({}, { existingNotifications: 0 });
  const res1 = await handleNotifyAdminNewPartner(makeRequest({ partner_id: PARTNER.id }), first.deps);
  assertEquals(res1.status, 200);
  assertEquals(first.fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 1);

  // Second call: notifications table now has a row for this partner (as the
  // first call would have produced) -> handler must skip the send.
  const second = buildDeps({}, { existingNotifications: 1 });
  const res2 = await handleNotifyAdminNewPartner(makeRequest({ partner_id: PARTNER.id }), second.deps);
  const json2 = await res2.json();

  assertEquals(res2.status, 200);
  assertEquals(json2.skipped, true);
  assertEquals(second.fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 0);
  assertEquals(second.inserted.filter((i) => i.table === "notifications").length, 0);
});

// ---------------------------------------------------------------------------
// (c) is_test=true partner: handled exactly like notify-admin-new-contractor
// treats test accounts -- SKIPPED (no send, 200 success:true skipped:true,
// reason "test_account"), not sent-with-a-[TEST]-tag. Confirmed by reading
// notify-admin-new-contractor/index.ts's isTestAccount() + the early-return
// branch at its "skipping test account" log line.
// ---------------------------------------------------------------------------
Deno.test("(c) is_test=true partner is skipped, matching notify-admin-new-contractor's test-account behaviour", async () => {
  const testPartner: PartnerRow = { ...PARTNER, is_test: true, email: "pfw-test-partner@example.invalid" };
  const { deps, fetchCalls, inserted } = buildDeps({}, { partner: testPartner });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: testPartner.id }), deps);
  const json = await res.json();

  assertEquals(res.status, 200);
  assertEquals(json.success, true);
  assertEquals(json.skipped, true);
  assertEquals(json.reason, "test_account");
  assertEquals(fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 0);
  assertEquals(inserted.length, 0);
});

Deno.test("isTestAccount matches the same patterns notify-admin-new-contractor uses", () => {
  assertEquals(isTestAccount("someone@otterquote-internal.test"), true);
  assertEquals(isTestAccount("pfw-jamie@example.invalid"), true);
  assertEquals(isTestAccount("authdoctor-run@example.invalid"), true);
  assertEquals(isTestAccount("real.partner@example.invalid"), false);
});

// ---------------------------------------------------------------------------
// (d) Negative controls.
// ---------------------------------------------------------------------------
Deno.test("(d) payload for another table's id shape gives 0 sends and a 4xx", async () => {
  const { deps, fetchCalls } = buildDeps({}, { partner: null });
  // Wrong field name entirely (as if a caller wired the contractor trigger's
  // payload shape by mistake) -- no partner_id at all.
  const res = await handleNotifyAdminNewPartner(makeRequest({ contractor_id: "x" }), deps);
  assertEquals(res.status >= 400 && res.status < 500, true);
  assertEquals(fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 0);
});

Deno.test("(d) malformed (non-JSON) payload gives 0 sends and a 4xx", async () => {
  const { deps, fetchCalls } = buildDeps({}, { partner: null });
  const req = new Request("https://x.supabase.co/functions/v1/notify-admin-new-partner", {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: "not json {{{",
  });
  const res = await handleNotifyAdminNewPartner(req, deps);
  assertEquals(res.status >= 400 && res.status < 500, true);
  assertEquals(fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 0);
});

Deno.test("(d) missing Authorization header gives 401", async () => {
  const { deps, fetchCalls } = buildDeps();
  const req = makeRequest({ partner_id: PARTNER.id }, { bearer: null });
  const res = await handleNotifyAdminNewPartner(req, deps);
  assertEquals(res.status, 401);
  assertEquals(fetchCalls.length, 0);
});

Deno.test("(d) invalid Authorization bearer (not the service role key) gives 401", async () => {
  const { deps, fetchCalls } = buildDeps();
  const req = makeRequest({ partner_id: PARTNER.id }, { bearer: "not-the-real-key" });
  const res = await handleNotifyAdminNewPartner(req, deps);
  assertEquals(res.status, 401);
  assertEquals(fetchCalls.length, 0);
});

// ---------------------------------------------------------------------------
// (e) Mailgun failure gives a non-2xx, and nothing is recorded as sent.
//
// NOTE: the work order's spec template says "Resend failure" -- this repo's
// actual, live mail provider for every notify-admin-* function (confirmed by
// reading notify-admin-new-contractor/index.ts and notify-admin-new-homeowner)
// is Mailgun, not Resend; there is no Resend integration anywhere in
// supabase/functions. This assertion targets the real provider instead of
// guessing a Resend integration into existence. Flagged in the task report.
// ---------------------------------------------------------------------------
Deno.test("(e) a Mailgun send failure gives a non-2xx response and records nothing as sent", async () => {
  const { supabase, inserted } = fakeSupabase({});
  const { fetchImpl, calls } = fakeFetch(() => Promise.resolve(new Response("bad request", { status: 400 })));
  const deps: PartnerDeps = {
    serviceRoleKey: SERVICE_ROLE_KEY,
    mailgunKey: "fake-mailgun-key",
    mailgunDomain: MAILGUN_DOMAIN,
    supabase,
    fetchImpl,
  };

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: PARTNER.id }), deps);

  assertEquals(res.status >= 400, true);
  assertEquals(calls.filter((c) => c.url.includes("api.mailgun.net")).length, 1);
  // No notifications row claiming a successful send.
  assertEquals(inserted.filter((i) => i.table === "notifications").length, 0);
});

// ---------------------------------------------------------------------------
// (f) Latency budget: the handler awaits no external call beyond the one
// email send and the idempotency write. Proven with call-order stubs (not
// timing): every Supabase call and the one fetch call are logged in the
// order they occur, and asserted to be exactly: read partner, check
// notifications, send email, write notifications. No other call appears in
// between and no external call happens twice.
// ---------------------------------------------------------------------------
Deno.test("(f) handler makes exactly the expected external calls in order -- no extra hop lengthens the <=60s budget", async () => {
  const order: string[] = [];
  const { supabase, inserted } = fakeSupabase({ onCall: (event) => order.push(event) });

  const { fetchImpl } = fakeFetch(() => {
    order.push("fetch:mailgun");
    return Promise.resolve(new Response(JSON.stringify({ id: "<partner-msg@mail.otterquote.test>" }), { status: 200 }));
  });

  const deps: PartnerDeps = {
    serviceRoleKey: SERVICE_ROLE_KEY,
    mailgunKey: "fake-mailgun-key",
    mailgunDomain: MAILGUN_DOMAIN,
    supabase,
    fetchImpl,
  };

  await handleNotifyAdminNewPartner(makeRequest({ partner_id: PARTNER.id }), deps);

  // Exactly these four external hops, in this order, once each. Anything
  // else (a second Mailgun call, an extra read, a call to a third service)
  // is a latency-budget regression against the <=60s requirement.
  assertEquals(order, [
    "read:referral_agents",
    "read:notifications",
    "fetch:mailgun",
    "insert:notifications",
  ]);
  assertEquals(inserted.length, 1);
});
