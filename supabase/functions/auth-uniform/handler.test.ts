// gh-1883 REVIEW FOLLOW-UP (must-fix 3, comment 5857851132): a
// handler-level test that runs the ACTUAL `handle()` request handler
// shipped in index.ts, with the network boundary (GoTrue's `signInWithOtp`
// / `resetPasswordForEmail` / the `check_rate_limit` RPC / the
// platform_alerts_log insert) stubbed -- the same shape of harness the
// independent review used ("imports the real handle() with fetch
// stubbed"). index.test.ts's existing tests only exercise the extracted
// pure helpers (isAllowedRedirect, getClientIp, the padding arithmetic in
// isolation), each in total isolation; none of them call `handle()`
// itself, which is exactly why must-fix 1 (a real caller target rejected)
// was not caught by the shipped suite even though `isAllowedRedirect` was
// itself unit-tested against the (incomplete) allow-list.
//
// Same constraint and convention as index.test.ts: index.ts calls
// `serve(handle)` at module scope, so it can't be `import`-ed directly
// (that would start a real HTTP listener needing live env vars). This
// extracts `handle()` and everything it transitively calls from the real
// source text, same as index.test.ts's isAllowedRedirect/getClientIp
// extraction, but goes one step further: rather than only stubbing
// `createClient`, it ALSO passes a stub `Deno` object into the generated
// function's scope (shadowing the real global) so `Deno.env.get(...)`
// calls inside `handle()`/`dispatchAuthCall()` never touch the real
// permission-gated API. This matters for CI specifically: the shipped
// workflow runs `deno test --allow-read=... supabase/functions/` with NO
// `--allow-env`, so a version of this test that let the real
// `Deno.env.get` execute (or that wrote a temp file, requiring
// `--allow-write`) would pass locally and then fail in CI for a permission
// reason unrelated to the auth-uniform logic being tested -- exactly the
// failure this file's own first draft hit before being rewritten this way
// (see git history on this file).

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

// Splits a parameter list on top-level commas ONLY -- unlike a bare
// `.split(",")`, this does not break apart a generic type argument list
// like `Record<string, unknown>` (index.test.ts's own stripSignatureTypes
// never needed this: none of the functions it extracts have a
// comma-containing generic in a parameter type; dispatchAuthCall here
// does -- `otpMetadata: Record<string, unknown> | undefined` -- and a bare
// split silently produced a bogus extra "parameter" from the tail half).
function splitTopLevel(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of params) {
    if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

// Same as index.test.ts's stripSignatureTypes -- strips the OUTER
// signature's param/return type annotations.
function stripSignatureTypes(fnSrc: string): string {
  const braceIdx = fnSrc.indexOf("{");
  let sig = fnSrc.slice(0, braceIdx);
  const body = fnSrc.slice(braceIdx);
  sig = sig.replace(/\)\s*:\s*[^{]+$/, ")");
  sig = sig.replace(/\(([^)]*)\)/, (_m, params: string) => {
    const stripped = splitTopLevel(params)
      .map((p: string) => p.split(":")[0].trim())
      .filter((p: string) => p.length > 0)
      .join(", ");
    return `(${stripped})`;
  });
  return sig + body;
}

// index.ts's handle()/dispatchAuthCall() (unlike the leaf helpers
// index.test.ts already extracts) declare typed LOCAL variables
// (`let errorMessage: string | undefined;`, `let action: unknown;`, etc.)
// -- stripSignatureTypes only touches the function's own signature, not
// its body, so those need their own pass: strip a type annotation off any
// bare `let NAME: TYPE` / `const NAME: TYPE` declaration (never touches a
// destructuring pattern like `const { data: x } = ...`, since that doesn't
// match `(let|const) IDENT :` immediately).
function stripBodyLocalTypes(bodySrc: string): string {
  return bodySrc.replace(
    /\b(let|const)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+(?=[=;\n])/g,
    "$1 $2",
  );
}

function extractFn(signatureMarker: string): string {
  return stripBodyLocalTypes(stripSignatureTypes(grabFunction(signatureMarker)));
}

