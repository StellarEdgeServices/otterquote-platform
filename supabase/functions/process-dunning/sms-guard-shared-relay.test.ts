// gh-3773 (PR #3789 review): process-dunning now imports _shared/sms-suppression.ts. The gh-2884 transport guard
// (sms-all-bodies.test.ts, UNCHANGED) scans every local module process-dunning imports and forbids a second SMS transport.
// This test proves that guard still catches a send-sms relay placed in that shared helper, and that the real helper is clean.
// Run: deno test --allow-read=supabase/functions supabase/functions/process-dunning/sms-guard-shared-relay.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { localImports, stripComments, transportCheck } from "./sms-all-bodies.test.ts";

async function loadModules(): Promise<Map<string, string>> {
  const mods = new Map<string, string>();
  const queue: URL[] = [new URL("./index.ts", import.meta.url)];
  while (queue.length) {
    const url = queue.pop()!;
    if (mods.has(url.href)) continue;
    const src = stripComments(await Deno.readTextFile(url));
    mods.set(url.href, src);
    for (const rel of localImports(src)) queue.push(new URL(rel, url));
  }
  return mods;
}
const SUPPRESSION = (m: Map<string, string>) => [...m.keys()].find((h) => h.endsWith("_shared/sms-suppression.ts"))!;

Deno.test("the real shared suppression helper is clean under the UNCHANGED transport guard (and is in the scanned module set)", async () => {
  const mods = await loadModules();
  assert(SUPPRESSION(mods), "process-dunning must import _shared/sms-suppression.ts for this test to mean anything");
  assertEquals(transportCheck(mods), []);
  assert(!/send-sms/.test(mods.get(SUPPRESSION(mods))!), "no send-sms string in the helper's code");
});

Deno.test("NEGATIVE CONTROL: a send-sms relay added to the shared helper is caught by the guard (functions.invoke and fetch forms)", async () => {
  for (const relay of [
    'export async function relay(sb: any) { return await sb.functions.invoke("send-sms", { body: {} }); }',
    'export async function relay(u: string) { return await fetch(`${u}/functions/v1/send-sms`, { method: "POST" }); }',
    'export const t = "https://api.twilio.com/2010-04-01/Accounts/x/Messages.json";',
  ]) {
    const mods = await loadModules();
    const k = SUPPRESSION(mods);
    mods.set(k, mods.get(k)! + "\n" + relay);
    const v = transportCheck(mods);
    assert(v.length > 0, `the guard missed: ${relay}`);
    assert(v.every((x) => x.includes("sms-suppression.ts")), JSON.stringify(v));
  }
});
