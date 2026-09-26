// deno test --allow-read=. supabase/functions/issue-lead-access-token/handler.test.ts
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { getClientIp, handleRequest, validateBody } from "./handler.ts";

const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://x/functions/v1/issue-lead-access-token", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function allowRpc(tokenRow: { token: string | null; expires_at: string | null } | null = {
  token: "tok_abc",
  expires_at: "2099-01-01T00:00:00Z",
}) {
  return (name: string, _args: Record<string, unknown>) => {
    if (name === "check_rate_limit") return Promise.resolve({ data: { allowed: true }, error: null });
    if (name === "issue_lead_access_token") {
      return Promise.resolve({ data: tokenRow ? [tokenRow] : [], error: null });
    }
    return Promise.resolve({ data: null, error: { message: "unexpected rpc " + name } });
  };
}

Deno.test("validateBody rejects a non-UUID lead_id", () => {
  const v = validateBody({ lead_id: "not-a-uuid" });
  assertEquals(v.ok, false);
});

Deno.test("validateBody accepts a UUID lead_id", () => {
  const v = validateBody({ lead_id: LEAD_ID });
  assertEquals(v.ok, true);
});

Deno.test("happy path: mints and returns a token", async () => {
  const res = await handleRequest(req({ lead_id: LEAD_ID }), { rpc: allowRpc() });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.token, "tok_abc");
});

Deno.test("negative control: an out-of-scope / unknown lead id mints nothing", async () => {
  const res = await handleRequest(req({ lead_id: LEAD_ID }), { rpc: allowRpc(null) });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(body.reason, "lead_out_of_scope");
});

Deno.test("negative control: rate limit exceeded refuses with 429 and never calls the mint rpc", async () => {
  let mintCalled = false;
  const rpc = (name: string) => {
    if (name === "check_rate_limit") return Promise.resolve({ data: { allowed: false, reason: "too_many" }, error: null });
    if (name === "issue_lead_access_token") {
      mintCalled = true;
      return Promise.resolve({ data: [], error: null });
    }
    return Promise.resolve({ data: null, error: { message: "unexpected" } });
  };
  const res = await handleRequest(req({ lead_id: LEAD_ID }), { rpc });
  assertEquals(res.status, 429);
  assertEquals(mintCalled, false);
});

Deno.test("negative control: malformed body (missing lead_id) is refused with 400, never calls the mint rpc", async () => {
  let mintCalled = false;
  const rpc = (name: string) => {
    if (name === "check_rate_limit") return Promise.resolve({ data: { allowed: true }, error: null });
    mintCalled = true;
    return Promise.resolve({ data: [], error: null });
  };
  const res = await handleRequest(req({}), { rpc });
  assertEquals(res.status, 400);
  assertEquals(mintCalled, false);
});

Deno.test("negative control: GET is rejected with 405", async () => {
  const res = await handleRequest(new Request("https://x/functions/v1/issue-lead-access-token", { method: "GET" }), {
    rpc: allowRpc(),
  });
  assertEquals(res.status, 405);
});

Deno.test("getClientIp prefers cf-connecting-ip over x-forwarded-for", () => {
  const r = req({}, { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9, 8.8.8.8" });
  assertEquals(getClientIp(r), "1.2.3.4");
});
