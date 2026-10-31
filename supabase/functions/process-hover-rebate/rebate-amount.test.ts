// gh-3228 / P18 (D-291): the homeowner measurement fee is now 2263 cents. The completion rebate must refund what was CHARGED
// (hover_orders.homeowner_charge_amount), never a constant, so orders paid at 1500 before the change and at 2263 after are each
// refunded in full. Source-level guard (pure unit, no secrets): reads index.ts only.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

Deno.test("gh-3228: the Stripe refund amount is the recorded charge, not a constant", () => {
  assert(code.includes('form.append("amount", String(order.homeowner_charge_amount));'));
});

Deno.test("gh-3228: no price literal (1500 / 2263 / 15.00 / 22.63) is hard-coded in the rebate path", () => {
  for (const lit of ["1500", "2263", "15.00", "22.63"]) assert(!code.includes(lit), `rebate path must not hard-code ${lit}`);
});

Deno.test("gh-3228: NEGATIVE CONTROL -- a job not marked complete is not refunded (the completion gate returns before the Stripe call)", () => {
  const gate = code.indexOf("if (!claimRow?.completion_date)");
  const stripeCall = code.indexOf("/refunds");
  assert(gate > 0 && stripeCall > 0, "both the completion gate and the refund call exist");
  assert(gate < stripeCall, "the completion gate sits before the refund call");
  assertEquals(code.slice(gate, gate + 160).includes("rebate not owed"), true);
});

Deno.test("gh-3228: a zero/absent charge amount is refused before the Stripe call", () => {
  const guard = code.indexOf("!order.homeowner_charge_amount || order.homeowner_charge_amount <= 0");
  assert(guard > 0 && guard < code.indexOf("/refunds"));
});
