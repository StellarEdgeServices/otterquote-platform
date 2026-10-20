/**
 * [#2862] Decking-price reconciliation. Uses a namespace import so that on main
 * (where the functions do not exist) the tests FAIL on an assertion -- "two
 * different numbers accepted" -- rather than only on a missing import.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as pv from "./price-verify.ts";

// deno-lint-ignore no-explicit-any
const m = pv as any;
const signers = (v: string | null) => [
  {
    formFields: [
      { id: "contract_price", value: "$13,560.00" },
      ...(v === null ? [] : [{ id: "decking_per_sheet", value: v }]),
    ],
  },
];
const disp = (v: string | null, exp: number | null) => {
  if (typeof m.deckingVerdictFor !== "function") return "ACCEPTED (no decking comparison exists)";
  return m.deckingDispositionFor(m.deckingVerdictFor(signers(v), exp));
};

Deno.test("gh-2862: a signed decking price that differs from the quote HALTS ($95 vs $75)", () => {
  assertEquals(disp("$95.00", 75), "halt");
});
Deno.test("gh-2862: an under-statement halts too", () => {
  assertEquals(disp("60", 75), "halt");
});
Deno.test("gh-2862: matching prices proceed, across currency formats", () => {
  assertEquals(disp("$75.00", 75), "proceed");
  assertEquals(disp(" 75 ", 75), "proceed");
  assertEquals(disp("$1,075.00", 1075), "proceed");
});
Deno.test("gh-2862: an unparseable typed value halts", () => {
  assertEquals(disp("TBD", 75), "halt");
});
Deno.test("gh-2862: blank/absent tab or NULL quote rate does NOT block signing (flag)", () => {
  assertEquals(disp(null, 75), "flag");
  assertEquals(disp("   ", 75), "flag");
  assertEquals(disp("$95", null), "flag");
  assertEquals(disp(null, null), "flag");
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL: drive runDeckingGate (the extracted halt that index.ts calls
// immediately before the D-127 charge block) with a stubbed Supabase client, and
// model the handler's contract with a charge stub: `if (halt) return halt;
// charge()`. The index.ts half of that contract is pinned by the structural
// test below.
// ---------------------------------------------------------------------------
import { runDeckingGate } from "./decking-gate.ts";

function stubSupabase() {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const supabase = {
    from(table: string) {
      const q = {
        insert: (row: Record<string, unknown>) => { inserts.push({ table, row }); return Promise.resolve({ error: null }); },
        select: () => q, eq: () => q, like: () => q, limit: () => q,
        maybeSingle: () => Promise.resolve({ data: null }),
      };
      return q;
    },
  };
  return { supabase, inserts };
}

async function completion(signedDecking: string, quoted: number | null) {
  const { supabase, inserts } = stubSupabase();
  let chargeCalls = 0;
  let sentry = 0;
  const charge = () => { chargeCalls++; return new Response(JSON.stringify({ received: true, charged: true })); };
  const halt = await runDeckingGate({
    supabase, claimId: "claim-1", envelopeId: "env-1", quoteId: "quote-1",
    quotedDecking: quoted, signers: signers(signedDecking),
    reportToSentry: () => { sentry++; }, corsHeaders: {},
  });
  const res = halt ?? charge();
  return { res, body: await res.json(), chargeCalls, inserts, sentry };
}

Deno.test("gh-2862 behaviour: mismatched decking halts with defect and the charge stub is NEVER called", async () => {
  const r = await completion("$95.00", 75);
  assertEquals(r.body.defect, "decking_price_mismatch");
  assertEquals(r.res.status, 200);
  assertEquals(r.chargeCalls, 0);
  assertEquals(r.sentry, 1);
  assertEquals(r.inserts.map((x) => [x.table, x.row.alert_type ?? x.row.notification_type]), [
    ["platform_alerts_log", "signed_decking_price_mismatch"],
    ["notifications", "decking_price_mismatch_pending"],
  ]);
});

Deno.test("gh-2862 behaviour: matching decking does not halt and the charge stub IS called", async () => {
  const r = await completion("$75.00", 75);
  assertEquals(r.body.defect, undefined);
  assertEquals(r.body.charged, true);
  assertEquals(r.chargeCalls, 1);
  assertEquals(r.inserts.length, 0);
});

Deno.test("gh-2862 behaviour: NULL quoted rate flags and still charges", async () => {
  const r = await completion("$95", null);
  assertEquals(r.chargeCalls, 1);
  assertEquals(r.inserts.length, 0);
});

// ---------------------------------------------------------------------------
// STRUCTURAL: index.ts must return the gate's Response ahead of the charge.
// ---------------------------------------------------------------------------
const idx = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const idxCode = idx.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
Deno.test("gh-2862 wiring: index.ts returns the decking halt before the D-127 charge", () => {
  const gate = idxCode.indexOf("await runDeckingGate({");
  const ret = idxCode.indexOf("if (deckingHalt) return deckingHalt;");
  const charge = idxCode.indexOf("HANDLE PAYMENT CHARGING (D-127)");
  const chargeCall = idx.indexOf("HANDLE PAYMENT CHARGING (D-127)");
  assertEquals(gate > -1 && ret > gate, true, "index.ts must call runDeckingGate and return its Response");
  assertEquals(chargeCall > idx.indexOf("if (deckingHalt) return deckingHalt;"), true, "decking return must precede the charge block");
  assertEquals(charge === -1 || ret < charge, true);
});