function constArray(name: string): string {
  const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`${name} const not found in index.ts`);
  return m[1];
}
function constSet(name: string): string {
  const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!m) throw new Error(`${name} const not found in index.ts`);
  return m[1];
}
function constScalar(name: string): string {
  const m = src.match(new RegExp(`const ${name} = ([^;\\n]+);`));
  if (!m) throw new Error(`${name} const not found in index.ts`);
  return m[1];
}
function originPathsBody(): string {
  const m = src.match(/const REDIRECT_ORIGIN_PATHS: Record<string, Set<string>> = \{([\s\S]*?)\};/);
  if (!m) throw new Error("REDIRECT_ORIGIN_PATHS const not found in index.ts");
  return m[1];
}

const declsScript = `
  const ALLOWED_ORIGINS = [${constArray("ALLOWED_ORIGINS")}];
  const REDIRECT_STATIC_PATHS = new Set([${constSet("REDIRECT_STATIC_PATHS")}]);
  const REDIRECT_REACT_PATHS = new Set([${constSet("REDIRECT_REACT_PATHS")}]);
  const REDIRECT_LOCALHOST_PATHS = new Set([${constSet("REDIRECT_LOCALHOST_PATHS")}]);
  const REDIRECT_ORIGIN_PATHS = {${originPathsBody()}};
  const FUNCTION_NAME = ${constScalar("FUNCTION_NAME")};
  const MIN_RESPONSE_MS = ${constScalar("MIN_RESPONSE_MS")};
  const EMAIL_RE = ${constScalar("EMAIL_RE")};
  const ALLOWED_METADATA_ROLES = new Set([${constSet("ALLOWED_METADATA_ROLES")}]);
`;

const fnsScript = [
  extractFn("function extractOtpMetadata("),
  extractFn("function buildCorsHeaders("),
  extractFn("function json("),
  extractFn("function sleep("),
  extractFn("async function dispatchAuthCall("),
  extractFn("async function alertBackgroundAuthFailure("),
  extractFn("function getClientIp("),
  extractFn("async function ipToUuid("),
  extractFn("function isValidAction("),
  extractFn("function isAllowedRedirect("),
  extractFn("async function handle("),
].join("\n\n");

// ---- Scenario-driven stubs for createClient AND Deno (shadows the real
// global inside the generated function's scope, so handle()'s
// `Deno.env.get(...)` calls never hit the actual permission-gated API --
// this test needs no --allow-env, matching the CI workflow's actual grant
// (`--allow-read=... `, nothing else) exactly. ----

interface Scenario {
  rateLimited: boolean;
  gotrueDelayMs: number;
  gotrueError: { message: string } | null;
  alertInserts: Array<Record<string, unknown>>;
  rpcCalls: number;
}

function freshScenario(): Scenario {
  return { rateLimited: false, gotrueDelayMs: 0, gotrueError: null, alertInserts: [], rpcCalls: 0 };
}

function sleepReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCreateClient(scenario: Scenario) {
  return function createClient(_url: string, _key: string, _opts?: unknown) {
    return {
      auth: {
        async signInWithOtp(_args: unknown) {
          await sleepReal(scenario.gotrueDelayMs);
          return { error: scenario.gotrueError };
        },
        async resetPasswordForEmail(_email: string, _args: unknown) {
          await sleepReal(scenario.gotrueDelayMs);
          return { error: scenario.gotrueError };
        },
      },
      async rpc(_name: string, _params: unknown) {
        scenario.rpcCalls++;
        if (scenario.rateLimited) return { data: { allowed: false, reason: "burst limit" }, error: null };
        return { data: { allowed: true }, error: null };
      },
      from(_table: string) {
        return {
          insert: async (row: Record<string, unknown>) => {
            scenario.alertInserts.push(row);
            return { error: null };
          },
        };
      },
    };
  };
}

// A minimal stand-in for the real `Deno` global -- only `.env.get` is
// exercised by the extracted code, and every value it returns is unused by
// the stub `createClient` above anyway (it ignores its url/key args).
const fakeDeno = { env: { get: (_name: string) => undefined } };

function buildHandle(scenario: Scenario): (req: Request) => Promise<Response> {
  const factory = new Function(
    "createClient",
    "Deno",
    `${declsScript}\n${fnsScript}\nreturn handle;`,
  );
  return factory(makeCreateClient(scenario), fakeDeno);
}

function postReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/functions/v1/auth-uniform", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const EXISTING_BODY = {
  action: "otp",
  email: "existing@otterquote-internal.test",
  redirectTo: "https://otterquote.com/auth-callback.html",
};

// ---- 1. Uniform response: existing vs. absent, otp and recover ----

