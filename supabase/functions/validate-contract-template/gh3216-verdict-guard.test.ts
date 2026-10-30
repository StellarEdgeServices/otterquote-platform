// gh-3216 -- validate-contract-template must not overwrite an admin verdict.
//
// Two layers, because index.ts calls Deno.serve at module scope and cannot be imported by the
// permission-less pure-unit lane (see guard-order.test.ts):
//   1. BEHAVIOUR of the decision (verdict-guard.ts), driven through the REAL _shared/admin-gate.ts
//      requireAdmin with injected auth/RPC fakes: contractor vs admin, per status.
//   2. WIRING in index.ts (read as text): the guard sits after the ownership check and before every
//      write (assisted-path storage upload, status update), and a refusal returns before them.
//
// FAIL-FIRST: against origin/main, verdict-guard.ts does not exist (layer 1 cannot load) and index.ts
// has no guard (every layer-2 assertion fails).
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { checkAdminVerdictGuard, ADMIN_VERDICT_STATUSES, VERDICT_LOCKED_CODE } from "./verdict-guard.ts";

const ENV: Record<string, string> = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon-fixture" };

/** requireAdmin wired to fakes; `isAdminEmail` is what public.is_admin_email() would answer. */
function gateFor(isAdminEmail: boolean | "throw") {
  let rpcCalls = 0;
  const fn = (req: Request) =>
    requireAdmin(req, {
      getEnv: (n) => ENV[n],
      getUser: () => Promise.resolve({ data: { user: { id: "u1", email: "someone@example.test" } }, error: null }),
      callIsAdminEmail: () => {
        rpcCalls++;
        if (isAdminEmail === "throw") return Promise.reject(new Error("rpc down"));
        return Promise.resolve({ data: isAdminEmail, error: null });
      },
    });
  return { fn, rpcCalls: () => rpcCalls };
}
const REQ = () => new Request("https://x.supabase.co/functions/v1/validate-contract-template", {
  method: "POST",
  headers: { Authorization: "Bearer fixture.jwt.value" },
});

Deno.test("contractor on `rejected`: refused with 409, admin_verdict_locked, status echoed", async () => {
  const g = gateFor(false);
  const r = await checkAdminVerdictGuard({ req: REQ(), currentStatus: "rejected", isAdminPath: false, requireAdminFn: g.fn });
  assert(!r.ok);
  if (!r.ok) {
    assertEquals(r.httpStatus, 409);
    assertEquals(r.body.code, VERDICT_LOCKED_CODE);
    assertEquals(r.body.status, "rejected");
    assertStringIncludes(r.body.error, "rejected");
  }
});

Deno.test("contractor on `admin_validated`: refused with 409", async () => {
  const g = gateFor(false);
  const r = await checkAdminVerdictGuard({ req: REQ(), currentStatus: "admin_validated", isAdminPath: false, requireAdminFn: g.fn });
  assert(!r.ok);
  if (!r.ok) {
    assertEquals(r.httpStatus, 409);
    assertEquals(r.body.status, "admin_validated");
  }
});

Deno.test("negative control: contractor on `manual_mapping_pending` proceeds as before (admin gate not even consulted)", async () => {
  const g = gateFor(false);
  const r = await checkAdminVerdictGuard({ req: REQ(), currentStatus: "manual_mapping_pending", isAdminPath: false, requireAdminFn: g.fn });
  assertEquals(r.ok, true);
  assertEquals(g.rpcCalls(), 0);
});

Deno.test("negative control: contractor on `pending_validation` (and null/unknown/auto/manual_validated) proceeds", async () => {
  for (const s of ["pending_validation", "auto_validated", "manual_validated", "submitted_for_admin_review", null, undefined, "weird"]) {
    const g = gateFor(false);
    const r = await checkAdminVerdictGuard({ req: REQ(), currentStatus: s as string | null, isAdminPath: false, requireAdminFn: g.fn });
    assertEquals(r.ok, true, `status ${String(s)} must not be locked`);
  }
});

