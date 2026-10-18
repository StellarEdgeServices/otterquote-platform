// gh-1916 / LEGAL-READ F3 (PR #2722, comment 6158665986): the two highest-frequency
// contractor texts, HOURLY_SMS and WARNING_SMS, must name the sender ("Otter Quotes: ")
// like the other contractor SMS bodies. index.ts calls serve() at import time, so this
// reads it as text (comments stripped), like send-wiring.test.ts.
// Run: deno test --allow-read=supabase/functions supabase/functions/process-dunning/sms-sender-id.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const PREFIX = "Otter Quotes: ";

export function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The first string literal of `const <name> = ...` (the start of the SMS body), or null. */
export function smsBodyStart(src: string, name: string): string | null {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*(?:"|\`)([^"\`]*)`));
  return m ? m[1] : null;
}

async function indexSource(): Promise<string> {
  return stripComments(await Deno.readTextFile(new URL("./index.ts", import.meta.url)));
}

for (const name of ["HOURLY_SMS", "WARNING_SMS"]) {
  Deno.test(`gh-1916 process-dunning: ${name} starts with the sender name`, async () => {
    const start = smsBodyStart(await indexSource(), name);
    assert(start !== null, `${name} not found in index.ts`);
    assert(start!.startsWith(PREFIX), `${name} starts with ${JSON.stringify(start!.slice(0, 30))}, expected "${PREFIX}"`);
  });
}

Deno.test("gh-1916 process-dunning: the two inline outcome texts (proceed, lost) also name the sender", async () => {
  const src = await indexSource();
  assert(/const proceedSMS = `Otter Quotes: /.test(src));
  assert(/const lostSMS = `Otter Quotes: /.test(src));
});

// Negative controls: the check must FAIL on a body without the prefix.
Deno.test("negative control: HOURLY_SMS without the prefix is detected", () => {
  const bad = `const HOURLY_SMS =\n  "You have a signed contract waiting for you" +\n  "x";`;
  assertEquals(smsBodyStart(bad, "HOURLY_SMS")!.startsWith(PREFIX), false);
});
Deno.test("negative control: a prefix inside a comment does not count", () => {
  const bad = `// "Otter Quotes: "\nconst WARNING_SMS =\n  "You have a signed contract" +\n  "x";`;
  assertEquals(smsBodyStart(stripComments(bad), "WARNING_SMS")!.startsWith(PREFIX), false);
});
Deno.test("positive control: the prefixed body passes", () => {
  const good = `const HOURLY_SMS =\n  "Otter Quotes: You have a signed contract" +\n  "x";`;
  assert(smsBodyStart(good, "HOURLY_SMS")!.startsWith(PREFIX));
});
