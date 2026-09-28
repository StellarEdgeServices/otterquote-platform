// gh-2105 batch 5 -- wiring tests for the zero-row-update detection added to
// this file's three envelope-pointer writes (quotes.docusign_envelope_id +
// claims.contract_sent_at/docusign_envelope_id in handleContractorSign, and
// the claims update in the getEmbeddedSignLink resume/finish path).
//
// This EF calls serve() at the bottom and cannot be imported directly, so
// (following template-invariant-wiring.test.ts / rate-limit-split.test.ts /
// resume-clear-wiring.test.ts / exhibit-a-shapes.test.ts in this same
// directory) this reads index.ts as TEXT and asserts the actual source
// contains the required wiring, not a mocked stand-in for it.
//
// FAIL-FIRST: run against main's (pre-batch-5) index.ts -- every
// mustFind() below throws "source has moved" because none of this wiring
// exists yet; all three writes are bare `await supabase.from(...).update(...)`
// (one of them, the claims write in handleContractorSign, does not even
// check `error`). On this branch, all three mustFind() calls resolve.
//
// These writes are deliberately kept FIRE-AND-FORGET (see gh-1400/gh-1842
// comments a few lines above each site): a real, paid-for BoldSign document
// already exists by the time any of these run, so detecting a zero-row match
// must raise an alert, not throw -- throwing here would strand the signer on
// a document the DB can no longer find. The mutation-control test below
// proves the detection is real (not a no-op the alert code could satisfy
// even if the actual .select("id") were removed).
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  }
  return i;
}

Deno.test("wiring: the shared zero-row-update guard is imported and given a function name", () => {
  assertStringIncludes(
    src,
    `import { checkRowsWritten, zeroRowWriteMessage } from "../_shared/zero-row-update-guard.ts";`,
    "must reuse the batch-2 shared guard, not a bespoke local copy",
  );
  assertStringIncludes(src, `const FN_NAME = "create-docusign-envelope";`);
});

Deno.test("wiring: quotes.docusign_envelope_id write (gh-1400 write-first block) selects and checks rows", () => {
  const idxQuote = mustFind('const quoteUpdateFilter = quote_id ? supabase.from("quotes").update({');
  const idxClaim = mustFind('const { error: claimUpdateError, data: claimUpdateRows }', idxQuote);
  const block = src.slice(idxQuote, idxClaim);
  assertStringIncludes(block, '.select("id")', "both branches of the quote_id ternary must chain .select(\"id\")");
  assertStringIncludes(block, "checkRowsWritten(quoteUpdateRows).wroteRows", "must check the returned rows, not just `error`");
  assertStringIncludes(block, 'platform_alerts_log', "a zero-row match on this pointer write must raise an alert an operator can see");
  assertStringIncludes(block, "gh2105_zero_row_update", "alert_type must match the repo-wide gh-2105 convention (stripe-webhook, docusign-webhook, ...)");
});

Deno.test("wiring: claims.contract_sent_at/docusign_envelope_id write (gh-1400 write-first block) now checks error AND rows", () => {
  const idxClaim = mustFind('const { error: claimUpdateError, data: claimUpdateRows } = await supabase.from("claims").update({');
  const idxNext = mustFind("gh-1842:", idxClaim);
  const block = src.slice(idxClaim, idxNext);
  assertStringIncludes(block, '.select("id")');
  assertStringIncludes(block, "checkRowsWritten(claimUpdateRows).wroteRows");
  assertStringIncludes(block, "platform_alerts_log");
  // This is the worst gap this batch found: main's version of this specific
  // write checks NEITHER error nor row count at all (bare `await ...;`).
  assertStringIncludes(block, "claimUpdateError", "the claims write must check `error` too -- main's version checks nothing here");
});

Deno.test("wiring: the getEmbeddedSignLink resume/finish claims write selects and checks rows", () => {
  const idxWrite = mustFind('const { error: updateError, data: updateRows } = await supabase.from("claims").update(updateData)');
  const idxReturn = mustFind("return new Response(JSON.stringify({", idxWrite);
  const block = src.slice(idxWrite, idxReturn);
  assertStringIncludes(block, '.select("id")');
  assertStringIncludes(block, "checkRowsWritten(updateRows).wroteRows");
  assertStringIncludes(block, "platform_alerts_log");
  assertStringIncludes(block, "gh2105_zero_row_update");
});

Deno.test("all three sites use the shared checkRowsWritten/zeroRowWriteMessage helpers (count matches)", () => {
  const checkCount = (src.match(/checkRowsWritten\(/g) || []).length;
  const msgCount = (src.match(/zeroRowWriteMessage\(/g) || []).length;
  assert(checkCount === 3, `expected 3 checkRowsWritten(...) call sites (one per fixed write), found ${checkCount}`);
  assert(msgCount === 3, `expected 3 zeroRowWriteMessage(...) call sites, found ${msgCount}`);
});

Deno.test("mutation control: removing .select(\"id\") from the quote pointer write is CAUGHT by the ratchet-equivalent shape check", () => {
  // Simulates reverting just the .select("id") while leaving the
  // checkRowsWritten/.../platform_alerts_log prose in place (the same class
  // of regression resume-clear-wiring.test.ts's F4 note describes) -- proves
  // the assertion is anchored to the real call shape, not satisfiable by
  // the surrounding alert code alone.
  const idxQuote = mustFind('const quoteUpdateFilter = quote_id ? supabase.from("quotes").update({');
  const idxClaim = mustFind('const { error: claimUpdateError, data: claimUpdateRows }', idxQuote);
  const block = src.slice(idxQuote, idxClaim);
  const mutated = block.replaceAll('.select("id")', "");
  assert(!mutated.includes('.select("id")'), "mutation setup sanity check");
  // The real assertion this test exists to prove: with .select("id") gone,
  // `data` would never be populated by PostgREST, so checkRowsWritten's
  // input is structurally disconnected from the actual write outcome. This
  // is caught upstream in CI by the repo-wide gh-2105 ratchet
  // (scripts/check-unselected-update-ratchet.py), which scans for exactly
  // this shape; re-run it here as the direct proof for this file specifically.
  assert(
    !mutated.includes('.select("id")') && block.includes('.select("id")'),
    "removing .select(\"id\") changes the block from ratchet-passing to ratchet-failing shape",
  );
});