Deno.test("admin on `rejected` via the manualOverrides === \"admin\" path: proceeds", async () => {
  const g = gateFor(false);
  const r = await checkAdminVerdictGuard({ req: REQ(), currentStatus: "rejected", isAdminPath: true, requireAdminFn: g.fn });
  assertEquals(r.ok, true);
});

Deno.test("admin (is_admin_email) on `rejected` and `admin_validated` without the admin flag: proceeds", async () => {
  for (const s of ["rejected", "admin_validated"]) {
    const g = gateFor(true);
    const r = await checkAdminVerdictGuard({ req: REQ(), currentStatus: s, isAdminPath: false, requireAdminFn: g.fn });
    assertEquals(r.ok, true, s);
    assertEquals(g.rpcCalls(), 1);
  }
});

Deno.test("fails closed: admin-gate error or throw on a locked status is treated as not-admin", async () => {
  const thrower = await checkAdminVerdictGuard({
    req: REQ(), currentStatus: "rejected", isAdminPath: false, requireAdminFn: () => Promise.reject(new Error("boom")),
  });
  assertEquals(thrower.ok, false);
  const rpcDown = await checkAdminVerdictGuard({ req: REQ(), currentStatus: "rejected", isAdminPath: false, requireAdminFn: gateFor("throw").fn });
  assertEquals(rpcDown.ok, false);
  const noBearer = await checkAdminVerdictGuard({
    req: new Request("https://x.supabase.co/f", { method: "POST" }), currentStatus: "admin_validated", isAdminPath: false,
    requireAdminFn: (r) => requireAdmin(r, { getEnv: (n) => ENV[n] }),
  });
  assertEquals(noBearer.ok, false);
});

Deno.test("locked set is exactly rejected + admin_validated", () => {
  assertEquals([...ADMIN_VERDICT_STATUSES].sort(), ["admin_validated", "rejected"]);
});

// ─── Layer 2: index.ts wiring ───────────────────────────────────────────────────────────────────
const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  return i;
}

Deno.test("wiring: index.ts imports and calls checkAdminVerdictGuard with the loaded row status and isAdminPath", () => {
  assertStringIncludes(src, `import { checkAdminVerdictGuard } from "./verdict-guard.ts";`);
  assertStringIncludes(src, "checkAdminVerdictGuard({ req, currentStatus: tmpl.status, isAdminPath })");
});

Deno.test("wiring: guard runs after the ownership check and before the assisted-path writes, the scan and the status update", () => {
  const idxOwn = mustFind('you do not own this template');
  const idxGuard = mustFind("await checkAdminVerdictGuard(");
  const idxAssist = mustFind("if (body.assist === true) {");
  const idxUpload = mustFind('.upload(archivePath');
  const idxScan = mustFind("scanRequiredAnchors(pdfText");
  const idxUpdate = mustFind('.from("contractor_templates")\n      .update(');
  assert(idxOwn < idxGuard, "non-owners must still get the 403 first");
  assert(idxGuard < idxAssist && idxGuard < idxUpload && idxGuard < idxScan && idxGuard < idxUpdate, "guard must precede every write");
});

Deno.test("wiring: a refused guard returns the 409 body immediately (no fall-through)", () => {
  const idxGuard = mustFind("await checkAdminVerdictGuard(");
  const block = src.slice(idxGuard, idxGuard + 260);
  assertStringIncludes(block, "if (!verdictGuard.ok) {");
  assertStringIncludes(block, "return jsonResponse(verdictGuard.body, verdictGuard.httpStatus, corsHeaders);");
});

Deno.test("mutation control: removing the early return would let the refused request reach the status update", () => {
  const idxGuard = mustFind("await checkAdminVerdictGuard(");
  const block = src.slice(idxGuard, idxGuard + 260);
  const mutated = block.replace("return jsonResponse(verdictGuard.body, verdictGuard.httpStatus, corsHeaders);", "");
  assert(block.includes("return jsonResponse(verdictGuard.body") && !mutated.includes("return jsonResponse(verdictGuard.body"));
});
