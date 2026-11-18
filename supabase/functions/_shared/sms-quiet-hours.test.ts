// gh-3762 (child of gate #3726 item 5): contractor SMS quiet hours, recipient local time, window 08:00 <= t < 20:00 (Ben's ruling on PR #3774).
// Run: deno test --allow-read=supabase/functions supabase/functions/_shared/sms-quiet-hours.test.ts
// Pure + fakes: no network, no Twilio. All instants are UTC; the comment gives the local time they stand for.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  ALL_US_ZONES, candidateZones, checkQuietHours, isOwnerAlertNumber, OWNER_ALERT_NUMBER_E164, quietHoursRefusal,
} from "./sms-quiet-hours.ts";

const at = (iso: string) => new Date(iso);
const ok = (iso: string, r: { timezone?: string | null; state?: string | null }) => checkQuietHours(at(iso), r).allowed;

// 2026-11-15 is standard time everywhere in the US (EST -5, CST -6, MST -7, PST -8).
const ET = { timezone: "America/New_York", state: "OH" };
const CT = { timezone: "America/Chicago", state: "IL" };
const PT = { timezone: "America/Los_Angeles", state: "CA" };
const UNKNOWN = { timezone: "America/New_York", state: null };

Deno.test("ET boundaries: 19:59 sends, 20:00 does not, 07:59 does not, 08:00 sends", () => {
  assertEquals(ok("2026-11-16T00:59:00Z", ET), true);  // 19:59 EST
  assertEquals(ok("2026-11-16T01:00:00Z", ET), false); // 20:00 EST
  assertEquals(ok("2026-11-15T12:59:00Z", ET), false); // 07:59 EST
  assertEquals(ok("2026-11-15T13:00:00Z", ET), true);  // 08:00 EST
});

Deno.test("CT boundaries", () => {
  assertEquals(ok("2026-11-16T01:59:00Z", CT), true);  // 19:59 CST
  assertEquals(ok("2026-11-16T02:00:00Z", CT), false); // 20:00 CST
  assertEquals(ok("2026-11-15T13:59:00Z", CT), false); // 07:59 CST
  assertEquals(ok("2026-11-15T14:00:00Z", CT), true);  // 08:00 CST
});

Deno.test("PT boundaries", () => {
  assertEquals(ok("2026-11-16T03:59:00Z", PT), true);  // 19:59 PST
  assertEquals(ok("2026-11-16T04:00:00Z", PT), false); // 20:00 PST
  assertEquals(ok("2026-11-15T15:59:00Z", PT), false); // 07:59 PST
  assertEquals(ok("2026-11-15T16:00:00Z", PT), true);  // 08:00 PST
});

Deno.test("the same instant can be fine in one zone and refused in another (recipient local time, not server time)", () => {
  const t = "2026-11-16T01:30:00Z"; // 20:30 ET, 19:30 CT, 17:30 PT
  assertEquals([ok(t, ET), ok(t, CT), ok(t, PT)], [false, true, true]);
});

Deno.test("UNKNOWN timezone (no state) uses the restrictive window valid in every US zone", () => {
  // Open only while it is 08:00-20:00 in Honolulu AND 08:00-20:00 in Eastern: 18:00Z .. 01:00Z in November.
  assertEquals(ok("2026-11-15T17:59:00Z", UNKNOWN), false); // 12:59 ET, 07:59 HST
  assertEquals(ok("2026-11-15T18:00:00Z", UNKNOWN), true);  // 13:00 ET, 08:00 HST
  assertEquals(ok("2026-11-16T00:59:00Z", UNKNOWN), true);  // 19:59 ET
  assertEquals(ok("2026-11-16T01:00:00Z", UNKNOWN), false); // 20:00 ET
  const v = checkQuietHours(at("2026-11-16T02:00:00Z"), UNKNOWN);
  assertEquals(v.basis, "fallback_all_us");
  assertEquals(v.nextAllowedAt?.toISOString(), "2026-11-16T18:00:00.000Z");
});

Deno.test("fallback is the intersection: every instant it allows is allowed in every US zone", () => {
  for (let m = 0; m < 24 * 60; m += 5) {
    const t = new Date(Date.UTC(2026, 10, 15, 0, m));
    if (checkQuietHours(t, UNKNOWN).allowed) {
      for (const z of ALL_US_ZONES) assert(checkQuietHours(t, { state: "OH", timezone: z }).zones.includes(z) && checkQuietHoursInZone(t, z));
    }
  }
});
function checkQuietHoursInZone(t: Date, z: string): boolean {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: z, hourCycle: "h23", hour: "numeric" }).format(t));
  return h >= 8 && h < 21;
}

