// gh-1331 — GA4 Data API read path.
//
// The Doppler field-swap detector, the JWT-encoding primitives, and the
// metric/date input-validation regexes live in a single-file EF
// (ga4-report/index.ts) with no exports, so this test extracts them from the
// source the same way parse-hover-measurements/parse-roof-summary.test.ts and
// create-docusign-envelope/exhibit-a-shapes.test.ts do. That keeps the
// production file's public shape (one default-exported handler) unchanged
// and still exercises the real implementations.
//
// Deliberately does NOT exercise mintAccessToken, the runReport fetch, or the
// admin-auth branch: those need a live service-account key and network
// access, and per gh-1331 / #1388 the key is mid-rotation and this build must
// not read, copy, or depend on its current value. What IS covered here is
// everything pure that runs with zero permission flags: the Doppler-swap /
// config-error-path logic (parseServiceAccountEnv + ConfigError), the
// JWT-encoding primitives mintAccessToken depends on (base64url /
// base64urlText / pemToDer), and the two input-validation regexes
// (METRIC_NAME_RE, DATE_RE). Every credential string below is synthetic --
// never real key material.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// A plain brace-counter (as parse-roof-summary.test.ts and
// exhibit-a-shapes.test.ts use) misfires here: parseServiceAccountEnv
// contains a string literal with a literal "{" in it
// (propertyEnv.startsWith("{")), which a naive counter reads as an opener.
// This version tracks string/template-literal state so quoted braces don't
// count.
function grabBlock(marker: string): string {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`not found: ${marker}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let inStr: '"' | "'" | "`" | null = null;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") { j++; continue; } // skip the escaped character
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced: ${marker}`);
}

function grabConst(name: string): string {
  const marker = `const ${name} =`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`not found: ${name}`);
  const end = src.indexOf(";\n", start);
  if (end === -1) throw new Error(`unterminated: ${name}`);
  return src.slice(start, end + 1);
}

const mod = [
  grabConst("METRIC_NAME_RE").replace("const METRIC_NAME_RE", "export const METRIC_NAME_RE"),
  grabConst("DATE_RE").replace("const DATE_RE", "export const DATE_RE"),
  grabBlock("interface ServiceAccount").replace("interface ServiceAccount", "export interface ServiceAccount"),
  grabBlock("class ConfigError").replace("class ConfigError", "export class ConfigError"),
  grabBlock("function parseServiceAccountEnv(").replace(
    "function parseServiceAccountEnv",
    "export function parseServiceAccountEnv",
  ),
  grabBlock("function base64url(").replace("function base64url(", "export function base64url("),
  grabBlock("function base64urlText(").replace("function base64urlText(", "export function base64urlText("),
  grabBlock("function pemToDer(").replace("function pemToDer(", "export function pemToDer("),
].join("\n\n");
const url = "data:application/typescript," + encodeURIComponent(mod);
const {
  METRIC_NAME_RE,
  DATE_RE,
  ConfigError,
  parseServiceAccountEnv,
  base64url,
  base64urlText,
  pemToDer,
  // deno-lint-ignore no-explicit-any
} = await import(url) as any;

/** Narrows a caught `unknown` to the extracted ConfigError and returns its code. */
function configErrorCode(e: unknown): string {
  if (!(e instanceof ConfigError)) throw new Error(`expected a ConfigError, got: ${e}`);
  return (e as { code: string }).code;
}

// --- field-layout validation: the gh-1331 / #1388 Doppler swap -------------

Deno.test("swap detected: GA4_PROPERTY_ID holds JSON while GA4_SERVICE_ACCOUNT_JSON is empty", () => {
  // The exact shape #1388 measured live in Doppler prd: GA4_PROPERTY_ID
  // carries the full service-account JSON (private key included) and
  // GA4_SERVICE_ACCOUNT_JSON is empty. This must fail loudly and NAME the
  // swap -- synthetic value only, never real key material.
  const fakeSwappedJson =
    '{"type":"service_account","client_email":"x@y.iam.gserviceaccount.com","private_key":"NOT-A-REAL-KEY"}';
  try {
    parseServiceAccountEnv("", fakeSwappedJson);
    throw new Error("expected parseServiceAccountEnv to throw");
  } catch (e) {
    assertEquals(configErrorCode(e), "doppler_field_swap");
  }
});

Deno.test("missing secret: both fields empty is a plain missing_secret, not a swap", () => {
  try {
    parseServiceAccountEnv("", "");
    throw new Error("expected parseServiceAccountEnv to throw");
  } catch (e) {
    assertEquals(configErrorCode(e), "missing_secret");
  }
});

Deno.test("missing secret: a correctly-laid-out but still-unset numeric GA4_PROPERTY_ID must not read as a swap", () => {
  // Guards the heuristic in the other direction: post-rotation, GA4_PROPERTY_ID
  // legitimately holds a numeric id. If GA4_SERVICE_ACCOUNT_JSON is empty at
  // that point it is a plain missing_secret, not a false "swap" alarm.
  try {
    parseServiceAccountEnv("", "541423859");
    throw new Error("expected parseServiceAccountEnv to throw");
  } catch (e) {
    assertEquals(configErrorCode(e), "missing_secret");
  }
});

Deno.test("invalid JSON in GA4_SERVICE_ACCOUNT_JSON reports invalid_json, not a raw parse error", () => {
  try {
    parseServiceAccountEnv("{not valid json", "541423859");
    throw new Error("expected parseServiceAccountEnv to throw");
  } catch (e) {
    assertEquals(configErrorCode(e), "invalid_json");
  }
});

Deno.test("well-formed JSON missing client_email or private_key reports incomplete_service_account", () => {
  try {
    parseServiceAccountEnv('{"client_email":"x@y.iam.gserviceaccount.com"}', "541423859");
    throw new Error("expected parseServiceAccountEnv to throw (missing private_key)");
  } catch (e) {
    assertEquals(configErrorCode(e), "incomplete_service_account");
  }
  try {
    parseServiceAccountEnv('{"private_key":"NOT-A-REAL-KEY"}', "541423859");
    throw new Error("expected parseServiceAccountEnv to throw (missing client_email)");
  } catch (e) {
    assertEquals(configErrorCode(e), "incomplete_service_account");
  }
});

Deno.test("a complete, correctly-laid-out service account parses cleanly (post-rotation shape)", () => {
  const sa = parseServiceAccountEnv(
    '{"client_email":"otterquote-ga4-reader@otterquote-analytics.iam.gserviceaccount.com","private_key":"NOT-A-REAL-KEY"}',
    "541423859",
  );
  assertEquals(sa.client_email, "otterquote-ga4-reader@otterquote-analytics.iam.gserviceaccount.com");
  assertEquals(sa.private_key, "NOT-A-REAL-KEY");
});

// --- JWT-encoding primitives (mintAccessToken's building blocks) -----------

Deno.test("base64url matches RFC 4648 base64url: no padding, - and _ substituted", () => {
  const bytes = new TextEncoder().encode("any carnal pleas");
  assertEquals(base64url(bytes), "YW55IGNhcm5hbCBwbGVhcw");
});

Deno.test("base64urlText round-trips a JWT header the way mintAccessToken builds one", () => {
  const header = base64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  assertEquals(header.includes("+"), false);
  assertEquals(header.includes("/"), false);
  assertEquals(header.includes("="), false);
  const decoded = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(header.replace(/-/g, "+").replace(/_/g, "/")), (c: string) => c.charCodeAt(0)),
    ),
  );
  assertEquals(decoded, { alg: "RS256", typ: "JWT" });
});

Deno.test("pemToDer strips PEM headers/footers and whitespace, decoding only the payload", () => {
  // Not a real key -- an arbitrary byte string, PEM-wrapped, purely to prove
  // the strip/decode logic. mintAccessToken's real key material is never
  // touched by this test (gh-1331 / #1388: the key is mid-rotation).
  const payload = "hello world, this is not a key";
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(payload)}\n-----END PRIVATE KEY-----\n`;
  const der = pemToDer(pem);
  assertEquals(new TextDecoder().decode(new Uint8Array(der)), payload);
});

// --- input validation: metrics / date-range regexes -------------------------

Deno.test("METRIC_NAME_RE accepts real GA4 metric identifiers", () => {
  for (const m of ["sessions", "totalUsers", "screenPageViews", "conversions"]) {
    assertEquals(METRIC_NAME_RE.test(m), true);
  }
});

Deno.test("METRIC_NAME_RE rejects anything that could break out of the request body", () => {
  for (const m of ["sessions,DROP", "sess ions", 'sessions"}', "", "1sessions", "a".repeat(65)]) {
    assertEquals(METRIC_NAME_RE.test(m), false);
  }
});

Deno.test("DATE_RE accepts the shapes the handler documents", () => {
  for (const d of ["2026-08-31", "today", "yesterday", "7daysAgo", "90daysAgo"]) {
    assertEquals(DATE_RE.test(d), true);
  }
});

Deno.test("DATE_RE rejects free text", () => {
  for (const d of ["last week", "2026/08/31", "", "daysAgo"]) {
    assertEquals(DATE_RE.test(d), false);
  }
});
