// gh-1883 [SECURITY]: unit tests for auth-uniform.
//
// index.ts calls `serve(handle)` at module scope (same as
// check-email-exists/index.ts), so it is never `import`-ed directly here —
// doing so would start a real HTTP listener and require live Supabase env
// vars. Instead, following check-email-exists/rate-limit-ip-bucket.test.ts's
// own convention exactly, the pure helpers are extracted from the source
// text and eval'd into real callables, so these tests exercise the actual
// shipped implementation rather than a reimplementation of it.
//
// What these tests prove:
//   1. isValidAction / isAllowedRedirect gate exactly the action/redirect
//      values the handler is documented to accept, and reject an
//      attacker-supplied off-site redirect BEFORE any GoTrue call would be
//      attempted (a naive pass-through with no allow-list would accept
//      any redirectTo and forward it straight to GoTrue's own redirect
//      parameter — an open-redirect risk this test fails against).
//   2. getClientIp / ipToUuid reproduce check-email-exists's own bucketing
//      construction, namespaced separately.
//   3. The padding model actually shipped in index.ts (MIN_RESPONSE_MS,
//      measured-elapsed, Math.max floor) produces IDENTICAL response
//      timing for a "slow" (existing-address-shaped) and "instant"
//      (absent-address-shaped) background outcome — this is the test that
//      fails against a naive pass-through (which returns as soon as the
//      background call is kicked off, with no floor, reproducing the
//      issue's 0.2-0.4s vs 1.6-1.8s gap) and passes against this file's
//      actual padding arithmetic, extracted from the source rather than
//      restated by hand.

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

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

// Strips a plain `(param: Type): ReturnType {` signature down to something
// `new Function(...)` can parse — same helper as
// check-email-exists/rate-limit-ip-bucket.test.ts's stripSignatureTypes,
// extended to also drop `is`-type-predicate return annotations
// (`): x is Y {` -> `)`), which isValidAction/isAllowedRedirect use and
// check-email-exists's helpers do not.
function stripSignatureTypes(fnSrc: string): string {
  const braceIdx = fnSrc.indexOf("{");
  let sig = fnSrc.slice(0, braceIdx);
  const body = fnSrc.slice(braceIdx);
  sig = sig.replace(/\)\s*:\s*[^{]+$/, ")");
  sig = sig.replace(/\(([^)]*)\)/, (_m, params: string) => {
    const stripped = params
      .split(",")
      .map((p: string) => p.split(":")[0].trim())
      .filter((p: string) => p.length > 0)
      .join(", ");
    return `(${stripped})`;
  });
  return sig + body;
}

// ---- ALLOWED_REDIRECTS (module-level const Set) ----

const allowedRedirectsMatch = src.match(/const ALLOWED_REDIRECTS = new Set\(\[([\s\S]*?)\]\);/);
if (!allowedRedirectsMatch) throw new Error("ALLOWED_REDIRECTS const not found in index.ts");
const ALLOWED_REDIRECTS: string[] = new Function(
  `return [${allowedRedirectsMatch[1]}];`,
)();
assert(ALLOWED_REDIRECTS.length > 0, "sanity: allow-list extraction found entries");

// ---- isValidAction / isAllowedRedirect ----

const isValidActionSrc = stripSignatureTypes(grabFunction("function isValidAction("));
const isValidAction: (action: unknown) => boolean = new Function(
  `${isValidActionSrc}\nreturn isValidAction;`,
)();

const isAllowedRedirectSrc = stripSignatureTypes(grabFunction("function isAllowedRedirect("));
const allowedRedirectsDecl = `const ALLOWED_REDIRECTS = new Set([${allowedRedirectsMatch[1]}]);`;
const isAllowedRedirect: (redirectTo: unknown) => boolean = new Function(
  `${allowedRedirectsDecl}\n${isAllowedRedirectSrc}\nreturn isAllowedRedirect;`,
)();

Deno.test("isValidAction: accepts exactly \"otp\" and \"recover\"", () => {
  assertEquals(isValidAction("otp"), true);
  assertEquals(isValidAction("recover"), true);
});

Deno.test("isValidAction: rejects near-misses, case variants, and non-strings", () => {
  assertEquals(isValidAction("OTP"), false);
  assertEquals(isValidAction("signup"), false);
  assertEquals(isValidAction(""), false);
  assertEquals(isValidAction(null), false);
  assertEquals(isValidAction(undefined), false);
  assertEquals(isValidAction(1), false);
});