Deno.test("an unrecognised or missing state is the fallback; a column default alone never narrows it", () => {
  assertEquals(candidateZones({ timezone: "America/New_York", state: "ZZ" }).basis, "fallback_all_us");
  assertEquals(candidateZones({ timezone: null, state: null }).basis, "fallback_all_us");
  assertEquals(candidateZones({}).zones.length, ALL_US_ZONES.length);
});

Deno.test("column timezone that disagrees with the state is ADDED, so the stricter answer wins (TX contractor tagged ET)", () => {
  const r = { timezone: "America/New_York", state: "TX" };
  assertEquals(candidateZones(r).zones.sort(), ["America/Chicago", "America/Denver", "America/New_York"]);
  // 08:00 ET is 07:00 CT and 06:00 MT: refused. 15:00Z = 10:00 ET, 09:00 CT, 08:00 MT: allowed.
  assertEquals(ok("2026-11-15T13:00:00Z", r), false);
  assertEquals(ok("2026-11-15T15:00:00Z", r), true);
});

Deno.test("split state Indiana (ET + CT): window is 09:00-20:00 Eastern", () => {
  const IN = { timezone: "America/New_York", state: "IN" };
  assertEquals(ok("2026-11-15T13:59:00Z", IN), false); // 08:59 ET = 07:59 CT
  assertEquals(ok("2026-11-15T14:00:00Z", IN), true);  // 09:00 ET = 08:00 CT
  assertEquals(ok("2026-11-16T00:59:00Z", IN), true);  // 19:59 ET
  assertEquals(ok("2026-11-16T01:00:00Z", IN), false); // 20:00 ET
  assertEquals(checkQuietHours(at("2026-11-15T13:59:00Z"), IN).nextAllowedAt?.toISOString(), "2026-11-15T14:00:00.000Z");
});

Deno.test("an invalid IANA name in the column is ignored (state zones only), never thrown", () => {
  const v = checkQuietHours(at("2026-11-15T15:00:00Z"), { timezone: "Not/AZone", state: "OH" });
  assertEquals(v.basis, "state");
  assertEquals(v.allowed, true);
});

Deno.test("nextAllowedAt: after 20:00 it is 08:00 local the next morning; before 08:00 it is 08:00 the same day", () => {
  assertEquals(checkQuietHours(at("2026-11-16T03:00:00Z"), ET).nextAllowedAt?.toISOString(), "2026-11-16T13:00:00.000Z"); // 22:00 EST -> 08:00 EST
  assertEquals(checkQuietHours(at("2026-11-15T10:00:00Z"), ET).nextAllowedAt?.toISOString(), "2026-11-15T13:00:00.000Z"); // 05:00 EST -> 08:00 EST
  assertEquals(checkQuietHours(at("2026-11-15T15:00:00Z"), ET).nextAllowedAt, null); // allowed
});

// ---- DST -----------------------------------------------------------------------------------------------------------
Deno.test("DST spring forward (Sun 2026-03-08, ET): 07:59 EDT refused, 08:00 EDT sends; the evening before crosses the change", () => {
  assertEquals(ok("2026-03-08T11:59:00Z", ET), false); // 07:59 EDT
  assertEquals(ok("2026-03-08T12:00:00Z", ET), true);  // 08:00 EDT
  assertEquals(ok("2026-03-08T00:59:00Z", ET), true);  // Sat 19:59 EST
  const after = checkQuietHours(at("2026-03-08T01:00:00Z"), ET); // Sat 20:00 EST
  assertEquals(after.allowed, false);
  assertEquals(after.nextAllowedAt?.toISOString(), "2026-03-08T12:00:00.000Z"); // Sun 08:00 EDT, NOT 13:00Z
  assertEquals(ok("2026-03-08T20:59:00Z", ET), true);  // 16:59 EDT
  assertEquals(ok("2026-03-08T23:59:00Z", ET), true);  // 19:59 EDT
  assertEquals(ok("2026-03-09T00:00:00Z", ET), false); // 20:00 EDT
});

Deno.test("DST fall back (Sun 2026-11-01, ET): 07:59 EST refused, 08:00 EST sends; Saturday night's next opening is 13:00Z", () => {
  assertEquals(ok("2026-11-01T12:59:00Z", ET), false); // 07:59 EST
  assertEquals(ok("2026-11-01T13:00:00Z", ET), true);  // 08:00 EST
  assertEquals(ok("2026-11-02T00:59:00Z", ET), true);  // 19:59 EST
  assertEquals(ok("2026-11-02T01:00:00Z", ET), false); // 20:00 EST
  const sat = checkQuietHours(at("2026-11-01T00:00:00Z"), ET); // Sat 20:00 EDT
  assertEquals(sat.allowed, false);
  assertEquals(sat.nextAllowedAt?.toISOString(), "2026-11-01T13:00:00.000Z"); // Sun 08:00 EST (an hour later than EDT would give)
});

