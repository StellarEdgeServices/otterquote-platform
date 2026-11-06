// gh-3507 -- create-setup-intent must refuse unless the caller's session belongs to the
// contractor named by `contractor_id` (contractors.user_id = auth user id).
//
// These drive the REAL exported handler with a stubbed Supabase client and a stubbed
// Stripe fetch: no network, no Stripe call, no database.
//
//   no session                  -> 401, Stripe never called
//   another contractor's session -> 403, Stripe never called
//   own session                 -> 200, reaches (stubbed) Stripe, client_secret returned
//   own session + non-test contractor + test key -> the existing is_test guard still 409s
//
// Run: deno test supabase/functions/create-setup-intent/auth.test.ts
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { handler } from "./index.ts";

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-stub",
  SUPABASE_ANON_KEY: "anon-key-stub",
  STRIPE_SECRET_KEY: "sk_test_stub",
};
const getEnv = (n: string) => ENV[n];

const OWNER_USER = "user-owner";
const OTHER_USER = "user-other";
const TOKENS: Record<string, string> = { "owner-jwt": OWNER_USER, "other-jwt": OTHER_USER };

function contractorRow(isTest = true) {
  return {
    id: "contractor-1", stripe_customer_id: "cus_existing", company_name: "Acme Roofing",
    contact_name: "A", email: "a@example.test", user_id: OWNER_USER, is_test: isTest,
  };
}

function makeStubClient(isTest = true) {
  return ((_url: string, key: string, opts?: { global?: { headers?: Record<string, string> } }) => {
    if (key === ENV.SUPABASE_SERVICE_ROLE_KEY) {
      const chain: any = {
        select: () => chain, eq: () => chain, update: () => chain,
        single: () => Promise.resolve({ data: contractorRow(isTest), error: null }),
        then: (res: any) => res({ data: [{ id: "contractor-1" }], error: null }),
      };
      return { from: () => chain };
    }
    // Any other key is a user-scoped client: resolve the bearer token to a user.
    const bearer = (opts?.global?.headers?.Authorization ?? "").replace(/^Bearer /, "");
    return {
      auth: {
        getUser: () => TOKENS[bearer]
          ? Promise.resolve({ data: { user: { id: TOKENS[bearer] } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "invalid JWT" } }),
      },
    };
  }) as any;
}

function stripeSpy() {
  const calls: string[] = [];
  const fetchFn = ((url: string) => {
    calls.push(String(url));
    return Promise.resolve(new Response(
      JSON.stringify({ id: "seti_stub", client_secret: "seti_stub_secret_xyz", status: "requires_payment_method" }),
      { status: 200 },
    ));
  }) as any;
  return { calls, fetchFn };
}

function req(token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://otterquote.com" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("https://stub.supabase.test/functions/v1/create-setup-intent", {
    method: "POST", headers, body: JSON.stringify({ contractor_id: "contractor-1", payment_type: "card" }),
  });
}

Deno.test("no session -> 401 and Stripe is never called", async () => {
  const s = stripeSpy();
  const res = await handler(req(), getEnv, makeStubClient(), s.fetchFn);
  assertEquals(res.status, 401);
  assertEquals(s.calls.length, 0);
  assertEquals((await res.text()).includes("client_secret"), false);
});

Deno.test("invalid/anon token -> 401 and Stripe is never called", async () => {
  const s = stripeSpy();
  const res = await handler(req("anon-key-stub"), getEnv, makeStubClient(), s.fetchFn);
  assertEquals(res.status, 401);
  assertEquals(s.calls.length, 0);
});

Deno.test("another contractor's session -> 403 and Stripe is never called", async () => {
  const s = stripeSpy();
  const res = await handler(req("other-jwt"), getEnv, makeStubClient(), s.fetchFn);
  assertEquals(res.status, 403);
  assertEquals(s.calls.length, 0);
  assertEquals((await res.text()).includes("client_secret"), false);
});

Deno.test("own session -> passes through to (stubbed) Stripe and returns the client_secret", async () => {
  const s = stripeSpy();
  const res = await handler(req("owner-jwt"), getEnv, makeStubClient(), s.fetchFn);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.client_secret, "seti_stub_secret_xyz");
  assertEquals(body.customer_id, "cus_existing");
  assertEquals(s.calls, ["https://api.stripe.com/v1/setup_intents"]);
});

Deno.test("existing is_test guard kept: own session, non-test contractor, test-mode key -> 409, no Stripe", async () => {
  const s = stripeSpy();
  const res = await handler(req("owner-jwt"), getEnv, makeStubClient(false), s.fetchFn);
  assertEquals(res.status, 409);
  assertEquals(s.calls.length, 0);
});
