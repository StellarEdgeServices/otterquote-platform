// gh-3077 (PR a) -- tests for _shared/admin-gate.ts. No network: the supabase client is a fake
// injected through GateDeps.makeClient, the same injection style as _shared/caller-gate-test-kit.ts.
// The DENY cases are the negative controls: each one runs the same code path as the allow case with
// one thing changed (other email / no JWT / bad JWT / RPC says false / RPC errors).
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  type GateDeps,
  PRIMARY_ADMIN_EMAIL,
  requireAdmin,
  requirePrimaryAdmin,
} from "./admin-gate.ts";

const SECOND_ADMIN = "dustin@otterquote.com"; // accepted by is_admin_email(), NOT by the primary-only gate
const OTHER = "someone-else@example.com";
const GOOD_JWT = "fixture-user-header.fixture-user-payload.fixture-user-signature";
const ENV: Record<string, string> = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "fixture-anon" };

interface Probe {
  clientsMade: number;
  rpcCalls: string[];
  seenAuthHeader: string | null;
}

/**
 * Fake client. getUser() succeeds only for GOOD_JWT, resolving to `email`. rpc("is_admin_email")
 * mirrors the live SQL function: true only for the two literal addresses, case-sensitive, else false.
 */
function fakeDeps(email: string | null, opts: { rpcError?: boolean; getUserThrows?: boolean } = {}) {
  const probe: Probe = { clientsMade: 0, rpcCalls: [], seenAuthHeader: null };
  const deps: GateDeps = {
    getEnv: (n) => ENV[n],
    getUser: (_url, _key, authHeader) => {
      probe.clientsMade++;
      probe.seenAuthHeader = authHeader;
      if (opts.getUserThrows) throw new Error("boom");
      return Promise.resolve(
        authHeader === `Bearer ${GOOD_JWT}`
          ? { data: { user: { id: "u-1", email } }, error: null }
          : { data: { user: null }, error: { message: "invalid JWT" } },
      );
    },
    callIsAdminEmail: (_url, _key, authHeader) => {
      probe.rpcCalls.push("is_admin_email");
      probe.seenAuthHeader = authHeader;
      if (opts.rpcError) return Promise.resolve({ data: null, error: { message: "rpc failed" } });
      const ok = email === PRIMARY_ADMIN_EMAIL || email === SECOND_ADMIN;
      return Promise.resolve({ data: ok, error: null });
    },
  };
  return { deps, probe };
}

const reqWith = (auth: string | null) =>
  new Request("https://f.example/x", { method: "POST", headers: auth === null ? {} : { Authorization: auth } });

// -- requireAdmin -----------------------------------------------------------------------------

Deno.test("requireAdmin: ALLOW primary address (calls is_admin_email with the caller's JWT)", async () => {
  const { deps, probe } = fakeDeps(PRIMARY_ADMIN_EMAIL);
  const r = await requireAdmin(reqWith(`Bearer ${GOOD_JWT}`), deps);
  assert(r.ok);
  if (r.ok) assertEquals(r.user.email, PRIMARY_ADMIN_EMAIL);
  assertEquals(probe.rpcCalls, ["is_admin_email"]);
  assertEquals(probe.seenAuthHeader, `Bearer ${GOOD_JWT}`);
});

Deno.test("requireAdmin: ALLOW second address (the set is_admin_email() accepts today)", async () => {
  const { deps } = fakeDeps(SECOND_ADMIN);
  assert((await requireAdmin(reqWith(`Bearer ${GOOD_JWT}`), deps)).ok);
});

Deno.test("requireAdmin: DENY another email with a valid JWT (403, identified)", async () => {
  const { deps } = fakeDeps(OTHER);
  const r = await requireAdmin(reqWith(`Bearer ${GOOD_JWT}`), deps);
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.status, 403);
    assertEquals(r.user?.email, OTHER);
  }
});

Deno.test("requireAdmin: DENY case-variant of the admin address (exact match, as is_admin_email())", async () => {
  const { deps } = fakeDeps("Dustinstohler1@Gmail.com");
  assertEquals((await requireAdmin(reqWith(`Bearer ${GOOD_JWT}`), deps)).ok, false);
});

