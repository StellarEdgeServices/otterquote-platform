// [gh-1400, 2026-08-31] Cover for the mint/resume split at the entry point.
//
// The defect these guard: create-docusign-envelope both MINTED a new BoldSign
// document (real money, real plan quota) and RESUMED an existing one (free, and
// the only way any signer ever reaches the document) on a single rate budget
// keyed by claim_id. A contractor who opened their contract and came back was
// refused entry to their own signature for an hour, behind "Edge Function
// returned a non-2xx status code" -- and each entry minted a second document,
// orphaning the first.
//
// None of these helpers are exported (the function is a single-file EF), so
// this test extracts them from source the same way exhibit-a-shapes.test.ts and
// parse-hover-measurements/parse-roof-summary.test.ts do. The production file
// stays unchanged and the real implementations are what run here.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
function grab(name: string, isAsync = false): string {
  const decl = `${isAsync ? "async " : ""}function ${name}(`;
  const start = src.indexOf(decl);
  if (start === -1) throw new Error(`not found: ${decl}`);
  // Walk the parameter list to its matching ")" FIRST. Several of these
  // functions destructure their arguments, so the first "{" after the name is a
  // parameter brace, not the body -- counting depth from there truncates the
  // function at the end of its own signature.
  let paren = 0;
  let bodyOpen = -1;
  for (let j = start + decl.length - 1; j < src.length; j++) {
    if (src[j] === "(") paren++;
    else if (src[j] === ")") {
      paren--;
      if (paren === 0) {
        bodyOpen = src.indexOf("{", j);
        break;
      }
    }
  }
  if (bodyOpen === -1) throw new Error(`no body: ${name}`);
  let depth = 0;
  for (let j = bodyOpen; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced: ${name}`);
}
// RATE_KEY_MINT / RATE_KEY_RESUME are derived from FUNCTION_NAME, so pull those
// three declarations verbatim rather than restating the key strings here -- a
// test that hardcodes them cannot catch a rename.
function grabConst(name: string): string {
  const re = new RegExp(`^const ${name} = .*$`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`not found: const ${name}`);
  return m[0];
}

const mod = [
  grabConst("FUNCTION_NAME"),
  grabConst("RATE_KEY_MINT"),
  grabConst("RATE_KEY_RESUME"),
  "export { FUNCTION_NAME, RATE_KEY_MINT, RATE_KEY_RESUME };",
  grab("rateLimitKeyFor").replace("function rateLimitKeyFor", "export function rateLimitKeyFor"),
  grab("resolveOperation").replace("function resolveOperation", "export function resolveOperation"),
  grab("isMissingConfigDenial").replace("function isMissingConfigDenial", "export function isMissingConfigDenial"),
  grab("resolveRateLimitWindow").replace("function resolveRateLimitWindow", "export function resolveRateLimitWindow"),
  grab("computeRetryAt").replace("function computeRetryAt", "export function computeRetryAt"),
  grab("windowStartIso").replace("function windowStartIso", "export function windowStartIso"),
  grab("buildRateLimitMessage").replace("function buildRateLimitMessage", "export function buildRateLimitMessage"),
  grab("findExistingEnvelopeId", true).replace("async function findExistingEnvelopeId", "export async function findExistingEnvelopeId"),
].join("\n\n");
const url = "data:application/typescript," + encodeURIComponent(mod);
// deno-lint-ignore no-explicit-any
const m = await import(url) as any;
const {
  RATE_KEY_MINT,
  RATE_KEY_RESUME,
  rateLimitKeyFor,
  resolveOperation,
  isMissingConfigDenial,
  resolveRateLimitWindow,
  computeRetryAt,
  windowStartIso,
  buildRateLimitMessage,
  findExistingEnvelopeId,
} = m;

// A chainable stand-in for the supabase client. Every builder method returns
// itself; maybeSingle() hands back the next queued response. That is enough to
// drive findExistingEnvelopeId's two lookups in order.
function stubClient(...responses: Array<{ data: unknown }>) {
  let i = 0;
  const calls: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const fn of ["select", "eq", "not", "order", "limit", "is"]) {
    chain[fn] = (...args: unknown[]) => {
      calls.push(`${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`);
      return chain;
    };
  }
  chain.maybeSingle = () => Promise.resolve(responses[i++] ?? { data: null });
  return { client: { from: () => chain }, calls };
}

// ---------- the decision itself ----------

Deno.test("operation: a contractor_sign with an envelope already on the quote RESUMES", () => {
  // This is the case that minted a second document and orphaned 32e83466.
  assertEquals(resolveOperation("contractor_sign", "f1026cd0-d2ae-430a-9a0e-e54d0d7829e3"), "resume");
});

Deno.test("operation: a contractor_sign with no envelope yet MINTS", () => {
  assertEquals(resolveOperation("contractor_sign", null), "mint");
  assertEquals(resolveOperation("contractor_sign", undefined), "mint");
  // An empty string is not an envelope id.
  assertEquals(resolveOperation("contractor_sign", ""), "mint");
});

Deno.test("operation: homeowner_sign resumes, and cannot mint even with no envelope", () => {
  // The homeowner path has never minted. With no envelope it still resolves to
  // the mint key here, but handleHomeownerSign refuses outright ("the contractor
  // must sign first") before any document is created -- so no document is ever
  // minted on the homeowner's behalf.
  assertEquals(resolveOperation("homeowner_sign", "f1026cd0"), "resume");
  assertEquals(resolveOperation("homeowner_sign", null), "mint");
});

Deno.test("operation: legacy one-shot document types always mint, envelope or not", () => {
  // contract / color_confirmation / project_confirmation have no resume
  // semantics -- each is its own document. Passing an envelope id must NOT
  // divert them onto the contractor sign-link path.
  for (const t of ["contract", "color_confirmation", "project_confirmation"]) {
    assertEquals(resolveOperation(t, null), "mint");
    assertEquals(resolveOperation(t, "f1026cd0"), "mint");
  }
});

// ---------- the split rate key ----------

Deno.test("rate key: minting keeps the strict budget, resuming gets its own", () => {
  assertEquals(rateLimitKeyFor("mint"), RATE_KEY_MINT);
  assertEquals(rateLimitKeyFor("resume"), RATE_KEY_RESUME);
  // The two must not collide, or the split does nothing.
  assertEquals(RATE_KEY_MINT === RATE_KEY_RESUME, false);
  assertEquals(RATE_KEY_MINT, "create-docusign-envelope");
  assertEquals(RATE_KEY_RESUME, "create-docusign-envelope:sign-link");
});

Deno.test("rate key: anything that is not an explicit resume bills as a mint", () => {
  // Fail toward the strict budget: an unrecognised operation must never be
  // handed the generous key.
  assertEquals(rateLimitKeyFor(undefined), RATE_KEY_MINT);
  assertEquals(rateLimitKeyFor("RESUME"), RATE_KEY_MINT);
  assertEquals(rateLimitKeyFor(""), RATE_KEY_MINT);
});

// ---------- deny-by-default, the fourth-instance trap ----------

Deno.test("missing config: recognised from check_rate_limit's own wording", () => {
  // check_rate_limit() returns allowed:false when no rate_limit_config row
  // exists. The RESUME key is new, so on the deploy where its row is absent the
  // fetch path would 429 100% of the time -- the exact outage this change
  // removes, and the fourth instance of this defect class on this platform.
  assertEquals(
    isMissingConfigDenial({
      allowed: false,
      reason: "No rate limit config found for function: create-docusign-envelope:sign-link. Denying by default.",
    }),
    true,
  );
});

Deno.test("missing config: a real ceiling is NOT mistaken for a missing row", () => {
  // If this ever returned true for a genuine limit, the budget would stop
  // existing. Every real refusal reason must read as false.
  assertEquals(isMissingConfigDenial({ allowed: false, reason: "Hourly limit reached: 2/2 calls in the last hour." }), false);
  assertEquals(isMissingConfigDenial({ allowed: false, reason: "Daily limit reached: 50/50 calls today." }), false);
  assertEquals(isMissingConfigDenial({ allowed: false, reason: "Monthly limit reached: 500/500 calls this month." }), false);
  assertEquals(isMissingConfigDenial({ allowed: false, reason: "Function create-docusign-envelope is disabled via kill switch." }), false);
  assertEquals(isMissingConfigDenial({ allowed: false, reason: "Monthly budget cap reached: $40/$30 estimated spend." }), false);
  assertEquals(isMissingConfigDenial(null), false);
  assertEquals(isMissingConfigDenial({ allowed: false }), false);
});

// ---------- which ceiling was hit ----------

Deno.test("window: recovered from check_rate_limit's prose, which is all it returns", () => {
  assertEquals(resolveRateLimitWindow("Hourly limit reached: 2/2 calls in the last hour."), "hour");
  assertEquals(resolveRateLimitWindow("Daily limit reached: 50/50 calls today."), "day");
  assertEquals(resolveRateLimitWindow("Monthly limit reached: 500/500 calls this month."), "month");
  // The budget cap is a monthly ceiling and resets on the same clock.
  assertEquals(resolveRateLimitWindow("Monthly budget cap reached: $40/$30 estimated spend."), "month");
});

Deno.test("window: an unrecognised or absent reason yields null, not a guess", () => {
  // null is load-bearing: it makes the message say "a little later" rather than
  // naming a time we cannot actually stand behind.
  assertEquals(resolveRateLimitWindow("Function X is disabled via kill switch."), null);
  assertEquals(resolveRateLimitWindow(""), null);
  assertEquals(resolveRateLimitWindow(null), null);
  assertEquals(resolveRateLimitWindow(undefined), null);
});

// ---------- the reset instant ----------

Deno.test("retry_at: one hour after the oldest call still inside the window", () => {
  // The live incident: first un-blocked call at 12:57:40Z, so the hourly window
  // frees at 13:57:40Z.
  assertEquals(
    computeRetryAt("2026-08-31T12:57:40.000Z", "hour"),
    "2026-08-31T13:57:40.000Z",
  );
});

Deno.test("retry_at: the day window is exactly 24h after the oldest call", () => {
  assertEquals(computeRetryAt("2026-08-31T12:57:40.000Z", "day"), "2026-09-01T12:57:40.000Z");
});

Deno.test("retry_at: the month window is a CALENDAR month and clamps short months", () => {
  // Postgres interval '1 month' clamps rather than rolling over. Naive JS
  // setUTCMonth(+1) would turn Jan 31 into Mar 3 and promise the signer a reset
  // three days after the real one.
  assertEquals(computeRetryAt("2026-01-31T09:00:00.000Z", "month"), "2026-02-28T09:00:00.000Z");
  assertEquals(computeRetryAt("2026-08-31T12:57:40.000Z", "month"), "2026-09-30T12:57:40.000Z");
  // An ordinary month is untouched by the clamp.
  assertEquals(computeRetryAt("2026-03-15T00:00:00.000Z", "month"), "2026-04-15T00:00:00.000Z");
  // A leap February still clamps to the real last day.
  assertEquals(computeRetryAt("2028-01-31T00:00:00.000Z", "month"), "2028-02-29T00:00:00.000Z");
});

Deno.test("retry_at: refuses to invent a time it does not have", () => {
  assertEquals(computeRetryAt(null, "hour"), null);
  assertEquals(computeRetryAt("2026-08-31T12:57:40.000Z", null), null);
  assertEquals(computeRetryAt("not a date", "hour"), null);
  assertEquals(computeRetryAt("2026-08-31T12:57:40.000Z", "century"), null);
});

Deno.test("window start: mirrors the counting window and is never widened", () => {
  // A lookback wider than the real window would find an older call and compute
  // a retry_at that is too EARLY -- sending the signer straight into another
  // 429. Each of these must match check_rate_limit's interval exactly.
  const now = Date.parse("2026-08-31T13:11:22.000Z");
  assertEquals(windowStartIso("hour", now), "2026-08-31T12:11:22.000Z");
  assertEquals(windowStartIso("day", now), "2026-08-30T13:11:22.000Z");
  assertEquals(windowStartIso("month", now), "2026-07-31T13:11:22.000Z");
  assertEquals(windowStartIso(null, now), null);
});

// ---------- the sentence the signer reads ----------

Deno.test("message: the hourly refusal names a clock time, which is the whole point", () => {
  // What the contractor saw instead: "Unable to load contract / Edge Function
  // returned a non-2xx status code" over a Retry button that burned another
  // call. The one error state a user can act on was the one being hidden.
  assertEquals(
    buildRateLimitMessage("hour", "2026-08-31T13:57:40.000Z", "UTC"),
    "You have opened this contract several times in the last hour. Please try again at 1:57 PM.",
  );
});

Deno.test("message: a reset on another day carries the date, not a bare clock time", () => {
  // "try again at 12:57 PM" with no date would read as an hour away when it is
  // actually tomorrow.
  assertEquals(
    buildRateLimitMessage("day", "2026-09-01T12:57:40.000Z", "UTC"),
    "You have opened this contract several times today. Please try again at Sep 1, 12:57 PM.",
  );
  assertEquals(
    buildRateLimitMessage("month", "2026-09-30T12:57:40.000Z", "UTC"),
    "This contract has been opened many times this month. Please try again at Sep 30, 12:57 PM.",
  );
});

Deno.test("message: with no reset instant it stays honest rather than naming a time", () => {
  assertEquals(
    buildRateLimitMessage("hour", null, "UTC"),
    "You have opened this contract several times in the last hour. Please try again a little later.",
  );
  assertEquals(
    buildRateLimitMessage(null, null, "UTC"),
    "This contract has been opened too many times recently. Please try again a little later.",
  );
  // An unparseable timestamp must degrade the same way, never render "Invalid Date".
  assertEquals(
    buildRateLimitMessage("hour", "garbage", "UTC"),
    "You have opened this contract several times in the last hour. Please try again a little later.",
  );
});

Deno.test("message: rendered in the timezone it is handed", () => {
  // The Edge Function renders UTC for its own logs; the page re-renders the same
  // instant in the signer's local zone. Same instant, both correct.
  const at = "2026-08-31T13:57:40.000Z";
  assertEquals(buildRateLimitMessage("hour", at, "UTC").endsWith("at 1:57 PM."), true);
  assertEquals(buildRateLimitMessage("hour", at, "America/Indiana/Indianapolis").endsWith("at 9:57 AM."), true);
});

// ---------- the lookup that makes resume possible ----------

Deno.test("lookup: quote_id wins and short-circuits the fallback query", async () => {
  const { client } = stubClient({ data: { docusign_envelope_id: "f1026cd0" } });
  assertEquals(
    await findExistingEnvelopeId(client, { quote_id: "q1", claim_id: "c1", contractor_id: "k1" }),
    "f1026cd0",
  );
});

Deno.test("lookup: falls back to the newest quote carrying an envelope", async () => {
  // First response is the quote_id lookup coming back empty; second is the
  // (claim_id, contractor_id) fallback. This is the path a page entry without a
  // quote_id takes.
  const { client } = stubClient(
    { data: { docusign_envelope_id: null } },
    { data: { docusign_envelope_id: "32e83466" } },
  );
  assertEquals(
    await findExistingEnvelopeId(client, { quote_id: "q1", claim_id: "c1", contractor_id: "k1" }),
    "32e83466",
  );
});

Deno.test("lookup: no envelope anywhere returns null, which is what permits a mint", async () => {
  const { client } = stubClient({ data: null }, { data: null });
  assertEquals(
    await findExistingEnvelopeId(client, { quote_id: "q1", claim_id: "c1", contractor_id: "k1" }),
    null,
  );
  // A row that exists but carries no envelope id is still "no envelope".
  const b = stubClient({ data: null }, { data: { docusign_envelope_id: null } });
  assertEquals(
    await findExistingEnvelopeId(b.client, { claim_id: "c1", contractor_id: "k1" }),
    null,
  );
});

Deno.test("lookup: without claim_id and contractor_id it does not run the fallback", async () => {
  // Guards against a fallback query with undefined filters, which would match
  // an arbitrary quote and hand a signer someone else's document.
  const { client, calls } = stubClient({ data: null });
  assertEquals(await findExistingEnvelopeId(client, { quote_id: "q1" }), null);
  assertEquals(calls.some((c) => c.includes("undefined")), false);
});
