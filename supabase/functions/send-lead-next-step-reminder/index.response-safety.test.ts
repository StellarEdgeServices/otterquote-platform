// gh-2213 REVIEW: FAIL follow-up (Marty, CTO RUN 41, PR #2215 comment
// 5848690713, M1): error-response.test.ts only exercised the helper module
// (error-response.ts), never index.ts itself -- so reverting either call
// site back to the old inline leak shape (`{ error: candErr.message }` /
// `{ error: String(err) }`) would leave the whole test suite green. This
// file closes that gap by reading index.ts's own source text and checking
// every `new Response(...)` call site directly.
//
// This is the review's option (b) ("At minimum, a source-level guard test
// that reads index.ts ... and asserts that no new Response( argument
// contains .message, String(err) or errText, and that both 500 sites call
// the helpers. This is weaker than [extracting the handler], but it does
// fail on the old file and pass on the new one.") -- chosen over option (a)
// (extracting the handler into an injectable `handle(req, deps)`) because
// this function runs hourly against live lead data and a structural
// rewrite of its request-handling shape is a materially bigger behavior-
// risk than this PR's stated scope ("Change nothing else about the
// function's behaviour or status codes").
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const INDEX_SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// Extracts the full text of every `new Response(...)` call, matching
// parens so a call whose body/options span multiple lines (e.g. the
// SUPABASE_URL/SERVICE_ROLE_KEY guard) is captured whole rather than only
// its first line.
function extractResponseCallSites(source: string): string[] {
  const marker = "new Response(";
  const sites: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    let depth = 1;
    let i = start + marker.length;
    while (depth > 0 && i < source.length) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    sites.push(source.slice(start, i));
    searchFrom = i;
  }
  return sites;
}

const RESPONSE_CALL_SITES = extractResponseCallSites(INDEX_SOURCE);

// Sanity check: as of gh-2213 this function has 9 `new Response(...)` call
// sites (confirmed against the reviewed head via `grep -c "new Response("`).
// If this drifts, something about the file's shape changed enough that the
// guard below might not be scanning what it thinks it is -- fail loudly
// rather than silently under-checking a smaller or larger set.
Deno.test("index.ts response-safety guard: expected number of Response call sites", () => {
  assertEquals(RESPONSE_CALL_SITES.length, 9);
});

Deno.test("index.ts response-safety guard: no Response call site serializes raw error detail", () => {
  const leaking = RESPONSE_CALL_SITES.filter((site) =>
    /\.message\b/.test(site) || /String\(err\)/.test(site) || /\berrText\b/.test(site)
  );
  assertEquals(
    leaking,
    [],
    `Found ${leaking.length} Response() call site(s) that appear to serialize raw error detail:\n${
      leaking.join("\n---\n")
    }`,
  );
});

Deno.test("index.ts response-safety guard: both 500 sinks call the generic-body helpers", () => {
  assert(
    INDEX_SOURCE.includes("internalErrorResponse()"),
    "candidate-query failure branch should call internalErrorResponse()",
  );
  assert(
    /unexpectedErrorResponse\(\s*FUNCTION_NAME\s*,\s*err\s*\)/.test(INDEX_SOURCE),
    "outer catch should call unexpectedErrorResponse(FUNCTION_NAME, err)",
  );
});
