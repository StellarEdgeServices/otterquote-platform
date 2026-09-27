// gh-1883 REVIEW FOLLOW-UP (must-fix 3, comment 5857851132): a
// handler-level test that runs the ACTUAL `handle()` request handler
// shipped in index.ts, with the network boundary (GoTrue's `signInWithOtp`
// / `resetPasswordForEmail` / the `check_rate_limit` RPC / the
// platform_alerts_log insert) stubbed -- the same shape of harness the
// independent review used ("imports the real handle() with fetch
// stubbed"). index.test.ts's existing tests only exercise the extracted
// pure helpers (isAllowedRedirect, getClientIp, the padding arithmetic in
// isolation) in total isolation from each other; none of them call
// `handle()` itself, which is exactly why must-fix 1 (a real caller target
// rejected) was not caught by the shipped suite even though
// `isAllowedRedirect` was itself unit-tested against the (incomplete)
// allow-list.
//
// Same constraint as index.test.ts: index.ts calls `serve(handle)` at
// module scope, so it can't be `import`-ed directly (that would start a
// real HTTP listener needing live env vars). Rather than re-implement
// index.test.ts's "eval the stripped source as untyped JS" extraction (that
// approach breaks the moment a function has a single typed local variable,
// which several of these now do), this test slices out the real,
// UNMODIFIED TypeScript source for `handle()` and everything it calls,
// splices in a stub `createClient`, writes the result to a temp `.ts` file
// next to this one, and dynamically `import()`s it -- so Deno's own
// TypeScript transpiler does the type-erasure, not a hand-rolled regex.
// This still never touches the network: nothing here executes `serve()`
// or the real `@supabase/supabase-js` import, because the generated module
// defines its own local `createClient` instead of importing it.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function grabFunction(signatureMarker: string): string {
  const start = src.indexOf(signatureMarker);
  if (start === -1) throw new Error(`not found: ${signatureMarker}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced: ${signatureMarker}`);
}

function grabWholeMatch(pattern: RegExp, label: string): string {
  const m = src.match(pattern);
  if (!m) throw new Error(`${label} not found in index.ts`);
  return m[0];
}

// ---- Slice every real declaration handle() transitively needs, verbatim ----

const declSlices = [
  grabWholeMatch(/declare const EdgeRuntime:[^\n]+;/, "EdgeRuntime declare"),
  grabWholeMatch(/const ALLOWED_ORIGINS = \[[\s\S]*?\];/, "ALLOWED_ORIGINS"),
  grabWholeMatch(/const REDIRECT_STATIC_PATHS = new Set\(\[[\s\S]*?\]\);/, "REDIRECT_STATIC_PATHS"),
  grabWholeMatch(/const REDIRECT_REACT_PATHS = new Set\(\[[\s\S]*?\]\);/, "REDIRECT_REACT_PATHS"),
  grabWholeMatch(/const REDIRECT_LOCALHOST_PATHS = new Set\(\[[\s\S]*?\]\);/, "REDIRECT_LOCALHOST_PATHS"),
  grabWholeMatch(
    /const REDIRECT_ORIGIN_PATHS: Record<string, Set<string>> = \{[\s\S]*?\};/,
    "REDIRECT_ORIGIN_PATHS",
  ),
  grabWholeMatch(/const FUNCTION_NAME = "[^"]+";/, "FUNCTION_NAME"),
  grabWholeMatch(/const MIN_RESPONSE_MS = \d+;/, "MIN_RESPONSE_MS"),
  grabWholeMatch(/const EMAIL_RE = [^;]+;/, "EMAIL_RE"),
  grabWholeMatch(/const ALLOWED_METADATA_ROLES = new Set\(\[[\s\S]*?\]\);/, "ALLOWED_METADATA_ROLES"),
];

const fnSlices = [
  "function extractOtpMetadata(",
  "function buildCorsHeaders(",
  "function json(",
  "function sleep(",
  "async function dispatchAuthCall(",
  "async function alertBackgroundAuthFailure(",
  "function getClientIp(",
  "async function ipToUuid(",
  "function isValidAction(",
  "function isAllowedRedirect(",
  "async function handle(",
].map(grabFunction);

