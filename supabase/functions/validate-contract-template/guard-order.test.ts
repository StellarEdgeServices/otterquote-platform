// [#1584 / #1313] Reachability regression cover for the starter-path guard
// ordering fix.
//
// Before this fix, `if (!contractor_template_id) return 400` sat before the
// `if (body.starter === true)` branch and had no exemption for it, so BOTH
// real callers of the starter path (js/contract-template-validation.js's
// downloadStarterTemplate() and tests/e2e/seed/seed.mjs's
// fetchStarterTemplate()) always 400'd — the starter path had never worked in
// production since it was added (#1313, PR #1316, 2026-08-28).
//
// This file does NOT import index.ts directly: index.ts calls Deno.serve(...)
// at module scope (requires --allow-net to bind) and Deno.env.get(...) inside
// the handler (requires --allow-env), but the gh-422 pure-unit lane runs
// `deno test --allow-read=supabase/functions supabase/functions/` with no
// other permission flags by design (no secrets, no network — see the CI-scope
// comment in this repo's history). So, following the same technique already
// used by starter-template.test.ts in this directory (lifting MANIFEST out of
// index.ts via string extraction + a data: URL dynamic import instead of
// importing the whole module), this file extracts the REAL guard/auth-gate
// source lines as text and either (a) asserts their relative order, or
// (b) evaluates the actual extracted boolean expression — so this test fails
// the moment the shipped source drifts from what it asserts, without ever
// executing Deno.serve or touching the network/env.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string): number {
  const i = src.indexOf(needle);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  }
  return i;
}

const idxHealthCheck = mustFind('if (body.health_check === true) {');
const idxGuard = mustFind('if (!contractor_template_id');
const idxAuthHeaderDecl = mustFind('const authHeader = req.headers.get("Authorization");');
const idxAuthHeaderCheck = mustFind('if (!authHeader?.startsWith("Bearer ")) {');
const idxGetUser = mustFind('await supabase.auth.getUser(bearerToken)');
const idxAuthErrCheck = mustFind('if (authErr || !user) {');
const idxStarterBranch = mustFind('if (body.starter === true) {');

// ─── Structural ordering: health_check → guard → auth header → getUser → auth-error check → starter branch ───

Deno.test("guard order: health_check check precedes the contractor_template_id guard", () => {
  assert(idxHealthCheck < idxGuard, "health_check must be checked before the contractor_template_id guard so the keepalive stays unauthenticated");
});

Deno.test("guard order: contractor_template_id guard precedes the Authorization header check", () => {
  assert(idxGuard < idxAuthHeaderDecl, "the guard must still run before the Auth Gate (unchanged ordering)");
});

Deno.test("guard order: Authorization header presence check precedes supabase.auth.getUser()", () => {
  assert(idxAuthHeaderDecl < idxAuthHeaderCheck && idxAuthHeaderCheck < idxGetUser);
});

Deno.test("guard order: supabase.auth.getUser() and its error check both run before the starter branch — auth cannot be bypassed", () => {
  assert(idxGetUser < idxStarterBranch, "starter branch must be reachable only after JWT verification");
  assert(idxAuthErrCheck < idxStarterBranch, "the 401-on-bad-auth check must run before the starter branch");
  assert(idxAuthErrCheck > idxGetUser);
});

// ─── The guard itself is now conditioned on body.starter, not a blind block ───

const guardLineEnd = src.indexOf("\n", idxGuard);
const guardLine = src.slice(idxGuard, guardLineEnd);

Deno.test("guard text: the guard is conditioned with body.starter !== true (the #1584 fix), not an unconditional block", () => {
  assertStringIncludes(guardLine, "body.starter !== true");
});

// ─── Extract the REAL guard boolean expression and evaluate it directly ───
// (fails if the shipped condition ever diverges from what this test checks)

const condStart = idxGuard + "if (".length;
const condEnd = src.indexOf(") {", idxGuard);
const guardExpr = src.slice(condStart, condEnd);

function evalGuard(contractor_template_id: unknown, starterFlag: unknown): boolean {
  const body = { starter: starterFlag };
  // deno-lint-ignore no-explicit-any
  const fn = new Function("contractor_template_id", "body", `return (${guardExpr});`) as any;
  return fn(contractor_template_id, body);
}

Deno.test("reachability: non-starter request without contractor_template_id is BLOCKED (guard true -> 400) — unchanged for real validation callers", () => {
  assertEquals(evalGuard(undefined, undefined), true);
  assertEquals(evalGuard(null, undefined), true);
  assertEquals(evalGuard("", undefined), true);
});

Deno.test("reachability: non-starter request WITH contractor_template_id clears the guard (unchanged)", () => {
  assertEquals(evalGuard("tmpl-123", undefined), false);
});

Deno.test("reachability: starter request WITHOUT contractor_template_id now clears the guard — the #1584 fix, matches both real callers' payload shape", () => {
  assertEquals(evalGuard(undefined, true), false);
});

Deno.test("reachability: starter request clears the guard even if contractor_template_id happens to be present", () => {
  assertEquals(evalGuard("tmpl-123", true), false);
});

Deno.test("reachability: starter flag must be exactly true — a truthy-but-not-true starter value does NOT exempt the guard", () => {
  // body.starter !== true is a strict check; "true" (string) or 1 must not bypass
  assertEquals(evalGuard(undefined, "true"), true);
  assertEquals(evalGuard(undefined, 1), true);
});

// ─── Health-check stays unauthenticated; the Auth Gate has no starter exemption ───

// Slice a fixed-size window after each anchor rather than hunting for the
// matching "}" (the object literals inside these one-line blocks contain
// their own "}" before the block's real closing brace).
const healthCheckBlock = src.slice(idxHealthCheck, idxHealthCheck + 220);

Deno.test("health-check: the health_check branch never references auth (authHeader/getUser) — 200s with no auth, as today", () => {
  assert(!healthCheckBlock.includes("authHeader"));
  assert(!healthCheckBlock.includes("getUser"));
  assertStringIncludes(healthCheckBlock, "200");
});

const authHeaderCheckBlock = src.slice(idxAuthHeaderCheck, idxAuthHeaderCheck + 160);

Deno.test("auth gate: the Authorization-header-required check has no starter exemption — a starter request WITHOUT auth is still refused (401), same as any other caller", () => {
  assert(!authHeaderCheckBlock.includes("starter"), "the Bearer-header check must not special-case body.starter — auth still runs for the starter path");
  assertStringIncludes(authHeaderCheckBlock, "401");
});

Deno.test("auth gate: getUser()'s failure path (bad/expired token) also has no starter exemption", () => {
  const authErrBlock = src.slice(idxAuthErrCheck, idxAuthErrCheck + 120);
  assert(!authErrBlock.includes("starter"));
  assertStringIncludes(authErrBlock, "401");
});
