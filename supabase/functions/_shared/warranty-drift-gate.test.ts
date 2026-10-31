// gh-3115 -- tests for _shared/warranty-drift-gate.ts (no network; fakes injected via GateDeps).
// Negative control: the old gate (`createClient(url, token).auth.getUser()`) refused everyone; the
// primary-admin ALLOW case below is the one that failed on main.
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import type { GateDeps } from "./admin-gate.ts";
import { PRIMARY_ADMIN_EMAIL } from "./admin-gate.ts";
import { authorizeWarrantyDriftCaller } from "./warranty-drift-gate.ts";

const JWT = "fixture-user-header.fixture-user-payload.fixture-user-signature";
const ENV: Record<string, string> = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "fixture-anon" };

function deps(email: string | null): { d: GateDeps; seen: { auth: string | null } } {
  const seen = { auth: null as string | null };
  return {
    seen,
    d: {
      getEnv: (n) => ENV[n],
      getUser: (_u, _k, h) => {
        seen.auth = h;
        return Promise.resolve(
          h === `Bearer ${JWT}`
            ? { data: { user: { id: "u-1", email } }, error: null }
            : { data: { user: null }, error: { message: "invalid JWT" } },
        );
      },
    },
  };
}
const req = (a: string | null) =>
  new Request("https://f.example/x", { method: "POST", headers: a === null ? {} : { Authorization: a } });

Deno.test("ALLOW primary admin (role lookup not consulted)", async () => {
  const { d, seen } = deps(PRIMARY_ADMIN_EMAIL);
  let looked = 0;
  const r = await authorizeWarrantyDriftCaller(req(`Bearer ${JWT}`), () => { looked++; return Promise.resolve(false); }, d);
  assert(r.ok);
  assertEquals(looked, 0);
  assertEquals(seen.auth, `Bearer ${JWT}`); // JWT reached verification
});

Deno.test("ALLOW non-primary user with template_review_role=admin", async () => {
  const { d } = deps("contractor@example.com");
  const r = await authorizeWarrantyDriftCaller(req(`Bearer ${JWT}`), (id) => Promise.resolve(id === "u-1"), d);
  assert(r.ok);
});

Deno.test("DENY 403 non-admin JWT (role lookup false)", async () => {
  const { d } = deps("contractor@example.com");
  const r = await authorizeWarrantyDriftCaller(req(`Bearer ${JWT}`), () => Promise.resolve(false), d);
  assertEquals(r, { ok: false, status: 403 });
});

Deno.test("DENY 403 when role lookup throws (fail closed)", async () => {
  const { d } = deps("contractor@example.com");
  const r = await authorizeWarrantyDriftCaller(req(`Bearer ${JWT}`), () => Promise.reject(new Error("db down")), d);
  assertEquals(r, { ok: false, status: 403 });
});

Deno.test("DENY 401 missing header / invalid token; role lookup never consulted", async () => {
  for (const h of [null, "Bearer bad.token.value", "Basic abc"]) {
    const { d } = deps(PRIMARY_ADMIN_EMAIL);
    let looked = 0;
    const r = await authorizeWarrantyDriftCaller(req(h), () => { looked++; return Promise.resolve(true); }, d);
    assertEquals(r, { ok: false, status: 401 }, String(h));
    assertEquals(looked, 0);
  }
});

Deno.test("wiring: both index.ts use the gate and no longer call token-only auth.getUser()", async () => {
  for (const fn of ["approve-warranty-drift", "reject-warranty-drift"]) {
    const src = await Deno.readTextFile(new URL(`../${fn}/index.ts`, import.meta.url));
    assert(src.includes('from "../_shared/warranty-drift-gate.ts"'), fn);
    assert(src.includes("authorizeWarrantyDriftCaller("), fn);
    assert(!/createClient\(SUPABASE_URL, callerToken\)/.test(src), fn);
    assert(!src.includes(".auth.getUser()"), fn);
  }
});
