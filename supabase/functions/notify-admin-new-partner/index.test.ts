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
  isInternalTestDomain,
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
  // Forces the notifications SELECT to return this error unconditionally --
  // simulates a dedupe-query failure regardless of which column it filtered
  // on (must-fix 1, review round 2: fail-closed coverage).
  notificationsError?: { message: string; code?: string } | null;
  // Simulates the REAL prod behavior (measured live, REVIEW FAIL 5832785581)
  // of a `.eq("user_id", null)` dedupe query: supabase-js 2.114 rewrites it
  // to `user_id=eq.null`, which prod REST answers with HTTP 400
  // (22P02 invalid input syntax for type uuid: "null"). Only fires when the
  // notifications query actually filters on user_id === null -- i.e. it
  // reproduces the bug for the UNFIXED code path and stays silent (falls
  // through to the normal existingNotifications behavior) once the fix
  // keys the dedupe on referral_agent_id instead.
  simulateNullUserIdBug?: boolean;
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
  const notificationsError = opts.notificationsError ?? null;
  const simulateNullUserIdBug = opts.simulateNullUserIdBug ?? false;

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
            if (notificationsError) {
              return Promise.resolve({ data: null, error: notificationsError });
            }
            if (simulateNullUserIdBug && "user_id" in filters && filters.user_id === null) {
              return Promise.resolve({
                data: null,
                error: { message: 'invalid input syntax for type uuid: "null"', code: "22P02" },
              });
            }
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

function buildDeps(overrides: Partial<PartnerDeps> = {}, opts: {
  partner?: PartnerRow | null;
  existingNotifications?: number;
  notificationsError?: { message: string; code?: string } | null;
  simulateNullUserIdBug?: boolean;
} = {}): {
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
// (c) UPDATED per Ben's decision (bus 19:58:00Z, DECIDED, gh-2154 P-3 build
// session rw-f35-20260924T155307-pkau): is_test=true partners DO alert
// (Dustin still wants to know about test signups he generates himself),
// tagged with a "[TEST] " subject prefix so it's visually distinct from a
// real lead. Pattern-matched internal bot accounts (isTestAccount():
// otterquote-internal.test / pfw- / authdoctor) that are NOT is_test still
// skip entirely -- those are automated bot traffic, not Dustin's own test
// signups, and is_test does not gate that skip (a bot account marked
// is_test=true still ALERTS, with the [TEST] prefix -- is_test is checked
// first and wins). This supersedes the original (c), which (written before
// P-3 existed) assumed is_test mirrored notify-admin-new-contractor's
// silent-skip test-account behaviour; it does not -- contractors has no
// is_test-vs-bot-pattern distinction to draw from, so P-3 is the first of
// this trigger family to need it spelled out explicitly.
// ---------------------------------------------------------------------------
Deno.test("(c1) is_test=true partner (real-looking email) alerts, with a [TEST] subject prefix", async () => {
  const testPartner: PartnerRow = { ...PARTNER, is_test: true };
  const { deps, fetchCalls, inserted } = buildDeps({}, { partner: testPartner });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: testPartner.id }), deps);
  const json = await res.json();

  assertEquals(res.status, 200);
  assertEquals(json.success, true);
  assertEquals(json.skipped, undefined);

  const mailgunCalls = fetchCalls.filter((c) => c.url.includes("api.mailgun.net"));
  assertEquals(mailgunCalls.length, 1);
  const sentBody = formDataToText(mailgunCalls[0].init?.body);
  assertMatch(sentBody, /subject=\[TEST\] /);
  assertEquals(inserted.filter((i) => i.table === "notifications").length, 1);
});

Deno.test("(c2) bot-pattern email WITHOUT is_test is skipped (no send, no [TEST] alert)", async () => {
  const botPartner: PartnerRow = { ...PARTNER, is_test: false, email: "pfw-test-partner@example.invalid" };
  const { deps, fetchCalls, inserted } = buildDeps({}, { partner: botPartner });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: botPartner.id }), deps);
  const json = await res.json();

  assertEquals(res.status, 200);
  assertEquals(json.success, true);
  assertEquals(json.skipped, true);
  assertEquals(json.reason, "test_account");
  assertEquals(fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 0);
  assertEquals(inserted.length, 0);
});

