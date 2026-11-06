// gh-3488 / D-267 -- the fee shown to the contractor and the fee charged are ONE figure in whole cents.
// Run: deno test --allow-read=supabase/functions supabase/functions/_shared/platform-fee.test.ts
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { platformFeeCents, platformFeeDollars, wholeCents, wholeCentDollars } from "./platform-fee.ts";

// Independent reference: BigInt exact half-up of bidCents * pctHundredths / 10000.
const ref = (bidCents: number, pct: number) =>
  Number((BigInt(bidCents) * BigInt(Math.round(pct * 100)) + 5000n) / 10000n);

// The expressions the code used before this change.
const oldWebhookCharge = (total: number, pct: number) => Math.round(total * (pct / 100) * 100);
const oldShown = (bid: number, pct: number) => (bid * pct) / 100;

Deno.test("gh-3488 the issue's example: a $1,296.10 bid at 5% is 6481 cents on both sides", () => {
  assertEquals(platformFeeCents(1296.1, 5), 6481);
  assertEquals(platformFeeDollars(1296.1, 5), 64.81);
  // What the old webhook expression charged, and what the form showed ($64.81):
  assertEquals(oldWebhookCharge(1296.1, 5), 6480);
  assertEquals(oldShown(1296.1, 5).toLocaleString("en-US", { style: "currency", currency: "USD" }), "$64.81");
  assertNotEquals(oldWebhookCharge(1296.1, 5), platformFeeCents(1296.1, 5));
});

Deno.test("gh-3488 half-cent products round up, exactly like Postgres round(numeric, 2)", () => {
  assertEquals(platformFeeCents(0.1, 5), 1);      // 0.005 -> 0.01
  assertEquals(platformFeeCents(10.1, 5), 51);    // 0.505 -> 0.51
  assertEquals(platformFeeCents(10, 7.5), 75);
  assertEquals(platformFeeCents(18000, 5), 90000);
});

Deno.test("gh-3488 refuses nonsense by returning 0 (never NaN, never negative)", () => {
  for (const [b, p] of [[0, 5], [-5, 5], [100, 0], [100, -1], [NaN, 5], [100, NaN], [Infinity, 5]] as [number, number][]) {
    assertEquals(platformFeeCents(b, p), 0);
  }
});

Deno.test("gh-3488 matches the exact reference over 300,000 bids at the production rate and 4 other rates", () => {
  for (const pct of [5, 2.5, 7.5, 10, 3.25]) {
    for (let c = 1; c <= 60_000; c++) {
      const got = platformFeeCents(c / 100, pct);
      if (got !== ref(c, pct)) throw new Error(`bid cents ${c} at ${pct}%: got ${got}, want ${ref(c, pct)}`);
    }
  }
});

Deno.test("gh-3488 every charge site uses the shared definition and none keeps a float expression", async () => {
  const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
  const sites: Record<string, string> = {
    "docusign-webhook": await read("../docusign-webhook/index.ts"),
    "create-payment-intent": await read("../create-payment-intent/index.ts"),
    "create-invoice": await read("../create-invoice/index.ts"),
    "process-auto-bids": await read("../process-auto-bids/index.ts"),
  };
  for (const [name, src] of Object.entries(sites)) {
    assertEquals(/from ["']\.\.\/_shared\/platform-fee\.ts["']/.test(src), true, `${name} must import the shared fee definition`);
    assertEquals(/platformFee(Cents|Dollars)\(/.test(src), true, `${name} must call the shared fee function`);
  }
  // The retired float expressions (negative control: each of these is on main before this change).
  assertEquals(/total_price\s*\*\s*\(\s*platformFeePercent\s*\/\s*100\s*\)\s*\*\s*100/.test(sites["docusign-webhook"]), false);
  assertEquals(/Number\(quote\.total_price\)\s*\*\s*\(\s*Number\(feePct\)\s*\/\s*100\s*\)\s*\*\s*100/.test(sites["create-payment-intent"]), false);
  assertEquals(/Math\.round\(\(bidAmount\s*\*\s*feePct\)\s*\/\s*100\)/.test(sites["create-invoice"]), false);
  // gh-3488 review fix: the auto-bid email/activity-log fee is the charged fee, not its own float expression.
  assertEquals(/Math\.round\(rcvAmount\s*\*\s*\(resolvedFeePct\s*\/\s*100\)\s*\*\s*100\)/.test(sites["process-auto-bids"]), false);
  assertEquals(/platformFeeDollars\(rcvAmount, resolvedFeePct\)/.test(sites["process-auto-bids"]), true);
});

Deno.test("gh-3488 a bid typed with a fraction of a cent shows and charges one fee (Postgres numeric(12,2) stores it half-up)", () => {
  // 9734.095 is stored as 9734.10; the old Math.round(bid * 100) gave 973409 and a fee of 48670 against a 48671 charge.
  assertEquals(wholeCents(9734.095), 973410);
  assertEquals(wholeCentDollars(9734.095), 9734.1);
  assertEquals(platformFeeCents(9734.095, 5), 48671);
  assertEquals(platformFeeCents(9734.095, 5), platformFeeCents(9734.1, 5));
  assertEquals(platformFeeCents(128.295, 5), platformFeeCents(128.3, 5)); // the review's 641-vs-642 case
  assertEquals(platformFeeCents(128.295, 5), 642);
});

Deno.test("gh-3488 fractional bids: 400,000 three-decimal bids match storing the bid as numeric(12,2) first", () => {
  for (const pct of [5, 7.5]) {
    for (let t = 1000; t <= 201_000; t++) {            // $1.000 to $201.000 in thousandths
      const storedCents = Math.floor((t + 5) / 10);    // Postgres rounds the decimal text half-up
      const want = ref(storedCents, pct);
      const got = platformFeeCents(t / 1000, pct);
      if (got !== want) throw new Error(`typed ${t / 1000} at ${pct}%: got ${got}, want ${want}`);
    }
  }
});