Deno.test(
  "handle(): existing vs. absent address -- identical status, body, and headers, both >= MIN_RESPONSE_MS",
  async () => {
    for (const action of ["otp", "recover"] as const) {
      const existingScenario = freshScenario();
      existingScenario.gotrueDelayMs = 1800; // existing-address-shaped: slow inline send
      const absentScenario = freshScenario();
      absentScenario.gotrueDelayMs = 50; // absent-address-shaped: fast rejection
      absentScenario.gotrueError = { message: "otp_disabled" };

      const handleExisting = buildHandle(existingScenario);
      const handleAbsent = buildHandle(absentScenario);

      const t0 = performance.now();
      const resExisting = await handleExisting(
        postReq({ ...EXISTING_BODY, action }, { "x-forwarded-for": "203.0.113.10" }),
      );
      const tExisting = performance.now() - t0;

      const t1 = performance.now();
      const resAbsent = await handleAbsent(
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
      assert(
        tExisting < 1500,
        `[${action}] existing-address response took ${tExisting}ms -- looks awaited, not backgrounded`,
      );
    }
  },
);

// ---- 2. Error paths: fast, unpadded, and account-independent ----

Deno.test("handle(): a disallowed redirect returns 400 fast, unpadded (not the 800ms floor)", async () => {
  const scenario = freshScenario();
  const handle = buildHandle(scenario);
  const t0 = performance.now();
  const res = await handle(postReq({ action: "otp", email: "a@b.com", redirectTo: "https://evil.example/phish" }));
  const elapsed = performance.now() - t0;
  assertEquals(res.status, 400);
  assert(elapsed < 200, `expected a fast unpadded rejection, took ${elapsed}ms`);
  assertEquals(scenario.rpcCalls, 1, "rate limit check still runs before body validation");
});

Deno.test("handle(): missing/invalid email returns 400 fast, unpadded", async () => {
  const handle = buildHandle(freshScenario());
  const t0 = performance.now();
  const res = await handle(postReq({ action: "otp", email: "not-an-email" }));
  const elapsed = performance.now() - t0;
  assertEquals(res.status, 400);
  assert(elapsed < 200, `expected a fast unpadded rejection, took ${elapsed}ms`);
});

Deno.test("handle(): a rate-limited caller gets an immediate, unpadded 429", async () => {
  const scenario = freshScenario();
  scenario.rateLimited = true;
  const handle = buildHandle(scenario);
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
    const scenario = freshScenario();
    scenario.gotrueDelayMs = 10;
    scenario.gotrueError = { message: "over_request_rate_limit: rate limit exceeded" };
    const handle = buildHandle(scenario);

    const res = await handle(postReq(EXISTING_BODY));
    assertEquals(res.status, 200); // caller still sees the uniform success

    // The background task isn't awaited by handle() itself -- give it a
    // moment to finish (10ms GoTrue delay + async plumbing), same as
    // `EdgeRuntime.waitUntil`'s absence here requires (see index.ts's
    // fire-and-forget fallback comment).
    await sleepReal(150);

    assertEquals(scenario.alertInserts.length, 1, "expected exactly one alert row");
    assertEquals(scenario.alertInserts[0].function_name, "auth-uniform");
    assertEquals(scenario.alertInserts[0].alert_type, "auth_uniform_rate_limited");
    assert(
      !JSON.stringify(scenario.alertInserts[0]).includes("existing@otterquote-internal.test"),
      "alert row must never include the caller's email address",
    );
  },
);

Deno.test(
  "handle(): a non-rate-limit background failure writes a send-failed alert, not a rate-limit one",
  async () => {
    const scenario = freshScenario();
    scenario.gotrueDelayMs = 10;
    scenario.gotrueError = { message: "smtp connection refused" };
    const handle = buildHandle(scenario);

    await handle(postReq(EXISTING_BODY));
    await sleepReal(150);

    assertEquals(scenario.alertInserts.length, 1);
    assertEquals(scenario.alertInserts[0].alert_type, "auth_uniform_send_failed");
  },
);

Deno.test("handle(): a successful background call writes no alert row", async () => {
  const scenario = freshScenario();
  scenario.gotrueDelayMs = 10;
  const handle = buildHandle(scenario);

  await handle(postReq(EXISTING_BODY));
  await sleepReal(150);

  assertEquals(scenario.alertInserts.length, 0);
});