Deno.test("requireAdmin: DENY with no Authorization header (401, no client built, no RPC)", async () => {
  const { deps, probe } = fakeDeps(PRIMARY_ADMIN_EMAIL);
  const r = await requireAdmin(reqWith(null), deps);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 401);
  assertEquals(probe.clientsMade, 0);
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("requireAdmin: DENY a non-Bearer or empty-bearer header (401)", async () => {
  for (const h of ["Basic abc", "Bearer ", "Bearer", GOOD_JWT]) {
    const { deps, probe } = fakeDeps(PRIMARY_ADMIN_EMAIL);
    const r = await requireAdmin(reqWith(h), deps);
    assertEquals(r.ok, false, h);
    if (!r.ok) assertEquals(r.status, 401, h);
    assertEquals(probe.rpcCalls.length, 0, h);
  }
});

Deno.test("requireAdmin: DENY an invalid/expired JWT (401, RPC never reached)", async () => {
  const { deps, probe } = fakeDeps(PRIMARY_ADMIN_EMAIL);
  const r = await requireAdmin(reqWith("Bearer not-a-real-jwt"), deps);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 401);
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("requireAdmin: FAILS CLOSED when the RPC errors, when getUser throws, and when env is missing", async () => {
  const a = fakeDeps(PRIMARY_ADMIN_EMAIL, { rpcError: true });
  assertEquals((await requireAdmin(reqWith(`Bearer ${GOOD_JWT}`), a.deps)).ok, false);
  const b = fakeDeps(PRIMARY_ADMIN_EMAIL, { getUserThrows: true });
  assertEquals((await requireAdmin(reqWith(`Bearer ${GOOD_JWT}`), b.deps)).ok, false);
  const c = fakeDeps(PRIMARY_ADMIN_EMAIL);
  assertEquals((await requireAdmin(reqWith(`Bearer ${GOOD_JWT}`), { ...c.deps, getEnv: () => undefined })).ok, false);
});

// -- requirePrimaryAdmin ----------------------------------------------------------------------

Deno.test("requirePrimaryAdmin: ALLOW the primary address", async () => {
  const { deps } = fakeDeps(PRIMARY_ADMIN_EMAIL);
  const r = await requirePrimaryAdmin(reqWith(`Bearer ${GOOD_JWT}`), deps);
  assert(r.ok);
});

Deno.test("requirePrimaryAdmin: DENY the second admin address (nothing widens: this is the point of the split)", async () => {
  const { deps } = fakeDeps(SECOND_ADMIN);
  // negative control: the same caller IS accepted by requireAdmin
  assert((await requireAdmin(reqWith(`Bearer ${GOOD_JWT}`), fakeDeps(SECOND_ADMIN).deps)).ok);
  const r = await requirePrimaryAdmin(reqWith(`Bearer ${GOOD_JWT}`), deps);
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.status, 403);
    assertEquals(r.user?.email, SECOND_ADMIN); // identified, so a role fallback can still use user.id
  }
});

Deno.test("requirePrimaryAdmin: DENY another email, case variant, no header, invalid JWT", async () => {
  assertEquals((await requirePrimaryAdmin(reqWith(`Bearer ${GOOD_JWT}`), fakeDeps(OTHER).deps)).ok, false);
  assertEquals(
    (await requirePrimaryAdmin(reqWith(`Bearer ${GOOD_JWT}`), fakeDeps("Dustinstohler1@Gmail.com").deps)).ok,
    false,
  );
  const none = await requirePrimaryAdmin(reqWith(null), fakeDeps(PRIMARY_ADMIN_EMAIL).deps);
  assertEquals(none.ok, false);
  if (!none.ok) assertEquals(none.status, 401);
  const bad = await requirePrimaryAdmin(reqWith("Bearer nope"), fakeDeps(PRIMARY_ADMIN_EMAIL).deps);
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.status, 401);
});

Deno.test("requirePrimaryAdmin: DENY a verified user with no email (null never matches)", async () => {
  const { deps } = fakeDeps(null);
  assertEquals((await requirePrimaryAdmin(reqWith(`Bearer ${GOOD_JWT}`), deps)).ok, false);
});
