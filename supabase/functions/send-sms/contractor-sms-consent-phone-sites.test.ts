// gh-1916 / D-383: every contractor SMS send site takes its recipient list from
// consentedSmsRecipients() and no longer reads notification_phones or a profile/account phone for SMS.
// Static source guard (like contractor-sms-send-sites.test.ts). NEGATIVE CONTROLS at the bottom.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-sms/contractor-sms-consent-phone-sites.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

// path (relative to supabase/functions) -> how many recipient lists it must build from the helper
const SITES: Record<string, number> = {
  "notify-contractors/index.ts": 3,
  "process-dunning/index.ts": 1,
  "send-contractor-nudge/index.ts": 1,
};

/** Strip // and /* *\/ comments so a commented-out call does not count. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

export function violations(path: string, src: string, want: number): string[] {
  const code = stripComments(src);
  const v: string[] = [];
  const calls = (code.match(/\bconsentedSmsRecipients\s*\(/g) ?? []).length;
  if (calls < want) v.push(`${path}: ${calls} consentedSmsRecipients() call(s), need >= ${want}`);
  if (!/from\s+"\.\.\/_shared\/sms-consent-phone\.ts"/.test(code)) v.push(`${path}: does not import ../_shared/sms-consent-phone.ts`);
  // The old recipient sources must not feed an SMS list any more.
  if (/\bphones\.push\(\s*\.\.\.\s*contractor\.notification_phones/.test(code)) v.push(`${path}: pushes notification_phones into the SMS list`);
  if (/\brawPhones\b/.test(code)) v.push(`${path}: still builds rawPhones from notification_phones / phone`);
  if (/profile\??\.phone\b/.test(code)) v.push(`${path}: reads a profile phone for SMS`);
  if (/contractor\.notification_phones\s*\)\s*\{\s*for\b/.test(code)) v.push(`${path}: loops notification_phones for SMS`);
  if (!/sms_consent_phone/.test(code)) v.push(`${path}: never selects sms_consent_phone`);
  return v;
}

for (const [path, want] of Object.entries(SITES)) {
  Deno.test(`D-383 recipient source: ${path}`, async () => {
    const src = await Deno.readTextFile(new URL(`../${path}`, import.meta.url));
    assertEquals(violations(path, src, want), []);
  });
}

Deno.test("NEGATIVE CONTROL: the pre-D-383 shape is flagged", () => {
  const old = `const rawPhones = contractor.notification_phones?.length > 0 ? contractor.notification_phones : [contractor.phone];`;
  assert(violations("x.ts", old, 1).length >= 3);
});
Deno.test("NEGATIVE CONTROL: a commented-out helper call does not count", () => {
  const src = `import { consentedSmsRecipients } from "../_shared/sms-consent-phone.ts";\n// const p = consentedSmsRecipients(c);\nconst sms_consent_phone = 1;`;
  assert(violations("x.ts", src, 1).some((s) => s.includes("0 consentedSmsRecipients")));
});