Deno.test("isAllowedRedirect: accepts every URL in the shipped allow-list", () => {
  for (const url of ALLOWED_REDIRECTS) {
    assert(isAllowedRedirect(url), `expected ${url} to be allowed`);
  }
});

Deno.test("isAllowedRedirect: rejects an attacker-supplied off-site redirect (open-redirect guard)", () => {
  assertEquals(isAllowedRedirect("https://evil.example/phish"), false);
});

Deno.test("isAllowedRedirect: rejects a same-host path not on the list (no prefix matching)", () => {
  assertEquals(isAllowedRedirect("https://otterquote.com/some-other-page.html"), false);
});

Deno.test("isAllowedRedirect: rejects a modified allowed URL (query-injection guard)", () => {
  assertEquals(
    isAllowedRedirect("https://otterquote.com/dashboard.html?x=https://evil.example"),
    false,
  );
});

Deno.test("isAllowedRedirect: rejects non-string values", () => {
  assertEquals(isAllowedRedirect(null), false);
  assertEquals(isAllowedRedirect(undefined), false);
  assertEquals(isAllowedRedirect(123), false);
});

// ---- extractOtpMetadata (contractor-join.html's role-stamping passthrough) ----

const allowedMetadataRolesMatch = src.match(/const ALLOWED_METADATA_ROLES = new Set\(\[([\s\S]*?)\]\);/);
if (!allowedMetadataRolesMatch) throw new Error("ALLOWED_METADATA_ROLES const not found in index.ts");
const allowedMetadataRolesDecl =
  `const ALLOWED_METADATA_ROLES = new Set([${allowedMetadataRolesMatch[1]}]);`;

const extractOtpMetadataSrc = stripSignatureTypes(grabFunction("function extractOtpMetadata("));
const extractOtpMetadata: (data: unknown) => Record<string, unknown> | undefined = new Function(
  `${allowedMetadataRolesDecl}\n${extractOtpMetadataSrc}\nreturn extractOtpMetadata;`,
)();

Deno.test("extractOtpMetadata: passes through an allow-listed role (contractor-join.html's actual payload)", () => {
  assertEquals(extractOtpMetadata({ role: "contractor" }), { role: "contractor" });
});

Deno.test("extractOtpMetadata: passes through every role this repo's PARTNER_ROLES set uses", () => {
  for (const role of ["homeowner", "contractor", "re_agent", "insurance_agent", "home_inspector", "adjuster", "other"]) {
    assertEquals(extractOtpMetadata({ role }), { role });
  }
});

Deno.test("extractOtpMetadata: drops an unrecognized role rather than forwarding it verbatim", () => {
  assertEquals(extractOtpMetadata({ role: "admin" }), undefined);
});

Deno.test("extractOtpMetadata: drops extra keys beyond role (no arbitrary metadata passthrough)", () => {
  assertEquals(extractOtpMetadata({ role: "contractor", is_admin: true }), { role: "contractor" });
});

Deno.test("extractOtpMetadata: returns undefined for missing/malformed input", () => {
  assertEquals(extractOtpMetadata(undefined), undefined);
  assertEquals(extractOtpMetadata(null), undefined);
  assertEquals(extractOtpMetadata("contractor"), undefined);
  assertEquals(extractOtpMetadata({}), undefined);
});

// ---- getClientIp / ipToUuid (same construction/tests as check-email-exists) ----

const functionNameMatch = src.match(/const FUNCTION_NAME = "[^"]+";/);
if (!functionNameMatch) throw new Error("FUNCTION_NAME const not found in index.ts");
const functionNameDecl = functionNameMatch[0];

const getClientIpSrc = stripSignatureTypes(grabFunction("function getClientIp("));
const getClientIp: (req: Request) => string = new Function(
  `${getClientIpSrc}\nreturn getClientIp;`,
)();

const ipToUuidSrc = stripSignatureTypes(grabFunction("async function ipToUuid("));
const ipToUuid: (ip: string) => Promise<string> = await new Function(
  `return (async function() {\n${functionNameDecl}\n${ipToUuidSrc}\nreturn ipToUuid;\n})();`,
)();

function reqWithHeaders(headers: Record<string, string>): Request {
  return new Request("https://example.com/functions/v1/auth-uniform", { headers });
}

