// Deno unit tests for mint-test-session's caller gate (gh-2305).
// Run: deno test supabase/functions/mint-test-session/caller-auth.test.ts
//
// authorizeCaller is exercised with an injected resolveUserEmail (no live
// Supabase client, no listener). The "exec caller + is_test / non-test
// target" cases chain authorizeCaller into resolveAndMint with a fake
// DbAdapter, mirroring index.ts's wiring.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  authorizeCaller,
  constantTimeEqual,
  EXEC_MINT_SECRET_MIN_LENGTH,
  EXEC_MISMATCH_LOG,
} from "./caller-auth.ts";
import { type ActivityLogRow, type DbAdapter, resolveAndMint } from "./gate.ts";

const ADMIN = "dustinstohler1@gmail.com";
const SECRET = "s".repeat(48); // >= 32 chars; obviously synthetic test value
const ANON_JWT = "anon-key-jwt-placeholder";

// The anon key is a JWT with no user, so getUser resolves to nothing.
const anonResolver = async (_t: string) => null;
const adminResolver = async (_t: string) => ADMIN;

function args(over: Partial<Parameters<typeof authorizeCaller>[0]> = {}) {
  return {
    token: ANON_JWT,
    execHeader: SECRET as string | null,
    execSecret: SECRET as string | undefined,
    primaryAdminEmail: ADMIN,
    resolveUserEmail: anonResolver,
    ...over,
  };
}

function fakeDb(over: Partial<DbAdapter> = {}, logs: ActivityLogRow[] = []): DbAdapter {
  return {
    getContractorById: async () => ({ data: null, error: null }),
    getClaimsByUserId: async () => ({ data: null, error: null }),
    getProfileById: async () => ({ data: { id: "stub", is_test: true }, error: null }),
    getAuthUserById: async () => ({
      data: { id: "stub", email: "resolved@otterquote-internal.test" },
      error: null,
    }),
    generateMagicLink: async () => ({
      data: { action_link: "https://stub.supabase.co/auth/v1/verify?token=stub" },
      error: null,
    }),
    insertActivityLog: async (row) => {
      logs.push(row);
      return { error: null };
    },
    ...over,
  };
}

const testContractor = (is_test: boolean) => ({
  getContractorById: async () => ({
    data: { id: "c1", user_id: "u1", email: "x@example.com", is_test },
    error: null,
  }),
});

/** Mirrors index.ts: gate, then 403 {error:"Unauthorized"} or resolveAndMint. */
async function handle(a: ReturnType<typeof args>, db: DbAdapter) {
  const d = await authorizeCaller(a);
  if (!d.ok) return { status: 403, body: { error: "Unauthorized" } as Record<string, unknown> };
  return resolveAndMint({ contractor_id: "c1" }, db, d.actor, d.caller);
}

// -- exec path: happy + target gate --

Deno.test("exec caller + is_test target -> 200, activity_log metadata.caller = exec_service", async () => {
  const logs: ActivityLogRow[] = [];
  const r = await handle(args(), fakeDb(testContractor(true), logs));
  assertEquals(r.status, 200);
  assertEquals(r.body.is_test, true);
  assertEquals(logs.length, 1);
  assertEquals(logs[0].event_type, "test_session_minted");
  assertEquals(logs[0].metadata.caller, "exec_service");
});

Deno.test("exec caller + non-test target -> 403 (is_test gate still holds)", async () => {
  const logs: ActivityLogRow[] = [];
  const r = await handle(args(), fakeDb(testContractor(false), logs));
  assertEquals(r.status, 403);
  assertStringIncludes(String(r.body.error), "not marked is_test");
  assertEquals(logs.length, 0);
});

// -- exec path: fail-closed --

Deno.test("EXEC_MINT_SECRET unset -> fail closed even when a header is sent", async () => {
  const d = await authorizeCaller(args({ execSecret: undefined }));
  assertEquals(d.ok, false);
});

Deno.test("EXEC_MINT_SECRET empty -> fail closed, including an empty header", async () => {
  assertEquals((await authorizeCaller(args({ execSecret: "" }))).ok, false);
  assertEquals((await authorizeCaller(args({ execSecret: "", execHeader: "" }))).ok, false);
});

