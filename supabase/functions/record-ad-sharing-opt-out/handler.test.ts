// gh-2107 / D-330 half 2 -- the support-email opt-out path. Dustin's ruling "b." (#2078 comment 5801822166), scope item 4:
// "The manual support-email opt-out path sets the same flag, so admins have a way to record it." An admin-only function.
// Ben's ruling c. (#2078 5805593465): an opt-out from a person WITHOUT an account goes on a hashed-email suppression list, so
// this function records the SHA-256 of every address it is given (first, and always), then flags any profiles.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type Deps, escapeLikePattern, handleRequest, normalizeEmail } from "./handler.ts";

const ADMIN = { id: "aaaaaaaa-0000-4000-8000-000000000001", email: "dustinstohler1@gmail.com" };
const USER = { id: "bbbbbbbb-0000-4000-8000-000000000002", email: "someone@example.com" };
const AT = new Date("2026-09-24T02:00:00.000Z");

type Flag = { matched: number; updated: number } | { errorCode: string | null };
interface Calls { order: string[]; suppressed: string[]; flagged: { email: string; at: string }[]; logs: string[]; adminChecks: string[]; hashed: string[] }
function deps(over: Partial<Deps> = {}, opts: { flag?: Flag; suppressFail?: { errorCode: string | null } | null } = {}): { d: Deps; calls: Calls } {
  const calls: Calls = { order: [], suppressed: [], flagged: [], logs: [], adminChecks: [], hashed: [] };
  const d: Deps = {
    authenticate: (token) => Promise.resolve(token === "admin-token" ? ADMIN : token === "user-token" ? USER : null),
    isAdmin: (id, email) => { calls.adminChecks.push(id); return Promise.resolve(email === ADMIN.email); },
    hashEmail: (email) => { calls.hashed.push(email); return Promise.resolve("HASH(" + email + ")"); },
    suppress: (h) => { calls.order.push("suppress"); calls.suppressed.push(h); return Promise.resolve(opts.suppressFail ?? null); },
    flagProfiles: (email, at) => { calls.order.push("flag"); calls.flagged.push({ email, at }); return Promise.resolve(opts.flag ?? { matched: 1, updated: 1 }); },
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
Deno.test("no Authorization header -> 401, nothing recorded anywhere", async () => {
  const { d, calls } = deps();
  const res = await handleRequest(req({ email: "a@b.co" }, { token: null }), d);
  assertEquals(res.status, 401);
  assertEquals(calls.order.length, 0);
});

Deno.test("an invalid token -> 401, nothing recorded, no admin lookup", async () => {
  const { d, calls } = deps();
  const res = await handleRequest(req({ email: "a@b.co" }, { token: "garbage" }), d);
  assertEquals(res.status, 401);
  assertEquals(calls.order.length, 0);
  assertEquals(calls.adminChecks.length, 0);
});

Deno.test("a signed-in NON-admin -> 403, nothing recorded (no suppression row, no flag)", async () => {
  const { d, calls } = deps();
  const res = await handleRequest(req({ email: "a@b.co" }, { token: "user-token" }), d);
  assertEquals(res.status, 403);
  assertEquals(calls.order.length, 0);
  assertEquals(calls.hashed.length, 0);
});

Deno.test("the admin check is made with the AUTHENTICATED user, never with anything from the request body", async () => {
  const { d, calls } = deps();
  await handleRequest(req({ email: "a@b.co", admin: true, user_id: USER.id, is_admin: true }), d);
  assertEquals(calls.adminChecks, [ADMIN.id]);
  const { d: d2, calls: c2 } = deps();
  const res = await handleRequest(req({ email: "a@b.co", admin: true, is_admin: true }, { token: "user-token" }), d2);
  assertEquals(res.status, 403);
  assertEquals(c2.order.length, 0);
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
    assertEquals(calls.order.length, 0);
  }
});

// -- the suppression list (ruling c.) -------------------------------------------------
Deno.test("an admin request writes the suppression row FIRST (for the digest of the NORMALISED address), then flags profiles with the injected time", async () => {
  const { d, calls } = deps({}, { flag: { matched: 2, updated: 1 } });
  const res = await handleRequest(req({ email: "  Jane@Example.com " }), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, suppressed: true, matched: 2, updated: 1 });
  assertEquals(calls.order, ["suppress", "flag"]);
  assertEquals(calls.hashed, ["jane@example.com"], "the digest is computed from the normalised address");
  assertEquals(calls.suppressed, ["HASH(jane@example.com)"]);
  assertEquals(calls.flagged, [{ email: "jane@example.com", at: "2026-09-24T02:00:00.000Z" }]);
});

Deno.test("NO account has that email: the opt-out is STILL recorded (on the suppression list), and the admin is told so", async () => {
  const { d, calls } = deps({}, { flag: { matched: 0, updated: 0 } });
  const res = await handleRequest(req({ email: "nobody@example.com" }), d);
  assertEquals(res.status, 200);
  const j = await res.json();
  assertEquals(j.ok, true);
  assertEquals(j.suppressed, true, "the gap: a person with no account is now stored");
  assertEquals(j.matched, 0);
  assert(typeof j.note === "string" && j.note.includes("suppression list") && !j.note.includes("nobody@example.com"), "fixed note, no address");
  assertEquals(calls.suppressed.length, 1);
});