// ---- Stub createClient + the module-local counters the test reads back ----
//
// Scenario knobs are read from Deno.env at import time (set just before
// each dynamic import below) rather than closed over, since the generated
// file is a standalone module reached via `import()`, not a `new
// Function()` closure.
const STUB_HEADER = `
// ---- GENERATED FOR handler.test.ts -- DO NOT EDIT index.ts FROM HERE ----
// Stub in place of "https://esm.sh/@supabase/supabase-js@2.114.0"'s
// createClient. Reads scenario knobs from env vars this test sets just
// before importing this generated file.
const __scenarioRateLimited = Deno.env.get("__AU_TEST_RATE_LIMITED") === "1";
const __scenarioDelayMs = Number(Deno.env.get("__AU_TEST_GOTRUE_DELAY_MS") || "0");
const __scenarioErrorMessage = Deno.env.get("__AU_TEST_GOTRUE_ERROR") || "";

export const __alertInserts: Record<string, unknown>[] = [];
export let __rpcCalls = 0;

function __sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(_url: string, _key: string, _opts?: unknown) {
  return {
    auth: {
      async signInWithOtp(_args: unknown) {
        await __sleep(__scenarioDelayMs);
        return { error: __scenarioErrorMessage ? { message: __scenarioErrorMessage } : null };
      },
      async resetPasswordForEmail(_email: string, _args: unknown) {
        await __sleep(__scenarioDelayMs);
        return { error: __scenarioErrorMessage ? { message: __scenarioErrorMessage } : null };
      },
    },
    async rpc(_name: string, _params: unknown) {
      __rpcCalls++;
      if (__scenarioRateLimited) return { data: { allowed: false, reason: "burst limit" }, error: null };
      return { data: { allowed: true }, error: null };
    },
    from(_table: string) {
      return {
        insert: async (row: Record<string, unknown>) => {
          __alertInserts.push(row);
          return { error: null };
        },
      };
    },
  };
}
// ---- end generated stub, real (unmodified) index.ts declarations follow ----
`;

const generatedSource = STUB_HEADER + "\n" + declSlices.join("\n") + "\n\n" + fnSlices.join("\n\n") +
  "\n\nexport { handle };\n";

const genPath = new URL(`./.generated-handler-${crypto.randomUUID()}.ts`, import.meta.url);
await Deno.writeTextFile(genPath, generatedSource);

interface HandlerModule {
  handle: (req: Request) => Promise<Response>;
  __alertInserts: Record<string, unknown>[];
  __rpcCalls: number;
}

async function loadHandle(scenario: {
  rateLimited?: boolean;
  gotrueDelayMs?: number;
  gotrueError?: string;
}): Promise<HandlerModule> {
  if (scenario.rateLimited) Deno.env.set("__AU_TEST_RATE_LIMITED", "1");
  else Deno.env.delete("__AU_TEST_RATE_LIMITED");
  Deno.env.set("__AU_TEST_GOTRUE_DELAY_MS", String(scenario.gotrueDelayMs ?? 0));
  if (scenario.gotrueError) Deno.env.set("__AU_TEST_GOTRUE_ERROR", scenario.gotrueError);
  else Deno.env.delete("__AU_TEST_GOTRUE_ERROR");

  // A fresh query-string cache-buster forces a fresh module instantiation
  // (and therefore fresh __alertInserts/__rpcCalls) per call, since Deno
  // caches ES module imports by resolved URL.
  const mod = await import(`${genPath.href}?t=${Date.now()}_${Math.random()}`);
  return mod as HandlerModule;
}

function postReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/functions/v1/auth-uniform", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function sleepReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EXISTING_BODY = {
  action: "otp",
  email: "existing@otterquote-internal.test",
  redirectTo: "https://otterquote.com/auth-callback.html",
};