Deno.test("amendment 1: secret shorter than 32 chars is treated as unset", async () => {
  const short = "x".repeat(EXEC_MINT_SECRET_MIN_LENGTH - 1);
  assertEquals(short.length, 31);
  // Header matches the short secret exactly; still denied.
  assertEquals((await authorizeCaller(args({ execSecret: short, execHeader: short }))).ok, false);
  // Exactly 32 chars is accepted.
  const ok32 = "y".repeat(32);
  assertEquals((await authorizeCaller(args({ execSecret: ok32, execHeader: ok32 }))).ok, true);
});

Deno.test("wrong header -> 403 with the existing shape", async () => {
  const r = await handle(args({ execHeader: "z".repeat(48) }), fakeDb(testContractor(true)));
  assertEquals(r.status, 403);
  assertEquals(r.body, { error: "Unauthorized" });
});

Deno.test("missing header with anon JWT -> 403 with the existing shape", async () => {
  const r = await handle(args({ execHeader: null }), fakeDb(testContractor(true)));
  assertEquals(r.status, 403);
  assertEquals(r.body, { error: "Unauthorized" });
});

Deno.test("a wrong header does not fall through to the admin JWT path", async () => {
  const d = await authorizeCaller(
    args({ execHeader: "nope", resolveUserEmail: adminResolver }),
  );
  assertEquals(d.ok, false);
});

// -- non-exec paths unchanged --

Deno.test("admin JWT, no header -> 200, metadata.caller = admin_jwt, actor = admin email", async () => {
  const logs: ActivityLogRow[] = [];
  const a = args({ execHeader: null, execSecret: undefined, resolveUserEmail: adminResolver });
  const r = await handle(a, fakeDb(testContractor(true), logs));
  assertEquals(r.status, 200);
  assertEquals(logs[0].metadata.caller, "admin_jwt");
  assertEquals(logs[0].metadata.actor, ADMIN);
});

Deno.test("non-admin user JWT, no header -> 403", async () => {
  const d = await authorizeCaller(
    args({ execHeader: null, resolveUserEmail: async () => "someone@else.com" }),
  );
  assertEquals(d.ok, false);
});

Deno.test("service-role-style Bearer alone (no header) is NOT accepted", async () => {
  const d = await authorizeCaller(
    args({ token: "service-role-key-placeholder", execHeader: null }),
  );
  assertEquals(d.ok, false);
});

// -- amendment 2: no secret in logs --

Deno.test("amendment 2: mismatch logs only the fixed marker, never the header or secret", async () => {
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => seen.push(a.map(String).join(" "));
  try {
    const bad = "HEADER-VALUE-" + "q".repeat(40);
    await authorizeCaller(args({ execHeader: bad }));
    await authorizeCaller(args({ execHeader: bad, execSecret: undefined }));
  } finally {
    console.error = orig;
  }
  assertEquals(seen.length, 2);
  for (const line of seen) {
    assertStringIncludes(line, EXEC_MISMATCH_LOG);
    assert(!line.includes("HEADER-VALUE"), "header value leaked to logs");
    assert(!line.includes(SECRET), "secret leaked to logs");
  }
  assertEquals(EXEC_MISMATCH_LOG, "caller_denied: exec_service_mismatch");
});

Deno.test("a successful exec authorization logs nothing", async () => {
  const seen: string[] = [];
  const o1 = console.error, o2 = console.log;
  console.error = (...a: unknown[]) => seen.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => seen.push(a.map(String).join(" "));
  try {
    assertEquals((await authorizeCaller(args())).ok, true);
  } finally {
    console.error = o1;
    console.log = o2;
  }
  assertEquals(seen, []);
});

// -- constant-time compare --

Deno.test("constantTimeEqual: equal, unequal, differing length, empty", async () => {
  assertEquals(await constantTimeEqual("abc", "abc"), true);
  assertEquals(await constantTimeEqual("abc", "abd"), false);
  assertEquals(await constantTimeEqual("abc", "abcd"), false);
  assertEquals(await constantTimeEqual("", ""), true);
  assertEquals(await constantTimeEqual("", "a"), false);
});
