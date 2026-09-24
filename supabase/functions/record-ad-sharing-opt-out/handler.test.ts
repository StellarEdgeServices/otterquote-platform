// gh-2107 / D-330 half 2 -- the support-email opt-out path. Dustin's ruling "b." (#2078 comment 5801822166), scope item 4:
// "The manual support-email opt-out path sets the same flag, so admins have a way to record it." An admin-only function.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type Deps, escapeLikePattern, handleRequest, normalizeEmail } from "./handler.ts";

const ADMIN = { id: "aaaaaaaa-0000-4000-8000-000000000001", email: "dustinstohler1@gmail.com" };
const USER = { id: "bbbbbbbb-0000-4000-8000-000000000002", email: "someone@example.com" };
const AT = new Date("2026-09-24T02:00:00.000Z");

interface Calls { recorded: { email: string; at: string }[]; logs: string[]; adminChecks: string[] }
function deps(over: Partial<Deps> = {}, result: { matched: number; updated: number } | { errorCode: string | null } = { matched: 1, updated: 1 }): { d: Deps; calls: Calls } {
  const calls: Calls = { recorded: [], logs: [], adminChecks: [] };
  const d: Deps = {
    authenticate: (token) => Promise.resolve(token === "admin-token" ? ADMIN : token === "user-token" ? USER : null),
    isAdmin: (id, email) => { calls.adminChecks.push(id); return Promise.resolve(email === ADMIN.email); },
    recordByEmail: (email, at) => { calls.recorded.push({ email, at }); return Promise.resolve(result); },
    now: () => AT,
    log: (m) => calls.logs.push(m),
    ...over,
  };
  return { d, calls };
}
function req(body: unknown, opts: { method?: string; token?: string | null; origin?: string } = {}): Request {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = { "content-type": "application/json", origin: opts.origin ?? "https://app.otterquote.com" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? "admin-token"}`;
  return new Request("https://x.supabase.co/functions/v1/record-ad-sharing-opt-out", { method, headers, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
}

// -- helpers ---------------------------------------------------------------------
Deno.test("normalizeEmail: trims, lower-cases, and rejects anything that is not a plausible single address", () => {
  assertEquals(normalizeEmail("  Jane.Doe+x@Example.COM "), "jane.doe+x@example.com");
  for (const bad of ["", "   ", "nope", "a@b", "a b@example.com", "a@@example.com", "x".repeat(320) + "@e.co", 5, null, undefined, {}, ["a@b.co"]]) {
    assertEquals(normalizeEmail(bad as unknown), null, JSON.stringify(bad));
  }
});

Deno.test("escapeLikePattern: % _ and the escape character are escaped, so an address cannot act as a wildcard", () => {
  assertEquals(escapeLikePattern("a_b%c\\d@e.co"), "a\\_b\\%c\\\\d@e.co");
  assertEquals(escapeLikePattern("plain@e.co"), "plain@e.co");
});

// -- auth: admin only --------------------------------------------------------------
Deno.test("no Authorization header -> 401, nothing recorded", async () => {
  const { d, calls } = deps();
  const res = await handleRequest(req({ email: "a@b.co" }, { token: null }), d);
  assertEquals(res.status, 401);
  assertEquals(calls.recorded.length, 0);
});

Deno.test("an invalid token -> 401, nothing recorded, no admin lookup", async () => {
  const { d, calls } = deps();
  const res = await handleRequest(req({ email: "a@b.co" }, { token: "garbage" }), d);
  assertEquals(res.status, 401);
  assertEquals(calls.recorded.length, 0);
  assertEquals(calls.adminChecks.length, 0);
});

Deno.test("a signed-in NON-admin -> 403, nothing recorded", async () => {
  const { d, calls } = deps();
  const res = await handleRequest(req({ email: "a@b.co" }, { token: "user-token" }), d);
  assertEquals(res.status, 403);
  assertEquals(calls.recorded.length, 0);
});

Deno.test("the admin check is made with the AUTHENTICATED user, never with anything from the request body", async () => {
  const { d, calls } = deps();
  await handleRequest(req({ email: "a@b.co", admin: true, user_id: USER.id, is_admin: true }), d);
  assertEquals(calls.adminChecks, [ADMIN.id]);
  const { d: d2, calls: c2 } = deps();
  const res = await handleRequest(req({ email: "a@b.co", admin: true, is_admin: true }, { token: "user-token" }), d2);
  assertEquals(res.status, 403);
  assertEquals(c2.recorded.length, 0);
});

// -- request handling ----------------------------------------------------------------
Deno.test("OPTIONS answers CORS; other methods -> 405", async () => {
  const { d } = deps();
  const opt = await handleRequest(req(undefined, { method: "OPTIONS" }), d);
  assert(opt.status === 200 || opt.status === 204);
  assertEquals((await handleRequest(req(undefined, { method: "GET" }), d)).status, 405);
});

Deno.test("a missing, malformed or non-string email -> 400, nothing recorded", async () => {
  for (const body of [{}, { email: "" }, { email: "not-an-email" }, { email: 42 }, "not json", { email: ["a@b.co"] }]) {
    const { d, calls } = deps();
    const res = await handleRequest(req(body), d);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(calls.recorded.length, 0);
  }
});

Deno.test("an admin request records the flag for the NORMALISED address, with the injected time, and reports how many rows matched and changed", async () => {
  const { d, calls } = deps({}, { matched: 2, updated: 1 });
  const res = await handleRequest(req({ email: "  Jane@Example.com " }), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, matched: 2, updated: 1 });
  assertEquals(calls.recorded, [{ email: "jane@example.com", at: "2026-09-24T02:00:00.000Z" }]);
});

Deno.test("no account has that email -> 200 with matched 0 and a fixed note (the admin must know nothing was stored)", async () => {
  const { d } = deps({}, { matched: 0, updated: 0 });
  const res = await handleRequest(req({ email: "nobody@example.com" }), d);
  assertEquals(res.status, 200);
  const j = await res.json();
  assertEquals(j.ok, true);
  assertEquals(j.matched, 0);
  assertEquals(j.updated, 0);
  assert(typeof j.note === "string" && j.note.length > 0 && !j.note.includes("nobody@example.com"), "the note is fixed text and does not echo the address");
});

Deno.test("a store failure -> 500 with a FIXED message; the address and any database text never appear in the response or the log", async () => {
  const { d, calls } = deps({}, { errorCode: "23514" });
  const res = await handleRequest(req({ email: "secret.person@example.com" }), d);
  assertEquals(res.status, 500);
  const text = JSON.stringify(await res.json()) + calls.logs.join("\n");
  assert(!text.includes("secret.person") && !text.includes("example.com"), "no address in the response or log");
  assert(calls.logs.join("\n").includes("(code 23514)"), "the safe code is logged");
  const { d: d2, calls: c2 } = deps({ recordByEmail: () => Promise.reject(new Error('duplicate key "x" Key (email)=(secret.person@example.com)')) });
  const res2 = await handleRequest(req({ email: "secret.person@example.com" }), d2);
  assertEquals(res2.status, 500);
  assert(!(JSON.stringify(await res2.json()) + c2.logs.join("\n")).includes("secret.person"), "a thrown error's text is never forwarded");
});

Deno.test("a store error code that is not a short alphanumeric token is dropped (a message cannot ride in the code)", async () => {
  const { d, calls } = deps({}, { errorCode: "bad code with spaces and secret.person@example.com" });
  const res = await handleRequest(req({ email: "secret.person@example.com" }), d);
  assertEquals(res.status, 500);
  const logText = calls.logs.join(" | ");
  assert(!logText.includes("secret.person") && !logText.includes("bad code"), logText);
});

Deno.test("the success log line carries the counts only, never the address", async () => {
  const { d, calls } = deps({}, { matched: 1, updated: 1 });
  await handleRequest(req({ email: "private.person@example.com" }), d);
  assert(!calls.logs.join("\n").includes("private.person"));
});

Deno.test("unknown origin still gets a response with the default allowed origin, never an echo", async () => {
  const { d } = deps();
  const res = await handleRequest(req({ email: "a@b.co" }, { origin: "https://evil.example" }), d);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://otterquote.com");
});

// -- structure -------------------------------------------------------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("index.ts: sets the flag TRUE with source support_email, only where it is not already true, and never writes false or null", () => {
  assert(/ad_sharing_opt_out:\s*true/.test(index));
  assert(index.includes('ad_sharing_opt_out_source: "support_email"'));
  assert(index.includes(".or(\"ad_sharing_opt_out.is.null,ad_sharing_opt_out.eq.false\")"));
  assert(!/ad_sharing_opt_out:\s*(false|null)/.test(index));
});

Deno.test("index.ts: the address is escaped before the case-insensitive match", () => {
  assert(index.includes("escapeLikePattern("));
  assert(index.includes(".ilike("));
});