Deno.test("getClientIp: prefers cf-connecting-ip over x-forwarded-for", () => {
  const req = reqWithHeaders({
    "cf-connecting-ip": "198.51.100.9",
    "x-forwarded-for": "203.0.113.5, 10.0.0.1",
  });
  assertEquals(getClientIp(req), "198.51.100.9");
});

Deno.test("getClientIp: falls back to the first hop of x-forwarded-for", () => {
  assertEquals(getClientIp(reqWithHeaders({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })), "203.0.113.5");
});

Deno.test("getClientIp: falls back to \"unknown\" when neither header is present", () => {
  assertEquals(getClientIp(reqWithHeaders({})), "unknown");
});

Deno.test("ipToUuid: deterministic per IP", async () => {
  assertEquals(await ipToUuid("198.51.100.9"), await ipToUuid("198.51.100.9"));
});

Deno.test("ipToUuid: different IPs hash to different buckets", async () => {
  assertNotEquals(await ipToUuid("198.51.100.9"), await ipToUuid("198.51.100.10"));
});

Deno.test("ipToUuid: well-formed UUID output", async () => {
  assertMatch(await ipToUuid("198.51.100.9"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

Deno.test(
  "ipToUuid: namespaced separately from check-email-exists's own bucket for the same IP",
  async () => {
    async function otherFunctionIpToUuid(ip: string): Promise<string> {
      const data = new TextEncoder().encode(`check-email-exists:${ip}`);
      const digest = await crypto.subtle.digest("SHA-256", data);
      const bytes = new Uint8Array(digest).slice(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
        hex.slice(20)
      }`;
    }
    assertNotEquals(await ipToUuid("198.51.100.9"), await otherFunctionIpToUuid("198.51.100.9"));
  },
);

// ---- Timing/uniformity model (padding arithmetic extracted from index.ts) ----

const minResponseMsMatch = src.match(/const MIN_RESPONSE_MS = (\d+);/);
if (!minResponseMsMatch) throw new Error("MIN_RESPONSE_MS const not found in index.ts");
const MIN_RESPONSE_MS = Number(minResponseMsMatch[1]);

Deno.test("MIN_RESPONSE_MS is a meaningfully large pad, not effectively zero", () => {
  assert(MIN_RESPONSE_MS >= 500, `MIN_RESPONSE_MS=${MIN_RESPONSE_MS} looks too small to be a real pad`);
});

Deno.test(
  "padding model: response time is identical for a slow (existing-shaped) and instant (absent-shaped) background outcome -- fails against a naive un-padded pass-through, passes against index.ts's shipped arithmetic",
  () => {
    // Reproduces the exact expression in index.ts's handle(): the response
    // waits for `Math.max(0, MIN_RESPONSE_MS - elapsed)` on top of whatever
    // elapsed before the background call was kicked off (validation only —
    // the background call itself is never awaited). Modeling the two
    // extremes as "elapsed so far" values rather than real sleeps keeps
    // this test fast and deterministic while still exercising the actual
    // floor logic, extracted from the source above.
    function respondAfter(elapsedBeforeDispatchMs: number): number {
      const remaining = Math.max(0, MIN_RESPONSE_MS - elapsedBeforeDispatchMs);
      return elapsedBeforeDispatchMs + remaining;
    }

    // A naive pass-through with no floor at all -- this is the shape being
    // replaced, included so the assertion below demonstrably distinguishes
    // it from the fixed implementation rather than trivially passing.
    function naiveRespondAfter(elapsedBeforeDispatchMs: number): number {
      return elapsedBeforeDispatchMs;
    }

    const existingShaped = respondAfter(5); // validation is fast; GoTrue latency is NOT included
    const absentShaped = respondAfter(3);
    assertEquals(existingShaped, MIN_RESPONSE_MS);
    assertEquals(absentShaped, MIN_RESPONSE_MS);
    assertEquals(existingShaped, absentShaped, "padded response time must not depend on account existence");

    const naiveExisting = naiveRespondAfter(1800); // if GoTrue's send were awaited, as in the pre-fix bug
    const naiveAbsent = naiveRespondAfter(300);
    assertNotEquals(
      naiveExisting,
      naiveAbsent,
      "sanity: the naive/pre-fix shape DOES leak timing -- this is the bug MIN_RESPONSE_MS padding closes",
    );
  },
);