Deno.test("DST day, Central: the change happens at 02:00 local, the window edges stay on local wall time", () => {
  assertEquals(ok("2026-03-08T12:59:00Z", CT), false); // 07:59 CDT
  assertEquals(ok("2026-03-08T13:00:00Z", CT), true);  // 08:00 CDT
  assertEquals(ok("2026-11-01T13:59:00Z", CT), false); // 07:59 CST
  assertEquals(ok("2026-11-01T14:00:00Z", CT), true);  // 08:00 CST
});

Deno.test("the week the zones are on different offsets does not leak: after ET springs forward but before PT does is impossible in the US (same 02:00 local) but UTC instants differ", () => {
  // 2026-03-08T09:30Z: ET already EDT (05:30), PT still PST until 10:00Z (01:30 PST). Both refused (night).
  assertEquals(ok("2026-03-08T09:30:00Z", ET), false);
  assertEquals(ok("2026-03-08T09:30:00Z", PT), false);
  // 2026-03-08T15:00Z: 11:00 EDT, 08:00 PDT -> both open.
  assertEquals(ok("2026-03-08T15:00:00Z", PT), true);
  assertEquals(ok("2026-03-08T14:59:00Z", PT), false); // 07:59 PDT
});

// ---- send-sms refusal + owner exemption --------------------------------------------------------------------------
const CORS = { "Access-Control-Allow-Origin": "https://otterquote.com" };

function fakeSb(nums: Array<{ contractor_id: string }>, contractors: Array<{ timezone: string | null; address_state: string | null }>, mode: "ok" | "error" | "throw" = "ok") {
  const seen: string[] = [];
  return {
    seen,
    sb: {
      from: (t: string) => {
        seen.push(`from ${t}`);
        if (mode === "throw") throw new Error("boom");
        return {
          select: (_c: string) => ({
            eq: (_col: string, _v: string) => Promise.resolve(mode === "error" ? { data: null, error: { code: "XX000" } } : { data: nums, error: null }),
            in: (_col: string, _v: string[]) => Promise.resolve({ data: contractors, error: null }),
          }),
        };
      },
    },
  };
}
const CONTRACTOR_PHONE = "+13175550123";

Deno.test("NEGATIVE CONTROL: a send at 22:00 local is refused (outside_quiet_hours + next_allowed_at); at 10:00 local it goes", async () => {
  const { sb } = fakeSb([{ contractor_id: "c1" }], [{ timezone: "America/New_York", address_state: "OH" }]);
  const lines: string[] = [];
  // deno-lint-ignore no-explicit-any
  const r22 = await quietHoursRefusal(sb as any, CONTRACTOR_PHONE, CORS, "send-sms", at("2026-11-16T03:00:00Z"), (l) => lines.push(l)); // 22:00 EST
  assert(r22);
  assertEquals(r22!.status, 403);
  const body = await r22!.json();
  assertEquals(body.error, "outside_quiet_hours");
  assertEquals(body.next_allowed_at, "2026-11-16T13:00:00.000Z");
  assertEquals(body.window, { start_hour: 8, end_hour: 20 });
  assert(lines.length === 1 && lines[0].includes("to_last4=0123") && !lines[0].includes("3175550123"));
  // deno-lint-ignore no-explicit-any
  assertEquals(await quietHoursRefusal(sb as any, CONTRACTOR_PHONE, CORS, "send-sms", at("2026-11-15T15:00:00Z"), () => {}), null); // 10:00 EST
});

Deno.test("send-sms resolves the recipient by phone: a Pacific contractor is judged in Pacific time", async () => {
  const { sb, seen } = fakeSb([{ contractor_id: "c2" }], [{ timezone: "America/Los_Angeles", address_state: "CA" }]);
  // 21:30 ET = 18:30 PT: allowed for this recipient.
  // deno-lint-ignore no-explicit-any
  assertEquals(await quietHoursRefusal(sb as any, CONTRACTOR_PHONE, CORS, "send-sms", at("2026-11-16T02:30:00Z"), () => {}), null);
  assertEquals(seen, ["from contractor_sms_numbers", "from contractors"]);
});