try {
  // ---- 1. Uniform response: existing vs. absent, otp and recover ----

  Deno.test(
    "handle(): existing vs. absent address -- identical status, body, and headers, both >= MIN_RESPONSE_MS",
    async () => {
      for (const action of ["otp", "recover"] as const) {
        const existing = await loadHandle({ gotrueDelayMs: 1800 }); // existing-address-shaped: slow inline send
        const absent = await loadHandle({ gotrueDelayMs: 50, gotrueError: "otp_disabled" }); // absent-shaped: fast rejection

        const t0 = performance.now();
        const resExisting = await existing.handle(
          postReq({ ...EXISTING_BODY, action }, { "x-forwarded-for": "203.0.113.10" }),
        );
        const tExisting = performance.now() - t0;

        const t1 = performance.now();
        const resAbsent = await absent.handle(
          postReq(
            { ...EXISTING_BODY, action, email: "absent@otterquote-internal.test" },
            { "x-forwarded-for": "203.0.113.11" },
          ),
        );
        const tAbsent = performance.now() - t1;

        assertEquals(resExisting.status, resAbsent.status, `[${action}] status must be identical`);
        assertEquals(resExisting.status, 200);

        const bodyExisting = await resExisting.json();
        const bodyAbsent = await resAbsent.json();
        assertEquals(bodyExisting, bodyAbsent, `[${action}] body must be identical`);
        assertEquals(bodyExisting, {});

        for (const h of ["content-type", "access-control-allow-origin", "vary"]) {
          assertEquals(
            resExisting.headers.get(h),
            resAbsent.headers.get(h),
            `[${action}] header "${h}" must be identical`,
          );
        }

        assert(tExisting >= 800, `[${action}] existing-address response took ${tExisting}ms, expected >= 800ms floor`);
        assert(tAbsent >= 800, `[${action}] absent-address response took ${tAbsent}ms, expected >= 800ms floor`);
        // The 1800ms GoTrue delay did NOT make the response take ~1800ms --
        // proof the background call is not awaited on the response path.
        assert(tExisting < 1500, `[${action}] existing-address response took ${tExisting}ms -- looks awaited, not backgrounded`);
      }
    },
  );

  // ---- 2. Error paths: fast, unpadded, and account-independent ----

  Deno.test("handle(): a disallowed redirect returns 400 fast, unpadded (not the 800ms floor)", async () => {
    const mod = await loadHandle({});
    const t0 = performance.now();
    const res = await mod.handle(postReq({ action: "otp", email: "a@b.com", redirectTo: "https://evil.example/phish" }));
    const elapsed = performance.now() - t0;
    assertEquals(res.status, 400);
    assert(elapsed < 200, `expected a fast unpadded rejection, took ${elapsed}ms`);
    assertEquals(mod.__rpcCalls, 1, "rate limit check still runs before body validation");
  });

  Deno.test("handle(): missing/invalid email returns 400 fast, unpadded", async () => {
    const { handle } = await loadHandle({});
    const t0 = performance.now();
    const res = await handle(postReq({ action: "otp", email: "not-an-email" }));
    const elapsed = performance.now() - t0;
    assertEquals(res.status, 400);
    assert(elapsed < 200, `expected a fast unpadded rejection, took ${elapsed}ms`);
  });

  Deno.test("handle(): a rate-limited caller gets an immediate, unpadded 429", async () => {
    const { handle } = await loadHandle({ rateLimited: true });
    const t0 = performance.now();
    const res = await handle(postReq(EXISTING_BODY));
    const elapsed = performance.now() - t0;
    assertEquals(res.status, 429);
    assert(elapsed < 200, `expected a fast unpadded 429, took ${elapsed}ms`);
  });

  // ---- 3. must-fix 4: a background GoTrue failure must leave an alert row ----

  Deno.test(
    "handle(): a background rate-limit failure from GoTrue writes a platform_alerts_log row (must-fix 4 -- was previously silent)",
    async () => {
      const mod = await loadHandle({ gotrueDelayMs: 10, gotrueError: "over_request_rate_limit: rate limit exceeded" });
      const res = await mod.handle(postReq(EXISTING_BODY));
      assertEquals(res.status, 200); // caller still sees the uniform success

      // The background task isn't awaited by handle() itself -- give it a
      // moment to finish (10ms GoTrue delay + async plumbing), same as
      // `EdgeRuntime.waitUntil`'s absence here requires (see index.ts's
      // fire-and-forget fallback comment).
      await sleepReal(150);

      assertEquals(mod.__alertInserts.length, 1, "expected exactly one alert row");
      assertEquals(mod.__alertInserts[0].function_name, "auth-uniform");
      assertEquals(mod.__alertInserts[0].alert_type, "auth_uniform_rate_limited");
      assert(
        !JSON.stringify(mod.__alertInserts[0]).includes("existing@otterquote-internal.test"),
        "alert row must never include the caller's email address",
      );
    },
  );

  Deno.test(
    "handle(): a non-rate-limit background failure writes a send-failed alert, not a rate-limit one",
    async () => {
      const mod = await loadHandle({ gotrueDelayMs: 10, gotrueError: "smtp connection refused" });
      await mod.handle(postReq(EXISTING_BODY));
      await sleepReal(150);
      assertEquals(mod.__alertInserts.length, 1);
      assertEquals(mod.__alertInserts[0].alert_type, "auth_uniform_send_failed");
    },
  );

  Deno.test("handle(): a successful background call writes no alert row", async () => {
    const mod = await loadHandle({ gotrueDelayMs: 10 });
    await mod.handle(postReq(EXISTING_BODY));
    await sleepReal(150);
    assertEquals(mod.__alertInserts.length, 0);
  });
} finally {
  // Best-effort cleanup of the generated temp module and the env knobs it read.
  addEventListener("unload", () => {
    try {
      Deno.removeSync(genPath);
    } catch { /* already gone / never created */ }
  });
}