Deno.test("(c3) bot-pattern email WITH is_test=true alerts, with a [TEST] subject prefix (is_test wins over the bot-pattern skip)", async () => {
  const botTestPartner: PartnerRow = { ...PARTNER, is_test: true, email: "pfw-test-partner@example.invalid" };
  const { deps, fetchCalls, inserted } = buildDeps({}, { partner: botTestPartner });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: botTestPartner.id }), deps);
  const json = await res.json();

  assertEquals(res.status, 200);
  assertEquals(json.success, true);
  assertEquals(json.skipped, undefined);

  const mailgunCalls = fetchCalls.filter((c) => c.url.includes("api.mailgun.net"));
  assertEquals(mailgunCalls.length, 1);
  const sentBody = formDataToText(mailgunCalls[0].init?.body);
  assertMatch(sentBody, /subject=\[TEST\] /);
  assertEquals(inserted.filter((i) => i.table === "notifications").length, 1);
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

// ---------------------------------------------------------------------------
// (g)/(h)/(i) HTML-escaping of partner-supplied fields, per PR #2162 review
// comment 5822537570: an explicit ?funnel_id= accepts any string up to 64
// chars (e.g. `<img src=x onerror=alert(1)>`) and lands verbatim in
// referral_agents.funnel_id. Every partner-supplied field interpolated into
// the HTML body must be escaped; the subject header must never carry raw
// CR/LF (header injection). The plain-text body is exempt from escaping.
// ---------------------------------------------------------------------------
Deno.test("(g) HTML body escapes an attacker-supplied funnel_id and name, no raw markup reaches the HTML", async () => {
  const evilPartner: PartnerRow = {
    ...PARTNER,
    first_name: "<b>X</b>",
    last_name: null,
    funnel_id: "<img src=x onerror=alert(1)>",
  };
  const { deps, fetchCalls } = buildDeps({}, { partner: evilPartner });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: evilPartner.id }), deps);
  assertEquals(res.status, 200);

  const mailgunCalls = fetchCalls.filter((c) => c.url.includes("api.mailgun.net"));
  assertEquals(mailgunCalls.length, 1);
  const body = mailgunCalls[0].init?.body as FormData;
  const html = body.get("html") as string;

  assertMatch(html, /&lt;img/);
  assertEquals(html.includes("<img src=x onerror=alert(1)>"), false);
  assertMatch(html, /&lt;b&gt;X&lt;\/b&gt;/);
  assertEquals(html.includes("<b>X</b>"), false);
});

Deno.test("(h) HTML body escapes attacker-supplied agent_type, email and company", async () => {
  const evilPartner: PartnerRow = {
    ...PARTNER,
    agent_type: '"><script>alert(1)</script>',
    email: "a\"b@example.invalid",
    company: "Acme & <Sons> \"Co\"",
  };
  const { deps, fetchCalls } = buildDeps({}, { partner: evilPartner });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: evilPartner.id }), deps);
  assertEquals(res.status, 200);

  const mailgunCalls = fetchCalls.filter((c) => c.url.includes("api.mailgun.net"));
  const body = mailgunCalls[0].init?.body as FormData;
  const html = body.get("html") as string;

  assertEquals(html.includes("<script>alert(1)</script>"), false);
  assertMatch(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assertMatch(html, /Acme &amp; &lt;Sons&gt; &quot;Co&quot;/);
  assertEquals(html.includes('a"b@example.invalid'), false);
});

Deno.test("(h2) HTML body escapes a single-quote/apostrophe in company (attribute-breakout)", async () => {
  const evilPartner: PartnerRow = {
    ...PARTNER,
    company: "Roofing' onmouseover='alert(1)",
  };
  const { deps, fetchCalls } = buildDeps({}, { partner: evilPartner });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: evilPartner.id }), deps);
  assertEquals(res.status, 200);

  const mailgunCalls = fetchCalls.filter((c) => c.url.includes("api.mailgun.net"));
  const body = mailgunCalls[0].init?.body as FormData;
  const html = body.get("html") as string;

  assertEquals(html.includes("Roofing' onmouseover='alert(1)"), false);
  assertMatch(html, /Roofing&#39;/);
});

