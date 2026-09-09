// gh-1724 step 2 [SECURITY]: check-email-exists calls check_rate_limit() keyed
// on a synthetic per-IP UUID (see index.ts's file header and ipToUuid()),
// since this endpoint runs pre-auth and has no real user_id to key on. These
// tests exercise the two pure helpers that build that key -- getClientIp()
// and ipToUuid() -- extracted from index.ts the same way self-check-gate
// .test.ts extracts computeSelfCheck(): index.ts is a single-file EF with no
// exports, so the source text is read and the function bodies are grabbed
// between their signature and matching closing brace, then eval'd into real
// callables. This exercises the actual implementation, not a reimplementation
// of it.
import { assertEquals, assertMatch, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

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

// TypeScript type annotations aren't valid in the `new Function(...)` body
// below, so strip the ones a plain `(param: Type): ReturnType {` signature
// can carry. Generalized version of self-check-gate.test.ts's stripTypes --
// these two helpers have different signatures than computeSelfCheck, so the
// literal signature-string replacement there doesn't apply here.
function stripSignatureTypes(fnSrc: string): string {
  const braceIdx = fnSrc.indexOf("{");
  let sig = fnSrc.slice(0, braceIdx);
  const body = fnSrc.slice(braceIdx);
  // Drop a return-type annotation: "): Type {" -> ")" (handles Promise<string>).
  sig = sig.replace(/\)\s*:\s*[^{]+$/, ")");
  // Drop each parameter's type annotation: "name: Type" -> "name".
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

const getClientIpSrc = stripSignatureTypes(grabFunction("function getClientIp("));
const getClientIp: (req: Request) => string =
  new Function(`${getClientIpSrc}\nreturn getClientIp;`)();

// ipToUuid() closes over the module-level FUNCTION_NAME const (it namespaces
// the hash -- see index.ts's comment on ipToUuid) -- grab that declaration
// too so the eval'd copy has it in scope, rather than hardcoding the value
// here and silently drifting from index.ts if it's ever renamed.
const functionNameMatch = src.match(/const FUNCTION_NAME = "[^"]+";/);
if (!functionNameMatch) throw new Error("FUNCTION_NAME const not found in index.ts");
const functionNameDecl = functionNameMatch[0];

const ipToUuidSrc = stripSignatureTypes(grabFunction("async function ipToUuid("));
// The extracted source is itself `async function ipToUuid(ip) {...}`; the
// wrapping IIFE is also async so `new Function(...)()` returns a Promise
// that resolves to the function reference -- await it to unwrap.
const ipToUuid: (ip: string) => Promise<string> =
  await new Function(`return (async function() {\n${functionNameDecl}\n${ipToUuidSrc}\nreturn ipToUuid;\n})();`)();

function reqWithHeaders(headers: Record<string, string>): Request {
  return new Request("https://example.com/functions/v1/check-email-exists", { headers });
}

// ---- getClientIp ----

Deno.test("getClientIp: prefers cf-connecting-ip over x-forwarded-for", () => {
  const req = reqWithHeaders({
    "cf-connecting-ip": "198.51.100.9",
    "x-forwarded-for": "203.0.113.5, 10.0.0.1",
  });
  assertEquals(getClientIp(req), "198.51.100.9");
});

Deno.test("getClientIp: falls back to the first hop of x-forwarded-for when cf-connecting-ip is absent", () => {
  const req = reqWithHeaders({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
  assertEquals(getClientIp(req), "203.0.113.5");
});

Deno.test("getClientIp: falls back to \"unknown\" when neither header is present", () => {
  const req = reqWithHeaders({});
  assertEquals(getClientIp(req), "unknown");
});

// ---- ipToUuid ----

Deno.test("ipToUuid: deterministic -- same IP hashes to the same bucket every time", async () => {
  const a = await ipToUuid("198.51.100.9");
  const b = await ipToUuid("198.51.100.9");
  assertEquals(a, b);
});

Deno.test("ipToUuid: different IPs hash to different buckets", async () => {
  const a = await ipToUuid("198.51.100.9");
  const b = await ipToUuid("198.51.100.10");
  assertNotEquals(a, b);
});

Deno.test("ipToUuid: output is a syntactically well-formed UUID string", async () => {
  const id = await ipToUuid("198.51.100.9");
  assertMatch(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

Deno.test("ipToUuid: the \"unknown\" fallback bucket is itself deterministic (shared, not per-request-random)", async () => {
  const a = await ipToUuid("unknown");
  const b = await ipToUuid("unknown");
  assertEquals(a, b);
});
