// gh-2492 (CTO ruling 5969703832): a failed READ of the blocked-states setting must make the
// out-of-state alert skip (fail closed), not fall back to FL/LA/TX and send. No alert, no
// stamp, so the trigger can retry. This sends no email; it asserts that none is sent.
// Run: deno test supabase/functions/notify-admin-new-homeowner/blocked-states-read-failure.test.ts
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { handleOutOfStateClaim } from "./out-of-state.ts";

// deno-lint-ignore no-explicit-any
function makeSb(settingError: boolean, settingValue: unknown): any {
  const claim = { id: "c1", user_id: "u1", trades: ["roofing"], property_state: "WA", is_test: false, out_of_state_alerted_at: null };
  const writes: string[] = [];
  return {
    writes,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select() { return b; },
        update() { writes.push(`update:${table}`); return b; },
        insert() { writes.push(`insert:${table}`); return Promise.resolve({ error: null }); },
        eq() { return b; }, is() { return b; }, not() { return b; },
        maybeSingle() {
          if (table === "claims") return Promise.resolve({ data: { ...claim }, error: null });
          if (table === "platform_settings") {
            return settingError
              ? Promise.resolve({ data: null, error: { message: "boom" } })
              : Promise.resolve({ data: { value: settingValue }, error: null });
          }
          if (table === "profiles") return Promise.resolve({ data: { email: "homeowner@gmail.com", is_test: false }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: unknown) => void) { resolve({ data: [{ ...claim }], error: null }); },
      };
      return b;
    },
  };
}

Deno.test("blocked-states read error -> WA claim sends NO alert and writes NO stamp (500 so it retries)", async () => {
  const sb = makeSb(true, undefined);
  const sent: string[] = [];
  const r = await handleOutOfStateClaim({ sb, sendMail: (s) => { sent.push(s); return Promise.resolve({ id: "mg" }); } }, { id: "c1" });
  assertEquals(r.status, 500);
  assertEquals(sent.length, 0);
  assertEquals(sb.writes, []);
});

Deno.test("control: read OK, WA not on the list -> the alert is sent", async () => {
  const sb = makeSb(false, ["FL", "LA", "TX"]);
  const sent: string[] = [];
  const r = await handleOutOfStateClaim({ sb, sendMail: (s) => { sent.push(s); return Promise.resolve({ id: "mg" }); } }, { id: "c1" });
  assertEquals(r.status, 200);
  assertEquals(sent.length, 1);
});

Deno.test("mixed-validity stored value ['FL','LA','Texas'] -> default list, so a TX claim is still blocked (no alert)", async () => {
  const claimTx = makeSb(false, ["FL", "LA", "Texas"]);
  const orig = claimTx.from.bind(claimTx);
  // deno-lint-ignore no-explicit-any
  claimTx.from = (t: string) => { const b = orig(t); if (t === "claims") { const m = b.maybeSingle; b.maybeSingle = () => m().then((r: any) => ({ ...r, data: { ...r.data, property_state: "TX" } })); } return b; };
  const sent: string[] = [];
  const r = await handleOutOfStateClaim({ sb: claimTx, sendMail: (s) => { sent.push(s); return Promise.resolve({ id: "mg" }); } }, { id: "c1" });
  assertEquals(r.body.reason, "blocked_state");
  assertEquals(sent.length, 0);
});
