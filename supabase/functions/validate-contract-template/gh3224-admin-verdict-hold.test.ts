// gh-3224 -- an admin's verdict on a contractor template stays intact.
//   (1) revalidate_all skips `rejected` / `admin_validated` unless an admin passes force_admin_verdicts.
//   (2) a template whose last admin verdict was `rejected` never reaches auto_validated / manual_validated on a
//       scan: it lands on submitted_for_admin_review. A never-rejected template still auto-validates.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MANIFEST } from "./manifest.ts";
import { revalidateTemplates } from "./revalidate.ts";
import { applyRejectionHold, HOLD_STATUS, lookupRejectionHold, skipForAdminVerdict } from "./admin-verdict-hold.ts";

const GOOD_TEXT = MANIFEST.trades.roofing.retail.required
  // deno-lint-ignore no-explicit-any
  .map((r: any) => r.anchor).join("\n") + "\nTERMS AND CONDITIONS\n";

// deno-lint-ignore no-explicit-any
function row(id: string, status: string, extra: Record<string, any> = {}) {
  return { id, contractor_id: "c-" + id, trade: "roofing", funding_type: "retail", status, pdf_storage_path: `${id}.pdf`, validation_result: null, manual_overrides: null, ...extra };
}
// deno-lint-ignore no-explicit-any
function fake(rows: any[], blockedIds: string[] = [], rpcError = false) {
  // deno-lint-ignore no-explicit-any
  const writes: any[] = [];
  const rpcCalls: string[] = [];
  return {
    writes, rpcCalls,
    rpc(name: string, a: { p_template_id: string }) {
      assertEquals(name, "template_admin_verdict_blocks_auto_validation");
      rpcCalls.push(a.p_template_id);
      if (rpcError) return Promise.resolve({ data: null, error: { message: "boom" } });
      return Promise.resolve({ data: blockedIds.includes(a.p_template_id), error: null });
    },
    from(table: string) {
      if (table === "contractors") {
        const c = { select() { return c; }, eq() { return c; }, maybeSingle() { return Promise.resolve({ data: { company_name: "X", address_line1: null, address_city: null }, error: null }); } };
        return c;
      }
      let filtered = rows;
      const chain = {
        select() { return chain; }, order() { return chain; },
        in(_c: string, ids: string[]) { filtered = rows.filter((r) => ids.includes(r.id)); return chain; },
        then(res: (v: unknown) => void) { res({ data: filtered, error: null }); },
        // deno-lint-ignore no-explicit-any
        update(patch: any) { return { eq(_c: string, id: string) { return { select() { writes.push({ id, patch }); return Promise.resolve({ data: [{ id }], error: null }); } }; } }; },
      };
      return chain;
    },
    storage: { from() { return { download() { const b = new TextEncoder().encode(GOOD_TEXT); return Promise.resolve({ data: { arrayBuffer: () => Promise.resolve(b.buffer) }, error: null }); } }; } },
  };
}
const extract = (b: Uint8Array) => Promise.resolve(new TextDecoder().decode(b));

// ---------------------------------------------------------------- part 1: skip / force
Deno.test("skipForAdminVerdict: only rejected and admin_validated, and force lifts it", () => {
  assert(skipForAdminVerdict("rejected", false));
  assert(skipForAdminVerdict("admin_validated", false));
  for (const s of ["pending_validation", "manual_mapping_pending", "auto_validated", "manual_validated", "submitted_for_admin_review", null, undefined]) {
    assert(!skipForAdminVerdict(s, false), String(s));
  }
  assert(!skipForAdminVerdict("rejected", true));
  assert(!skipForAdminVerdict("admin_validated", true));
});

Deno.test("revalidate_all (write mode): rejected stays rejected, admin_validated untouched, pending_validation still validates (negative control)", async () => {
  const sb = fake([row("R", "rejected"), row("V", "admin_validated"), row("P", "pending_validation")]);
  const r = await revalidateTemplates({ supabase: sb, dryRun: false, extractPdfText: extract });
  assertEquals(r.skippedAdminVerdict, 2);
  assertEquals(r.scanned, 3);
  assertEquals(sb.writes.map((w) => w.id), ["P"], "only the pending_validation row is written");
  assertEquals(sb.writes[0].patch.status, "auto_validated", "negative control: a never-rejected row still auto-validates");
  assertEquals(r.rows.map((x) => x.id), ["P"], "skipped rows are not re-scanned");
});

Deno.test("revalidate_all: force:true (the existing stale-bypass) does NOT lift the verdict skip", async () => {
  const sb = fake([row("R", "rejected")]);
  const r = await revalidateTemplates({ supabase: sb, dryRun: false, force: true, extractPdfText: extract });
  assertEquals(sb.writes.length, 0);
  assertEquals(r.skippedAdminVerdict, 1);
});

