// gh-1786 LEGAL-READ FAIL (PR #1810 comment 5577311497) — a valid, verified
// token whose suppression write failed (missing config, a failed claim
// lookup, or an insert error other than the idempotent-retry 23505) used to
// render the SAME "Updates stopped" success page as a real success. index.ts
// now returns a distinct, non-200 failurePage() on those three branches
// instead, while every branch reachable WITHOUT a verified token — including
// the "claim has no owner" case — still returns the original page(), to
// preserve the no-enumeration-oracle invariant documented at the top of
// index.ts.
//
// index.ts is a serve()-wrapped handler with no exports (same shape as
// ga4-report/index.ts), so this test uses the same source-text-extraction
// technique ga4-report/index.test.ts and create-docusign-envelope/
// exhibit-a-shapes.test.ts use: pull the real function/const bodies out of
// the actual file and load them as a module, rather than reimplementing them
// by hand (which would test a transcription, not the source).
//
// Two things are checked:
//   1. page() and failurePage() are genuinely different, correctly-statused
//      responses (200 vs 500), and the failure page never claims the series
//      stopped.
//   2. The actual source text at each of the three named defect sites calls
//      failurePage(), and the deliberately-unchanged "no owner" branch still
//      calls page(). This is what actually catches a regression on THIS
//      defect — reverting any of the three call sites back to page() fails
//      this test immediately, with no live Supabase client or env mocking
//      needed for the rest of the handler.
import { assertEquals, assertMatch, assertNotEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// A plain brace-counter misfires on string/template-literal content that
// contains a literal "{" or "}" (none of these blocks do, but this mirrors
// ga4-report/index.test.ts's safer version rather than assuming that stays
// true forever).
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
  grabConst("CONFIRMATION_HTML").replace("const CONFIRMATION_HTML", "export const CONFIRMATION_HTML"),
  grabConst("FAILURE_HTML").replace("const FAILURE_HTML", "export const FAILURE_HTML"),
  grabBlock("function page(").replace("function page(", "export function page("),
  grabBlock("function failurePage(").replace("function failurePage(", "export function failurePage("),
].join("\n\n");
const url = "data:application/typescript," + encodeURIComponent(mod);
const { page, failurePage } = await import(url) as {
  page: () => Response;
  failurePage: () => Response;
};

// --- (1) the two responses are genuinely different -------------------------

Deno.test("page() and failurePage() are genuinely different responses", async () => {
  const success = page();
  const failure = failurePage();
  assertEquals(success.status, 200);
  assertEquals(failure.status, 500);
  const successBody = await success.text();
  const failureBody = await failure.text();
  assertNotEquals(successBody, failureBody);
  assertMatch(successBody, /Updates stopped/);
  assertMatch(failureBody, /couldn.t record your request/i);
  // The failure page must never claim the series stopped — that is exactly
  // the false confirmation this fix removes.
  assertEquals(/Updates stopped/.test(failureBody), false);
});

Deno.test("failurePage() is never cached or indexed, matching page()'s existing headers", () => {
  const r = failurePage();
  assertEquals(r.headers.get("Cache-Control"), "no-store");
  assertEquals(r.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assertEquals(r.headers.get("Referrer-Policy"), "no-referrer");
});

// --- (2) wiring: the three named LEGAL-READ FAIL branches, and only those --

/** Finds the first `return ...;` after `guardMarker` in the real source and
 * reports whether it calls failurePage(). */
function returnsFailurePage(guardMarker: string): boolean {
  const guardStart = src.indexOf(guardMarker);
  if (guardStart === -1) throw new Error(`guard not found: ${guardMarker}`);
  const returnStart = src.indexOf("return ", guardStart);
  const returnEnd = src.indexOf(";", returnStart);
  if (returnStart === -1 || returnEnd === -1) throw new Error(`no return found after: ${guardMarker}`);
  const statement = src.slice(returnStart, returnEnd);
  if (statement.includes("failurePage()")) return true;
  if (statement.includes("page()")) return false;
  throw new Error(`return statement matched neither page() nor failurePage(): ${statement}`);
}

Deno.test("missing SUPABASE_URL/service-role key returns failurePage(), not page() (defect 2, branch 1)", () => {
  assertEquals(returnsFailurePage("if (!supabaseUrl || !serviceRoleKey)"), true);
});

Deno.test("a failed claim lookup returns failurePage(), not page() (defect 2, branch 2)", () => {
  assertEquals(returnsFailurePage("if (claimErr)"), true);
});

Deno.test("an insert error other than 23505 (a failing write) returns failurePage(), not page() (defect 2, branch 3)", () => {
  assertEquals(returnsFailurePage('if (insertErr && insertErr.code !== "23505")'), true);
});

Deno.test("NEGATIVE CONTROL — a verified token naming a claim with no owner still returns page(), preserving the no-enumeration-oracle invariant", () => {
  assertEquals(returnsFailurePage("if (!claim?.user_id)"), false);
});