Deno.test("(i) subject header strips CR/LF from a partner-supplied name (header injection)", async () => {
  const evilPartner: PartnerRow = {
    ...PARTNER,
    first_name: "Jamie\r\nBcc: evil@example.com",
    last_name: "Partner\nX-Injected: true",
  };
  const { deps, fetchCalls } = buildDeps({}, { partner: evilPartner });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: evilPartner.id }), deps);
  assertEquals(res.status, 200);

  const mailgunCalls = fetchCalls.filter((c) => c.url.includes("api.mailgun.net"));
  const body = mailgunCalls[0].init?.body as FormData;
  const subject = body.get("subject") as string;

  assertEquals(subject.includes("\r"), false);
  assertEquals(subject.includes("\n"), false);
});

// ---------------------------------------------------------------------------
// (j)/(k)/(l) gh-2154 P-3 review round 2 (REVIEW FAIL 5832785581, must-fix 1):
// dedupe must be keyed on the partner's own id, not user_id (NULL at signup
// time for every referral_agents row), and must fail CLOSED (no send) on a
// dedupe-query error instead of silently sending. These fail on the base
// (edadb7de), which keyed the dedupe on user_id and ignored query errors.
// ---------------------------------------------------------------------------
Deno.test("(j) partner with NULL user_id (real signup shape) and a prior alert for THIS partner id sends zero more emails", async () => {
  // register_partner never sets user_id -- claim_partner_account links it
  // later. This is the actual live shape of a referral_agents row at the
  // moment the AFTER INSERT trigger fires.
  const freshPartner: PartnerRow = { ...PARTNER, user_id: null };
  const { deps, fetchCalls, inserted } = buildDeps({}, {
    partner: freshPartner,
    simulateNullUserIdBug: true,
    existingNotifications: 1, // an admin_new_partner_alert row already exists, keyed on referral_agent_id
  });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: freshPartner.id }), deps);
  const json = await res.json();

  assertEquals(res.status, 200);
  assertEquals(json.skipped, true);
  assertEquals(json.reason, "already_notified");
  assertEquals(fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 0);
  assertEquals(inserted.length, 0);
});

Deno.test("(k) a dedupe-query error fails CLOSED: zero sends, non-2xx, nothing recorded", async () => {
  const { deps, fetchCalls, inserted } = buildDeps({}, {
    notificationsError: { message: "connection reset", code: "08006" },
  });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: PARTNER.id }), deps);

  assertEquals(res.status >= 400, true);
  assertEquals(fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 0);
  assertEquals(inserted.length, 0);
});

Deno.test("(l) the dedupe query filters notifications by the partner's own id (referral_agent_id), not user_id", async () => {
  const { deps, selects } = buildDeps();

  await handleNotifyAdminNewPartner(makeRequest({ partner_id: PARTNER.id }), deps);

  const notifSelect = selects.find((s) => s.table === "notifications");
  assertEquals(notifSelect !== undefined, true);
  assertEquals(notifSelect!.filters.referral_agent_id, PARTNER.id);
  assertEquals("user_id" in notifSelect!.filters, false);
});

// ---------------------------------------------------------------------------
// (m) Ben, DECIDED (review round 2, should-fix 1): an @otterquote-internal.test
// address -- the repo's pfw-/authdoctor walk-bot domain -- skips the alert
// unconditionally, even when is_test=true. This corrects (c1)/(c3)'s prior
// "is_test always wins" behavior, which paged Dustin on every walk run
// because P-1 sets is_test=true for that whole domain. A human test signup
// (is_test=true, any OTHER domain -- Dustin testing the funnel himself)
// still alerts with the [TEST] prefix; see (c1) above for that branch.
// ---------------------------------------------------------------------------
Deno.test("(m) @otterquote-internal.test address skips entirely even when is_test=true (walk bots never page Dustin)", async () => {
  const walkBot: PartnerRow = {
    ...PARTNER,
    is_test: true,
    email: "pfw-p1@otterquote-internal.test",
  };
  const { deps, fetchCalls, inserted } = buildDeps({}, { partner: walkBot });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: walkBot.id }), deps);
  const json = await res.json();

  assertEquals(res.status, 200);
  assertEquals(json.skipped, true);
  assertEquals(json.reason, "internal_test_domain");
  assertEquals(fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 0);
  assertEquals(inserted.length, 0);
});

