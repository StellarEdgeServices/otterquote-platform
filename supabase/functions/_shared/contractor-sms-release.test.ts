// D-391 / #2875: contractor SMS release gate. Run: deno test --allow-read=supabase/functions supabase/functions/_shared/contractor-sms-release.test.ts
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { contractorSmsReleaseGate, logContractorSmsRefusal, maskPhoneLast4, TCR_RELEASE_ENV } from "./contractor-sms-release.ts";

const env = (v?: string) => (n: string) => (n === TCR_RELEASE_ENV ? v : undefined);
function run(c: { id?: string; is_test?: boolean | null } | null | undefined, v?: string, phones: string[] = ["+13175551234"]) {
  const logs: string[] = [];
  const verdict = contractorSmsReleaseGate(c, { site: "t", phones, getEnv: env(v), log: (l) => logs.push(l) });
  return { verdict, logs };
}

Deno.test("non-test contractor, not released -> refused and logged (masked, with id and reason)", () => {
  const { verdict, logs } = run({ id: "c-real", is_test: false });
  assertEquals(verdict, { allowed: false, reason: "tcr_not_released" });
  assertEquals(logs.length, 1);
  assert(logs[0].includes('"reason":"tcr_not_released"'));
  assert(logs[0].includes('"contractor_id":"c-real"'));
  assert(logs[0].includes("***1234"));
  assertFalse(logs[0].includes("3175551234"));
});

Deno.test("is_test contractor -> allowed, nothing logged, regardless of the switch", () => {
  for (const v of [undefined, "false", "true"]) {
    const { verdict, logs } = run({ id: "c-test", is_test: true }, v);
    assertEquals(verdict, { allowed: true, via: "is_test" });
    assertEquals(logs.length, 0);
  }
});

Deno.test("non-test contractor, released (exactly 'true') -> allowed", () => {
  const { verdict, logs } = run({ id: "c-real", is_test: false }, "true");
  assertEquals(verdict, { allowed: true, via: "tcr_released" });
  assertEquals(logs.length, 0);
});

Deno.test("switch values other than exactly 'true' stay gated", () => {
  for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    assertEquals(run({ id: "c", is_test: false }, v).verdict.allowed, false, `value=${JSON.stringify(v)}`);
  }
});

Deno.test("unknown is_test (null / undefined / missing contractor) -> refused, even if released is unset", () => {
  assertEquals(run({ id: "c", is_test: null }).verdict.allowed, false);
  assertEquals(run({ id: "c" }).verdict.allowed, false);
  assertEquals(run(null).verdict.allowed, false);
  assertEquals(run(undefined).verdict.allowed, false);
});

Deno.test("unreadable env -> fail closed", () => {
  const logs: string[] = [];
  const v = contractorSmsReleaseGate({ id: "c", is_test: false }, { site: "t", getEnv: () => { throw new Error("denied"); }, log: (l) => logs.push(l) });
  assertEquals(v.allowed, false);
  assertEquals(logs.length, 1);
});

Deno.test("maskPhoneLast4 keeps only the last four digits", () => {
  assertEquals(maskPhoneLast4("(317) 555-1234"), "***1234");
  assertEquals(maskPhoneLast4("12"), "***");
  assertEquals(maskPhoneLast4(null), "***");
});

Deno.test("refusal logger also serves the unverified_number reason (verified-list layer)", () => {
  const logs: string[] = [];
  logContractorSmsRefusal("unverified_number", "c1", { site: "t", phones: ["317-555-9876"], log: (l) => logs.push(l) });
  assert(logs[0].includes('"reason":"unverified_number"'));
  assert(logs[0].includes("***9876"));
  assertFalse(logs[0].includes("5559876"));
});

Deno.test("static: every contractor-recipient send file calls the release gate; homeowner/relay files do not", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(`../${p}`, import.meta.url));
  for (const p of ["notify-contractors/index.ts", "process-dunning/index.ts"]) {
    assert(/contractorSmsReleaseGate\s*\(/.test(await read(p)), `${p} must call contractorSmsReleaseGate`);
  }
  assertFalse((await read("send-sms/index.ts")).includes("contractorSmsReleaseGate"));
});