Deno.test("revalidate_all: forceAdminVerdicts re-scans a rejected row, but it still cannot become auto_validated (blocked by the verdict log)", async () => {
  const sb = fake([row("R", "rejected")], ["R"]);
  const r = await revalidateTemplates({ supabase: sb, dryRun: false, forceAdminVerdicts: true, extractPdfText: extract });
  assertEquals(r.skippedAdminVerdict, 0);
  assertEquals(sb.writes.length, 1);
  assertEquals(sb.writes[0].patch.status, HOLD_STATUS);
});

// ---------------------------------------------------------------- part 2: hold
Deno.test("applyRejectionHold: previously rejected -> submitted_for_admin_review for both validated statuses", async () => {
  const sb = fake([], ["T"]);
  assertEquals(await applyRejectionHold(sb, "T", "auto_validated"), { ok: true, status: HOLD_STATUS, held: true });
  assertEquals(await applyRejectionHold(sb, "T", "manual_validated"), { ok: true, status: HOLD_STATUS, held: true });
});

Deno.test("applyRejectionHold: NEGATIVE CONTROL never-rejected template still auto-validates", async () => {
  const sb = fake([], []);
  assertEquals(await applyRejectionHold(sb, "T", "auto_validated"), { ok: true, status: "auto_validated", held: false });
  assertEquals(await applyRejectionHold(sb, "T", "manual_validated"), { ok: true, status: "manual_validated", held: false });
});

Deno.test("applyRejectionHold: a failing scan (manual_mapping_pending) passes through with no lookup", async () => {
  const sb = fake([], ["T"]);
  assertEquals(await applyRejectionHold(sb, "T", "manual_mapping_pending"), { ok: true, status: "manual_mapping_pending", held: false });
  assertEquals(sb.rpcCalls.length, 0);
});

Deno.test("applyRejectionHold: lookup error or non-boolean fails CLOSED", async () => {
  assertEquals((await applyRejectionHold(fake([], [], true), "T", "auto_validated")).ok, false);
  // deno-lint-ignore no-explicit-any
  const weird: any = { rpc: () => Promise.resolve({ data: null, error: null }) };
  assertEquals((await lookupRejectionHold(weird, "T")).ok, false);
  // deno-lint-ignore no-explicit-any
  const throws: any = { rpc: () => { throw new Error("net"); } };
  assertEquals((await lookupRejectionHold(throws, "T")).ok, false);
});

Deno.test("revalidate_all: a reset (pending_validation) row with a prior rejection lands on submitted_for_admin_review, others auto-validate", async () => {
  const sb = fake([row("RR", "pending_validation"), row("OK", "pending_validation")], ["RR"]);
  await revalidateTemplates({ supabase: sb, dryRun: false, extractPdfText: extract });
  const by = Object.fromEntries(sb.writes.map((w) => [w.id, w.patch]));
  assertEquals(by.RR.status, HOLD_STATUS);
  assertEquals(by.RR.validation_result.heldForAdminReview, true);
  assertEquals(by.OK.status, "auto_validated");
});

Deno.test("revalidate_all: lookup failure writes nothing for the row and counts an error", async () => {
  const sb = fake([row("P", "pending_validation")], [], true);
  const r = await revalidateTemplates({ supabase: sb, dryRun: false, extractPdfText: extract });
  assertEquals(sb.writes.length, 0);
  assertEquals(r.errors, 1);
  assertStringIncludes(r.rows[0].error!, "lookup failed");
});

// ---------------------------------------------------------------- wiring in index.ts (it calls Deno.serve, so text-asserted)
const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("wiring: fresh path applies the hold after the state machine and before the write, and fails closed", () => {
  const iState = src.indexOf('newStatus = "manual_mapping_pending";');
  const iHold = src.indexOf("applyRejectionHold(supabase, contractor_template_id, newStatus)");
  const iWrite = src.indexOf('.update({\n        validation_result: validationResult,');
  assert(iState > 0 && iHold > iState && iWrite > iHold, "order: state machine < hold < write");
  const block = src.slice(iHold, iWrite);
  assertStringIncludes(block, "if (!hold.ok)");
  assertStringIncludes(block, "500");
  assertStringIncludes(block, "newStatus = hold.status");
});

Deno.test("wiring: force_admin_verdicts needs an admin JWT, is not satisfied by the service-role key, and is logged", () => {
  const i = src.indexOf("body.force_admin_verdicts === true");
  assert(i > 0);
  const block = src.slice(i, i + 900);
  assertStringIncludes(block, 'role !== "admin"');
  assertStringIncludes(block, "403");
  assertStringIncludes(block, "console.warn");
  assertStringIncludes(src, "forceAdminVerdicts,");
});

Deno.test("mutation control: dropping the hold from the wiring would be caught by the order assertion", () => {
  const mutated = src.replace("applyRejectionHold(supabase, contractor_template_id, newStatus)", "Promise.resolve({ ok: true, status: newStatus })");
  assert(mutated.indexOf("applyRejectionHold(supabase, contractor_template_id, newStatus)") === -1);
  assert(src.indexOf("applyRejectionHold(supabase, contractor_template_id, newStatus)") > 0);
});