Deno.test("(m2) @otterquote-internal.test address skips even when NOT marked is_test", async () => {
  const walkBot: PartnerRow = {
    ...PARTNER,
    is_test: false,
    email: "authdoctor-m1@otterquote-internal.test",
  };
  const { deps, fetchCalls } = buildDeps({}, { partner: walkBot });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: walkBot.id }), deps);
  const json = await res.json();

  assertEquals(json.skipped, true);
  assertEquals(json.reason, "internal_test_domain");
  assertEquals(fetchCalls.filter((c) => c.url.includes("api.mailgun.net")).length, 0);
});

Deno.test("isInternalTestDomain matches only the @otterquote-internal.test domain", () => {
  assertEquals(isInternalTestDomain("pfw-p1@otterquote-internal.test"), true);
  assertEquals(isInternalTestDomain("authdoctor-run@otterquote-internal.test"), true);
  assertEquals(isInternalTestDomain("real.partner@example.invalid"), false);
  // pfw-/authdoctor patterns on a DIFFERENT domain are not the internal-test
  // domain -- they're still caught by isTestAccount()'s broader pattern
  // match, just via the separate (non-domain-scoped) bot-pattern skip.
  assertEquals(isInternalTestDomain("pfw-jamie@example.invalid"), false);
});

// ---------------------------------------------------------------------------
// (n) should-fix 3 (PII in logs): a skip decision must log the partner id,
// never the partner's raw email address.
// ---------------------------------------------------------------------------
Deno.test("(n) a bot-pattern skip logs the partner id, never the partner's raw email", async () => {
  const botPartner: PartnerRow = { ...PARTNER, is_test: false, email: "pfw-test-partner@example.invalid" };
  const { deps } = buildDeps({}, { partner: botPartner });

  const logs: string[] = [];
  // deno-lint-ignore no-explicit-any
  const origLog = console.log;
  // deno-lint-ignore no-explicit-any
  console.log = (...args: any[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await handleNotifyAdminNewPartner(makeRequest({ partner_id: botPartner.id }), deps);
  } finally {
    console.log = origLog;
  }

  const joined = logs.join("\n");
  assertEquals(joined.includes(botPartner.email), false);
  assertMatch(joined, new RegExp(botPartner.id));
});

// ---------------------------------------------------------------------------
// (o) should-fix 4: header-injection stripping must also cover U+2028 (LINE
// SEPARATOR), U+2029 (PARAGRAPH SEPARATOR), U+0085 (NEL) and other C0
// control characters, not just CR/LF.
// ---------------------------------------------------------------------------
Deno.test("(o) subject header strips U+2028/U+2029/U+0085 and other control chars from a partner-supplied name", async () => {
  const evilPartner: PartnerRow = {
    ...PARTNER,
    first_name: "Jamie Bcc: evil@example.com",
    last_name: "Partner\u0085X-Injected:\u000btrue",
  };
  const { deps, fetchCalls } = buildDeps({}, { partner: evilPartner });

  const res = await handleNotifyAdminNewPartner(makeRequest({ partner_id: evilPartner.id }), deps);
  assertEquals(res.status, 200);

  const mailgunCalls = fetchCalls.filter((c) => c.url.includes("api.mailgun.net"));
  const body = mailgunCalls[0].init?.body as FormData;
  const subject = body.get("subject") as string;

  assertEquals(subject.includes(" "), false);
  assertEquals(subject.includes(" "), false);
  assertEquals(subject.includes("\u0085"), false);
  assertEquals(subject.includes("\u000b"), false);
});
