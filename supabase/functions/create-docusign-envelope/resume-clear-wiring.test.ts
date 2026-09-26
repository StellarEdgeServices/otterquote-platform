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
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  }
  return i;
}

const idxResume = mustFind("if (requestBody.resolved_envelope_id) {");
const idxNextField = mustFind("let autoFields = providedFields || {};", idxResume);
const resumeBlock = src.slice(idxResume, idxNextField);

Deno.test("wiring: the resume branch catches a permanent BoldSign failure and clears the pointer before rethrowing", () => {
  assertStringIncludes(
    resumeBlock,
    "if (!isPermanentCreationFailure(err)) throw err;",
    "the resume branch must gate the clear on the same narrow isPermanentCreationFailure() check the mint path uses",
  );
  assertStringIncludes(
    resumeBlock,
    "clearStrandedEnvelopePointer(supabase, {",
    "the resume branch must call the shared clear helper, not a bespoke copy",
  );
  assertStringIncludes(
    resumeBlock,
    "envelopeId: resumedEnvelopeId",
    "the clear must target the id actually being resumed, not some other variable",
  );
  assertStringIncludes(
    resumeBlock,
    "quote_id: null",
    "REVIEW FAIL F1: the resume path must NOT pass its (untrusted) quote_id to the clear -- " +
      "findExistingEnvelopeId() can resolve resumedEnvelopeId via the claim_id+contractor_id " +
      "fallback, so the clear must go through that same guarded fallback, never a quote_id " +
      "that might name a different row",
  );
  assert(
    resumeBlock.lastIndexOf("throw err;") > resumeBlock.indexOf("clearStrandedEnvelopePointer(supabase, {"),
    "the original permanent-failure error must still be rethrown AFTER the clear, not swallowed",
  );
});

Deno.test("wiring: the resume clear happens inside the catch, after the failed issueContractorSignLink call", () => {
  const idxCatch = mustFind("} catch (err) {", idxResume);
  const idxClear = mustFind("clearStrandedEnvelopePointer(supabase, {", idxResume);
  const idxTry = mustFind("try {", idxResume);
  const idxAttempt = mustFind("return await issueContractorSignLink(supabase, {", idxTry);
  assert(idxTry < idxAttempt, "the resume sign-link call must be inside the try block");
  assert(idxAttempt < idxCatch, "the catch must follow the attempted resume");
  assert(idxCatch < idxClear, "the clear must happen inside the catch, not before the attempt");
  assert(idxClear < idxNextField, "the clear must stay inside the resume branch, not leak into the mint path below it");
});