Deno.test("a suppression failure -> 500 with a FIXED message, profiles are NOT touched, and neither the address, its digest nor database text leaks", async () => {
  const { d, calls } = deps({}, { suppressFail: { errorCode: "23514" } });
  const res = await handleRequest(req({ email: "secret.person@example.com" }), d);
  assertEquals(res.status, 500);
  assertEquals(calls.order, ["suppress"], "no profile flag is set when the universal record could not be written");
  const text = JSON.stringify(await res.json()) + " | " + calls.logs.join(" | ");
  assert(!text.includes("secret.person") && !text.includes("example.com") && !text.includes("HASH("), "no address or digest in the response or log");
  assert(calls.logs.join(" | ").includes("(code 23514)"), "the safe code is logged");
  const { d: d2, calls: c2 } = deps({ suppress: () => Promise.reject(new Error('duplicate key "x" Key (email_sha256)=(HASH(secret.person@example.com))')) });
  const res2 = await handleRequest(req({ email: "secret.person@example.com" }), d2);
  assertEquals(res2.status, 500);
  assert(!(JSON.stringify(await res2.json()) + c2.logs.join(" | ")).includes("secret.person"), "a thrown error's text is never forwarded");
});

Deno.test("a profile-flag failure -> 500 with a FIXED message (a retry is safe: every write is idempotent) and nothing leaks", async () => {
  const { d, calls } = deps({}, { flag: { errorCode: "42703" } });
  const res = await handleRequest(req({ email: "secret.person@example.com" }), d);
  assertEquals(res.status, 500);
  assertEquals(calls.order, ["suppress", "flag"], "the suppression row was already written");
  const text = JSON.stringify(await res.json()) + " | " + calls.logs.join(" | ");
  assert(!text.includes("secret.person") && !text.includes("HASH("), text);
  assert(calls.logs.join(" | ").includes("(code 42703)"));
  const { d: d2, calls: c2 } = deps({ flagProfiles: () => Promise.reject(new Error("boom with secret.person@example.com")) });
  const res2 = await handleRequest(req({ email: "secret.person@example.com" }), d2);
  assertEquals(res2.status, 500);
  assert(!(JSON.stringify(await res2.json()) + c2.logs.join(" | ")).includes("secret.person"));
});

Deno.test("a store error code that is not a short alphanumeric token is dropped (a message cannot ride in the code), on both writes", async () => {
  for (const [o, opts] of [[{}, { suppressFail: { errorCode: "bad code with spaces and secret.person@example.com" } }], [{}, { flag: { errorCode: "bad code with spaces and secret.person@example.com" } }]] as const) {
    const { d, calls } = deps(o, opts);
    const res = await handleRequest(req({ email: "secret.person@example.com" }), d);
    assertEquals(res.status, 500);
    const logText = calls.logs.join(" | ");
    assert(!logText.includes("secret.person") && !logText.includes("bad code"), logText);
  }
});

Deno.test("the success log line carries the counts only, never the address or its digest", async () => {
  const { d, calls } = deps({}, { flag: { matched: 1, updated: 1 } });
  await handleRequest(req({ email: "private.person@example.com" }), d);
  const logText = calls.logs.join(" | ");
  assert(!logText.includes("private.person") && !logText.includes("HASH("), logText);
});

// REVIEW N1 on #2138: the audit trail says WHO acted. The acting admin's user id (never their address) is in the success log line.
Deno.test("the success log line names the acting admin by user id, not by email address", async () => {
  const { d, calls } = deps({}, { flag: { matched: 2, updated: 1 } });
  await handleRequest(req({ email: "private.person@example.com" }), d);
  const logText = calls.logs.join(" | ");
  assert(logText.includes(`admin ${ADMIN.id}`), "the acting admin's id is logged: " + logText);
  assert(!logText.includes(ADMIN.email) && !logText.includes("@"), "no email address of the admin or the subject: " + logText);
  assert(logText.includes("matched 2") && logText.includes("updated 1"), "counts still logged");
});

Deno.test("a rejected call (403) does not log a success line", async () => {
  const { d, calls } = deps();
  await handleRequest(req({ email: "a@b.co" }, { token: "user-token" }), d);
  assert(!calls.logs.join(" | ").includes("opt-out recorded"));
});

Deno.test("unknown origin still gets a response with the default allowed origin, never an echo", async () => {
  const { d } = deps();
  const res = await handleRequest(req({ email: "a@b.co" }, { origin: "https://evil.example" }), d);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://otterquote.com");
});

// -- structure -------------------------------------------------------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("index.ts: the suppression row is an idempotent upsert (never overwritten), source support_email, and the table is never updated or deleted from", () => {
  assert(index.includes('.from("ad_sharing_suppressions")'));
  assert(index.includes(".upsert("));
  assert(index.includes("ignoreDuplicates: true"));
  const supp = index.slice(index.indexOf('.from("ad_sharing_suppressions")'), index.indexOf("flagProfiles:"));
  assert(supp.includes('source: "support_email"'), "the suppression row's own source is support_email");
  assert(!/\.(update|delete)\(/.test(supp), "the suppression list is only ever inserted into");
});

Deno.test("index.ts: hashes with the inlined email-hash.ts (the CAPI send's digest), not a second implementation", () => {
  assert(index.includes('from "./email-hash.ts"'));
  assert(index.includes("hashEmail: (email) => hashEmailSha256(email)"));
  assert(!index.includes("crypto.subtle"), "no second hash implementation in index.ts");
});

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
