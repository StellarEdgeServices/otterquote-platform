// gh-2105 (batch 3) -- unit tests for process-dunning's local zero-row-update
// guard. Same rationale and same negative-control story as
// docusign-webhook/zero-row-update-guard.test.ts in this PR: before this
// file existed, `checkRowsWritten`/`zeroRowWriteMessage` did not exist
// anywhere in process-dunning, so this suite is RED against the pre-fix tree
// (module not found) and GREEN after this PR's zero-row-update-guard.ts
// lands. See the PR body for both raw `deno test` outputs.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkRowsWritten, zeroRowWriteMessage } from "./zero-row-update-guard.ts";

Deno.test("checkRowsWritten: a non-empty row array is a real write", () => {
  assertEquals(checkRowsWritten([{ id: "quote1" }]), { wroteRows: true, rowCount: 1 });
  assertEquals(checkRowsWritten([{ id: "quote1" }, { id: "quote2" }]), { wroteRows: true, rowCount: 2 });
});

Deno.test("checkRowsWritten: an empty array is the gh-2105 silent-failure shape", () => {
  assertEquals(checkRowsWritten([]), { wroteRows: false, rowCount: 0 });
});

Deno.test("checkRowsWritten: null/undefined/non-array data all count as zero rows", () => {
  assertEquals(checkRowsWritten(null), { wroteRows: false, rowCount: 0 });
  assertEquals(checkRowsWritten(undefined), { wroteRows: false, rowCount: 0 });
  assertEquals(checkRowsWritten("not-an-array"), { wroteRows: false, rowCount: 0 });
  assertEquals(checkRowsWritten({ id: "quote1" }), { wroteRows: false, rowCount: 0 });
});

Deno.test("zeroRowWriteMessage: includes the function name and the op description", () => {
  const msg = zeroRowWriteMessage("process-dunning", "quotes.payment_status=dunning for quote q1");
  assertEquals(
    msg,
    "[process-dunning] gh-2105: zero-row update -- quotes.payment_status=dunning for quote q1 matched no rows; the write silently did nothing.",
  );
});

// ── Regression guard: every gh-2105 batch-3 call site in index.ts must chain
// `.select(` on its `.update(...)`. Static-source assertion rather than a
// mock-Supabase test, for the same reason as docusign-webhook's twin test:
// index.ts's top-level `serve(...)` call means it cannot be imported directly
// in a test without starting an HTTP listener.
Deno.test("index.ts: every .update( call chains .select( within the next 10 lines", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const offenders: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!line.includes(".update(")) continue;
    if (trimmed.startsWith("//")) continue; // comment mentioning .update(
    const window = lines.slice(i, i + 10).join("\n");
    if (!window.includes(".select(")) offenders.push(i + 1);
  }
  assertEquals(offenders, [], `un-selected .update( at line(s): ${offenders.join(", ")}`);
});