Deno.test("unknown recipient (no contractor row), lookup error and lookup throw all fall back to the restrictive window", async () => {
  for (const mode of ["ok", "error", "throw"] as const) {
    const { sb } = fakeSb([], [], mode);
    // 10:00 ET: fine for an Eastern contractor but 05:00 in Honolulu -> refused under the fallback.
    // deno-lint-ignore no-explicit-any
    const r = await quietHoursRefusal(sb as any, CONTRACTOR_PHONE, CORS, "send-sms", at("2026-11-15T15:00:00Z"), () => {});
    assert(r, `mode ${mode} must refuse at 10:00 ET`);
    assertEquals((await r!.json()).basis, "fallback_all_us");
    // 14:00 ET (19:00Z) is open in every US zone: goes.
    // deno-lint-ignore no-explicit-any
    assertEquals(await quietHoursRefusal(sb as any, CONTRACTOR_PHONE, CORS, "send-sms", at("2026-11-15T19:00:00Z"), () => {}), null);
  }
});

Deno.test("an unparseable number is judged by the fallback window (never skipped)", async () => {
  const { sb } = fakeSb([], []);
  // deno-lint-ignore no-explicit-any
  assert(await quietHoursRefusal(sb as any, "garbage", CORS, "send-sms", at("2026-11-16T03:00:00Z"), () => {}));
});

Deno.test("OWNER EXEMPTION: exactly the owner number, at 03:00 local, passes with no lookup; a neighbouring number does not", async () => {
  assertEquals(OWNER_ALERT_NUMBER_E164, "+13175019215");
  const { sb, seen } = fakeSb([], [], "throw"); // any DB touch would throw / be recorded
  const night = at("2026-11-16T08:00:00Z"); // 03:00 EST
  // deno-lint-ignore no-explicit-any
  assertEquals(await quietHoursRefusal(sb as any, "+13175019215", CORS, "send-sms", night, () => {}), null);
  // deno-lint-ignore no-explicit-any
  assertEquals(await quietHoursRefusal(sb as any, "(317) 501-9215", CORS, "send-sms", night, () => {}), null);
  assertEquals(seen, []);
  assertEquals(isOwnerAlertNumber("+13175019216"), false);
  assertEquals(isOwnerAlertNumber(null), false);
  assertEquals(isOwnerAlertNumber(""), false);
  // deno-lint-ignore no-explicit-any
  assert(await quietHoursRefusal(sb as any, "+13175019216", CORS, "send-sms", night, () => {}));
});

Deno.test("the exemption is one named constant: no flag, option or request field can bypass the check", async () => {
  const src = await Deno.readTextFile(new URL("./sms-quiet-hours.ts", import.meta.url));
  assertEquals((src.match(/isOwnerAlertNumber\(/g) ?? []).length, 2); // the definition + the single use in quietHoursRefusal
  assert(!/bypass|skipQuiet|force/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
});

// ---- gh-3762 N2: valid column timezone is honoured with no/unknown state; territories are mapped --------------------
Deno.test("N2: a valid column timezone is a candidate even when the state is absent or unmapped (Puerto_Rico, 20:30 AST refused)", () => {
  const t = "2026-12-02T00:30:00Z"; // 20:30 AST (UTC-4), 19:30 EST
  assertEquals(ok(t, { timezone: "America/Puerto_Rico", state: null }), false);
  assertEquals(ok(t, { timezone: "America/Puerto_Rico", state: "ZZ" }), false);
  assertEquals(ok(t, { timezone: "America/Puerto_Rico", state: "PR" }), false);
  assertEquals(ok(t, { timezone: "America/New_York", state: null }), true); // control: same instant with an Eastern column is open in every US zone (19:30 ET)
});

Deno.test("N2: an unmapped state with a valid column zone adds that zone to the all-US fallback; basis stays fallback", () => {
  const c = candidateZones({ timezone: "America/Puerto_Rico", state: null });
  assertEquals(c.basis, "fallback_all_us");
  assert(c.zones.includes("America/Puerto_Rico") && c.zones.length === ALL_US_ZONES.length + 1);
  assertEquals(candidateZones({ timezone: "Not/AZone", state: null }).zones.length, ALL_US_ZONES.length);
});

Deno.test("N2: PR, VI, GU, AS and MP are in the state map", () => {
  assertEquals(candidateZones({ state: "PR" }).zones, ["America/Puerto_Rico"]);
  assertEquals(candidateZones({ state: "vi" }).zones, ["America/Puerto_Rico"]);
  assertEquals(candidateZones({ state: "GU" }).zones, ["Pacific/Guam"]);
  assertEquals(candidateZones({ state: "MP" }).zones, ["Pacific/Guam"]);
  assertEquals(candidateZones({ state: "AS" }).zones, ["Pacific/Pago_Pago"]);
  assertEquals(ok("2026-11-15T21:30:00Z", { state: "GU" }), false); // 07:30 ChST
  assertEquals(ok("2026-11-15T22:00:00Z", { state: "GU" }), true);  // 08:00 ChST
  assert(!ALL_US_ZONES.includes("Pacific/Guam"), "Guam must stay out of the unknown-recipient intersection (it would be empty)");
});
