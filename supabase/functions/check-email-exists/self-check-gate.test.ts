// gh-1724 [SECURITY]: check-email-exists used to return the contractor
// application `status` field to every caller, anonymous or not -- an
// unauthenticated account-enumeration oracle that also leaked pipeline
// stage. The fix gates `status` on `computeSelfCheck()`: it is included
// only when the caller's own verified-JWT email matches the email being
// looked up.
//
// index.ts is a single-file EF with no exports (the EF body-deploy path
// does not resolve module exports the way a normal Deno import would), so
// this test extracts computeSelfCheck the same way
// ga4-report/index.test.ts and parse-hover-measurements/parse-roof-summary
// .test.ts extract pure logic out of their single-file handlers: read the
// source text, grab the function body between its signature and matching
// closing brace, and eval it into a real callable. This keeps
// index.ts's production shape (one default-exported `serve()` handler)
// unchanged while still exercising the actual implementation, not a
// reimplementation of it.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

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
// below, so strip the ones this function's signature/body actually use.
function stripTypes(fnSrc: string): string {
  return fnSrc
    .replace(/function computeSelfCheck\(([\s\S]*?)\): boolean \{/, (_m, params) => {
      const stripped = params
        .split(",")
        .map((p: string) => p.split(":")[0].trim())
        .join(", ");
      return `function computeSelfCheck(${stripped}) {`;
    });
}

const computeSelfCheckSrc = stripTypes(grabFunction("function computeSelfCheck("));

// deno-lint-ignore no-explicit-any
const computeSelfCheck: (requestedEmail: string, callerEmail: string | null | undefined, authErr: unknown) => boolean =
  new Function(`${computeSelfCheckSrc}\nreturn computeSelfCheck;`)();

Deno.test("computeSelfCheck: no token/no caller email -> anonymous-safe (false)", () => {
  assertEquals(computeSelfCheck("victim@roofco.com", null, null), false);
  assertEquals(computeSelfCheck("victim@roofco.com", undefined, null), false);
  assertEquals(computeSelfCheck("victim@roofco.com", "", null), false);
});

Deno.test("computeSelfCheck: auth error -> false even if email happens to match", () => {
  assertEquals(computeSelfCheck("victim@roofco.com", "victim@roofco.com", new Error("invalid jwt")), false);
});

Deno.test("computeSelfCheck: authenticated caller checking a DIFFERENT email -> false (the enumeration case)", () => {
  // This is exactly the gh-1724 attack: a caller (anonymous or signed in as
  // someone else) probing a third party's address must never get `status`.
  assertEquals(computeSelfCheck("victim@roofco.com", "attacker@example.com", null), false);
});

Deno.test("computeSelfCheck: authenticated caller checking their OWN email -> true (the legitimate case)", () => {
  // This is contractor-pre-approval.html's checkContractorEmailDuplicate()
  // flow: currentUser.email, post sign-in, asking about themselves.
  assertEquals(computeSelfCheck("me@roofco.com", "me@roofco.com", null), true);
});

Deno.test("computeSelfCheck: email match is case-insensitive", () => {
  assertEquals(computeSelfCheck("Me@RoofCo.com", "me@roofco.com", null), true);
  assertEquals(computeSelfCheck("me@roofco.com", "ME@ROOFCO.COM", null), true);
});
