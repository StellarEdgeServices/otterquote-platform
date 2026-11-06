// gh-3077 (REVIEW 6669179197): runs requirePrimaryAdmin / requireAdmin with NO getUser override, i.e. the REAL
// defaultGetUser, through real supabase-js 2.114.0 against a stubbed globalThis.fetch (no network, no --allow-net).
// Every other gate test injects a fake getUser, so a repeat of the #3115 defect (client built with the token as the KEY,
// `createClient(url, token).auth.getUser()`, which sends no Authorization header and returns AuthSessionMissingError)
// would stay green while the primary admin lost access. This test fails on that form: the stub only answers /auth/v1/user
// when the caller's token arrives in the Authorization header, exactly as GoTrue does.
// Run: deno test --allow-read=supabase/functions supabase/functions/_shared/admin-gate.real-auth.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { PRIMARY_ADMIN_EMAIL, requireAdmin, requirePrimaryAdmin } from "./admin-gate.ts";

const TOKEN = "real-path-fixture-token";
const ANON = "real-path-fixture-anon-key";
const URL_ = "https://fixture.supabase.co";
const env: Record<string, string> = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON };

interface Seen { authUser: { auth: string | null; apikey: string | null }[]; rpc: number }

async function withStubbedFetch<T>(userEmail: string, fn: (seen: Seen) => Promise<T>): Promise<T> {
  const seen: Seen = { authUser: [], rpc: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input as Request | string, init);
    const u = new URL(req.url);
    if (u.pathname === "/auth/v1/user") {
      const auth = req.headers.get("Authorization");
      seen.authUser.push({ auth, apikey: req.headers.get("apikey") });
      // GoTrue answers only when the user's token is the Bearer credential.
      if (auth !== `Bearer ${TOKEN}`) {
        return Promise.resolve(new Response(JSON.stringify({ code: 401, msg: "missing sub claim" }), { status: 401, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", email: userEmail, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    if (u.pathname === "/rest/v1/rpc/is_admin_email") {
      seen.rpc++;
      return Promise.resolve(new Response(JSON.stringify(userEmail === PRIMARY_ADMIN_EMAIL || userEmail === "dustin@otterquote.com"), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const req = () => new Request("https://f.example/x", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
const deps = { getEnv: (n: string) => env[n] }; // env only; getUser and callIsAdminEmail are the REAL defaults

Deno.test("real getUser path: requirePrimaryAdmin ADMITS the primary admin (token reaches GoTrue as the Authorization header)", async () => {
  await withStubbedFetch(PRIMARY_ADMIN_EMAIL, async (seen) => {
    const r = await requirePrimaryAdmin(req(), deps);
    assert(r.ok, "the primary admin must be admitted through the real getUser");
    assertEquals(seen.authUser.length >= 1, true);
    assertEquals(seen.authUser[0].auth, `Bearer ${TOKEN}`);
    assertEquals(seen.authUser[0].apikey, ANON);
  });
});

Deno.test("real getUser path: requirePrimaryAdmin REFUSES the second admin address and another user", async () => {
  for (const email of ["dustin@otterquote.com", "someone@example.com"]) {
    await withStubbedFetch(email, async () => {
      const r = await requirePrimaryAdmin(req(), deps);
      assertEquals(r.ok, false, email);
    });
  }
});

Deno.test("real getUser path: requireAdmin admits both addresses via the real getUser + real RPC fetch, refuses another user", async () => {
  for (const [email, want] of [[PRIMARY_ADMIN_EMAIL, true], ["dustin@otterquote.com", true], ["someone@example.com", false]] as const) {
    await withStubbedFetch(email, async (seen) => {
      const r = await requireAdmin(req(), deps);
      assertEquals(r.ok, want, email);
      assertEquals(seen.rpc, 1);
    });
  }
});

Deno.test("real getUser path: a token GoTrue rejects (401) is refused 401", async () => {
  await withStubbedFetch(PRIMARY_ADMIN_EMAIL, async () => {
    const r = await requirePrimaryAdmin(new Request("https://f.example/x", { method: "POST", headers: { Authorization: "Bearer some-other-token" } }), deps);
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.status, 401);
  });
});
