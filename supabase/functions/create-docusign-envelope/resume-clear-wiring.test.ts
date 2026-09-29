// gh-1842 (PR #2240 REVIEW FAIL 5850941517, finding F2): the resume-path
// clear logic is unit-tested via a hand-written simulateResumeSignAttempt()
// harness in boldsign-readiness.test.ts, which proved the review's point --
// it stayed green (`ok | 9 passed | 0 failed`) even run against main's
// UNFIXED index.ts, because it never actually reads index.ts's source. This
// file closes that gap the way template-invariant-wiring.test.ts,
// rate-limit-split.test.ts and exhibit-a-shapes.test.ts already do for other
// invariants in this same single-file EF (it calls serve() at the bottom and
// cannot be imported directly): read index.ts as TEXT and assert the actual
// resume branch contains the wiring the fix requires.
//
// FAIL-FIRST, pasted in the PR: run this file against main's index.ts (no
// catch around the resume path's issueContractorSignLink call at all) --
// mustFind("if (!isPermanentCreationFailure(err)) throw err;", idxResume)
// throws "source has moved; update this test's anchors", because that
// string does not exist anywhere after the resume branch opens on main. On
// this branch it is found immediately after the resume try{} closes.
//
// REVIEW FAIL (PR #2240, round 2, F4): the original version of this file
// asserted `assertStringIncludes(resumeBlock, "quote_id: null", ...)` against
// the RAW slice, which also contains this file's own explanatory comment at
// index.ts's L1962 ("// quote_id: null forces clearStrandedEnvelopePointer
// into its ..."). That comment alone satisfies the assertion, so REVERTING
// the actual fix (L1971 quote_id: null -> quote_id, comment left in place)
// left the whole suite green -- the exact F1 regression this file exists to
// catch was invisible to it. Every assertion below now runs against
// `resumeCode`, the resume block with `//` line comments stripped, and the
// F1-specific assertion is a regex over the call site's actual shape
// (assertMatch) rather than a substring match a comment could also satisfy.
import { assert, assertMatch, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  }
  return i;
}

/**
 * Strip `//` line comments so an assertion cannot be satisfied by prose that
 * merely DESCRIBES the code instead of by the code itself. Deliberately
 * naive (no string-literal awareness) -- safe here because the resume block
 * this file inspects contains no `//` inside a string literal (verified: it
 * has no URLs; those live in issueContractorSignLink, a different function
 * this block only calls by reference).
 */
function stripLineComments(text: string): string {
  return text.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}

const idxResume = mustFind("if (requestBody.resolved_envelope_id) {");
const idxNextField = mustFind("let autoFields = providedFields || {};", idxResume);
const resumeBlock = src.slice(idxResume, idxNextField);
const resumeCode = stripLineComments(resumeBlock);

Deno.test("wiring: the resume branch catches a permanent BoldSign failure and clears the pointer before rethrowing", () => {
  assertStringIncludes(
    resumeCode,
    "if (!isPermanentCreationFailure(err)) throw err;",
    "the resume branch must gate the clear on the same narrow isPermanentCreationFailure() check the mint path uses",
  );
  assertStringIncludes(
    resumeCode,
    "clearStrandedEnvelopePointer(supabase, {",
    "the resume branch must call the shared clear helper, not a bespoke copy",
  );
  assertStringIncludes(
    resumeCode,
    "envelopeId: resumedEnvelopeId",
    "the clear must target the id actually being resumed, not some other variable",
  );
  // REVIEW FAIL F4: matched against CODE (comments stripped) with a regex
  // anchored to the actual call-site shape, not a bare substring a
  // hand-written comment elsewhere in the block could also satisfy.
  assertMatch(
    resumeCode,
    /clearStrandedEnvelopePointer\(supabase,\s*\{\s*claim_id,\s*quote_id:\s*null,\s*contractor_id,\s*envelopeId:\s*resumedEnvelopeId\s*\}\)/,
    "REVIEW FAIL F1: the resume path must NOT pass its (untrusted) quote_id to the clear -- " +
      "findExistingEnvelopeId() can resolve resumedEnvelopeId via the claim_id+contractor_id " +
      "fallback, so the clear call itself (not merely a comment near it) must pass quote_id: null " +
      "so it goes through that same guarded fallback, never a quote_id that might name a different row",
  );
  assert(
    resumeCode.lastIndexOf("throw err;") > resumeCode.indexOf("clearStrandedEnvelopePointer(supabase, {"),
    "the original permanent-failure error must still be rethrown AFTER the clear, not swallowed",
  );
});

