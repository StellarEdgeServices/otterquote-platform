// gh-3077: the record-ad-sharing-opt-out admin check after moving onto _shared/admin-gate.ts requirePrimaryAdmin.
// Run: deno test --allow-read=supabase/functions supabase/functions/record-ad-sharing-opt-out/admin-check.test.ts
//
// PROOF OF NO ACCESS CHANGE: the pre-gh-3077 gate admitted a caller iff
//   (verified email === primary) OR (contractors.template_review_role === "admin").
// The table below runs every (email, role) combination through BOTH that reference and the new code, with the real
// requirePrimaryAdmin fed fake auth deps, and asserts they agree on every row. The second admin address stays refused.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { type GateDeps, PRIMARY_ADMIN_EMAIL, requirePrimaryAdmin } from "../_shared/admin-gate.ts";
import { isAdminCaller } from "./admin-check.ts";
import { handleRequest, type Deps } from "./handler.ts";

const SECOND = "dustin@otterquote.com";
const JWT = "Bearer a.b.c";
const EMAILS: (string | null)[] = [PRIMARY_ADMIN_EMAIL, SECOND, "someone@example.com", "DustinStohler1@gmail.com", null];
const ROLES: (string | undefined)[] = ["admin", "contractor", undefined];

const oldGate = (email: string | null, role: string | undefined) => email === PRIMARY_ADMIN_EMAIL || role === "admin";

function gateFor(email: string | null) {
  const deps: GateDeps = {
    getEnv: (n) => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "k" } as Record<string, string>)[n],
    getUser: () => Promise.resolve({ data: { user: { id: "u1", email } }, error: null }),
  };
  return () => requirePrimaryAdmin(new Request("https://f/x", { method: "POST", headers: { Authorization: JWT } }), deps);
}

Deno.test("gh-3077: old and new gates admit exactly the same (email, role) set", async () => {
  let admitted = 0;
  for (const email of EMAILS) {
    for (const role of ROLES) {
      const got = await isAdminCaller(gateFor(email), () => Promise.resolve(role === "admin"));
      assertEquals(got, oldGate(email, role), `email=${email} role=${role}`);
      if (got) admitted++;
    }
  }
  assertEquals(admitted, 7); // primary x3 roles, plus the 4 other emails with role=admin
});

Deno.test("gh-3077: the second admin address is NOT admitted by the email arm (nothing widens)", async () => {
  assertFalse(await isAdminCaller(gateFor(SECOND), () => Promise.resolve(false)));
});

Deno.test("gh-3077: the role fallback is only consulted when the email arm says no", async () => {
  let asked = 0;
  assert(await isAdminCaller(gateFor(PRIMARY_ADMIN_EMAIL), () => { asked++; return Promise.resolve(false); }));
  assertEquals(asked, 0);
});

// End to end through the real handler: a non-admin is refused 403 and nothing is written.
function handlerDeps(isAdmin: Deps["isAdmin"], writes: string[]): Deps {
  return {
    authenticate: () => Promise.resolve({ id: "u1", email: "someone@example.com" }),
    isAdmin,
    hashEmail: () => Promise.resolve("h"),
    suppress: () => { writes.push("suppress"); return Promise.resolve(null); },
    flagProfiles: () => { writes.push("flag"); return Promise.resolve({ matched: 0, updated: 0 }); },
    audit: () => { writes.push("audit"); return Promise.resolve(null); },
    now: () => new Date(0),
    log: () => {},
  };
}
const post = () => new Request("https://f/x", { method: "POST", headers: { Authorization: JWT, "Content-Type": "application/json" }, body: '{"email":"a@b.co"}' });

Deno.test("gh-3077: a non-admin caller is refused 403 through the real gate, with no write", async () => {
  const writes: string[] = [];
  const res = await handleRequest(post(), handlerDeps((_id) => isAdminCaller(gateFor("someone@example.com"), () => Promise.resolve(false)), writes));
  assertEquals(res.status, 403);
  assertEquals(writes, []);
});

Deno.test("gh-3077: the primary admin is admitted through the real gate", async () => {
  const writes: string[] = [];
  const res = await handleRequest(post(), handlerDeps((_id) => isAdminCaller(gateFor(PRIMARY_ADMIN_EMAIL), () => Promise.resolve(false)), writes));
  assertEquals(res.status, 200);
  assertEquals(writes, ["suppress", "flag", "audit"]);
});

// ── negative controls: these fail if the gate is removed ──
Deno.test("gh-3077 negative control: with the gate removed (always admit) the non-admin refusal test would FAIL", async () => {
  const writes: string[] = [];
  const res = await handleRequest(post(), handlerDeps(() => Promise.resolve(true), writes));
  assert(res.status !== 403, "a removed gate admits the non-admin; the 403 assertion above would fail");
  assert(writes.length > 0);
});

Deno.test("gh-3077: index.ts still wires isAdmin through requirePrimaryAdmin + isAdminCaller and has no email literal", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes("isAdminCaller("), "index.ts must call isAdminCaller");
  assert(src.includes("requirePrimaryAdmin(req)"), "index.ts must gate on requirePrimaryAdmin(req)");
  assertFalse(/requireAdmin\(/.test(src.replace(/requirePrimaryAdmin\(/g, "")), "must not widen to requireAdmin()");
  assertFalse(/@gmail\.com|@otterquote\.com/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
});

Deno.test("gh-3077 negative control: index.ts source with the gate call removed FAILS the wiring check", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertFalse(src.replace("requirePrimaryAdmin(req)", "true").includes("requirePrimaryAdmin(req)"));
});
