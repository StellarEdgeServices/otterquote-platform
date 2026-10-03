// gh-2410 (R-134) reviewer follow-up: the admin-REFUSAL list inlined in
// gate.ts (ADMIN_EMAILS_LOWER) must stay equal to the canonical
// _shared/admin.ts ADMIN_EMAILS.
// Run: deno test --allow-read=supabase/functions supabase/functions/mint-test-session/admin-parity.test.ts
//
// Why this matters: gate.ts's adminRefusal() refuses to mint a session for
// any target on ADMIN_EMAILS_LOWER, BEFORE it reads role signals. The
// founder's profile is is_test = true (gh-2047), so if an admin address
// drops out of this inlined copy, the email arm of the refusal stops
// covering it. The address is then refused only if a DB role signal happens
// to read 'admin', and the live evidence on #2410 shows it does not
// (role = contractor, app_role null, contractor_roles null). The deploy path
// does not resolve _shared/ imports, so the copy is inlined and kept in sync
// by eye. This test makes that sync mechanical.
//
// _shared/admin.test.ts checks the consumers' index.ts files for the
// PRIMARY_ADMIN_EMAIL caller gate only. It never reads gate.ts, so this
// refusal list had no drift guard until now.
//
// This test reads source text only. It needs no network, environment or
// secrets, and it does not change the deployed function.

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { ADMIN_EMAILS } from "../_shared/admin.ts";

/** Extract the string literals of `const ADMIN_EMAILS_LOWER ... = [ ... ];` from gate.ts source. */
function extractRefusalList(src: string): string[] {
  const m = src.match(/const ADMIN_EMAILS_LOWER\b[^=]*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error("gate.ts: ADMIN_EMAILS_LOWER array literal not found");
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

function assertParity(refusal: string[], canonical: readonly string[]): void {
  const want = [...canonical].map((e) => e.trim().toLowerCase()).sort();
  const got = [...refusal].sort();
  assertEquals(got, want, "mint-test-session/gate.ts ADMIN_EMAILS_LOWER drifted from _shared/admin.ts ADMIN_EMAILS");
}

const gateSrc = await Deno.readTextFile(new URL("./gate.ts", import.meta.url));

Deno.test("gh-2410: gate.ts ADMIN_EMAILS_LOWER equals _shared/admin.ts ADMIN_EMAILS (lower-cased, order-insensitive)", () => {
  assertParity(extractRefusalList(gateSrc), ADMIN_EMAILS);
});

Deno.test("gh-2410: refusal list entries are already lower-case and trimmed (adminRefusal compares lower-cased input)", () => {
  for (const e of extractRefusalList(gateSrc)) {
    assertEquals(e, e.trim().toLowerCase(), `entry "${e}" must be stored lower-case/trimmed`);
  }
});

Deno.test("gh-2410: adminRefusal still checks the email allow-list before reading DB role signals", () => {
  const fn = gateSrc.indexOf("async function adminRefusal(");
  assert(fn >= 0, "adminRefusal() not found in gate.ts");
  const emailCheck = gateSrc.indexOf("ADMIN_EMAILS_LOWER.includes(", fn);
  const signalRead = gateSrc.indexOf("db.getAdminSignals(", fn);
  assert(emailCheck > fn && signalRead > fn, "both checks must live inside adminRefusal()");
  assert(emailCheck < signalRead, "the email refusal must run before (and independently of) the DB role-signal read");
});

// ── negative controls: prove the guard actually fails on the drift it targets ──

Deno.test("gh-2410 negative control: a refusal list missing one admin address FAILS parity", () => {
  const drifted = gateSrc.replace(/\s*"dustin@otterquote\.com",/, "");
  assert(drifted !== gateSrc, "fixture mutation must change the source");
  assertThrows(() => assertParity(extractRefusalList(drifted), ADMIN_EMAILS));
});

Deno.test("gh-2410 negative control: an emptied refusal list (no email arm at all) FAILS parity", () => {
  const emptied = gateSrc.replace(/(const ADMIN_EMAILS_LOWER\b[^=]*=\s*\[)[\s\S]*?(\];)/, "$1$2");
  assertEquals(extractRefusalList(emptied), []);
  assertThrows(() => assertParity(extractRefusalList(emptied), ADMIN_EMAILS));
});

Deno.test("gh-2410 negative control: source without ADMIN_EMAILS_LOWER (pre-#2411 gate.ts shape) is rejected, not silently passed", () => {
  const preFix = gateSrc.replace(/const ADMIN_EMAILS_LOWER\b/, "const SOMETHING_ELSE");
  assertThrows(() => extractRefusalList(preFix), Error, "ADMIN_EMAILS_LOWER array literal not found");
});