Deno.test("wiring: the resume clear happens inside the catch, after the failed issueContractorSignLink call", () => {
  function mustFindCode(needle: string, from = 0): number {
    const i = resumeCode.indexOf(needle, from);
    if (i === -1) {
      throw new Error(`Expected to find ${JSON.stringify(needle)} in the (comment-stripped) resume block — source has moved; update this test's anchors.`);
    }
    return i;
  }
  const idxCatch = mustFindCode("} catch (err) {");
  const idxClear = mustFindCode("clearStrandedEnvelopePointer(supabase, {");
  const idxTry = mustFindCode("try {");
  const idxAttempt = mustFindCode("return await issueContractorSignLink(supabase, {", idxTry);
  assert(idxTry < idxAttempt, "the resume sign-link call must be inside the try block");
  assert(idxAttempt < idxCatch, "the catch must follow the attempted resume");
  assert(idxCatch < idxClear, "the clear must happen inside the catch, not before the attempt");
  assert(idxClear < resumeCode.length, "the clear must stay inside the resume branch, not leak into the mint path below it");
});

Deno.test("mutation control: reverting quote_id: null back to quote_id (explanatory comment left in place) is CAUGHT", () => {
  // This is the exact regression REVIEW FAIL F4 found: the round-1 version of
  // this file asserted assertStringIncludes(resumeBlock, "quote_id: null", ...)
  // against the RAW (comment-INCLUDED) block. index.ts's own explanatory
  // comment right above the real call site ALSO contains the literal text
  // "quote_id: null" ("// quote_id: null forces clearStrandedEnvelopePointer
  // into its ..."), so that old assertion passed even when the call site
  // itself was reverted to the untrusted `quote_id,` -- proven directly below
  // using the RAW block, before repeating the check on the comment-stripped
  // code the current (fixed) test actually asserts against.
  const mutatedRaw = resumeBlock.replace(
    "quote_id: null,\n        contractor_id,\n        envelopeId: resumedEnvelopeId",
    "quote_id,\n        contractor_id,\n        envelopeId: resumedEnvelopeId",
  );
  assert(mutatedRaw !== resumeBlock, "the mutation must actually change the text, or this control proves nothing");
  assert(
    mutatedRaw.includes("quote_id: null"),
    "F4's own evidence: the comment's literal 'quote_id: null' text survives the mutation, " +
      "so the OLD assertStringIncludes(resumeBlock, \"quote_id: null\") check would have passed here",
  );

  // The CURRENT test asserts against comment-stripped code, not the raw
  // block -- reproduce that and confirm the regex assertion FAILS on the
  // mutated (reverted-fix) code, where the vulnerable old check would not.
  const mutatedCode = stripLineComments(mutatedRaw);
  assert(!mutatedCode.includes("quote_id: null"), "sanity: stripping comments must remove the text that fooled the old assertion");
  let threw = false;
  try {
    assertMatch(
      mutatedCode,
      /clearStrandedEnvelopePointer\(supabase,\s*\{\s*claim_id,\s*quote_id:\s*null,\s*contractor_id,\s*envelopeId:\s*resumedEnvelopeId\s*\}\)/,
    );
  } catch {
    threw = true;
  }
  assert(threw, "the regex assertion must FAIL against the mutated (reverted-fix) code -- if it doesn't, F4 has regressed");
});
