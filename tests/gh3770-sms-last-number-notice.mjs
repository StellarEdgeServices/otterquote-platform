// gh-3770: the last-number opt-out notice. Pure logic, run with Node's type stripping (no Deno needed).
// Run: node tests/gh3770-sms-last-number-notice.mjs
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = process.env.ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const { noticeAfterOptOut, contractorNoticeText, ownerAlertText, CONTRACTOR_SUBJECT } =
  await import(pathToFileURL(join(root, "supabase/functions/_shared/sms-last-number-notice.ts")).href);

const mk = (over = {}) => {
  const sent = [], logs = [];
  return { sent, logs, d: {
    textableCount: async () => 0, contractor: async () => ({ email: "c@example.com", contact_name: "Pat", company_name: "Acme Roofing" }),
    sendEmail: async (to, subject, text) => { sent.push({ to, subject, text }); return true; },
    enabled: true, ownerEmail: "owner@example.com", log: (l) => logs.push(l), ...over } };
};
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };

await t("zero textable numbers: one e-mail to the contractor, one internal alert to the owner", async () => {
  const { d, sent } = mk(); const r = await noticeAfterOptOut(d, ["c1"], "sms STOP");
  assert.deepEqual(r, [{ contractorId: "c1", action: "sent" }]);
  assert.equal(sent.length, 2); assert.equal(sent[0].to, "c@example.com"); assert.equal(sent[0].subject, CONTRACTOR_SUBJECT); assert.equal(sent[1].to, "owner@example.com");
});
await t("NEGATIVE CONTROL: a second verified number (count 1) sends neither e-mail", async () => {
  const { d, sent } = mk({ textableCount: async () => 1 }); const r = await noticeAfterOptOut(d, ["c1"], "sms STOP");
  assert.deepEqual(r, [{ contractorId: "c1", action: "skipped_still_textable" }]); assert.equal(sent.length, 0);
});
await t("a failed lookup (null) fails quiet: nothing sent, logged", async () => {
  const { d, sent, logs } = mk({ textableCount: async () => null }); const r = await noticeAfterOptOut(d, ["c1"], "x");
  assert.equal(r[0].action, "skipped_lookup_failed"); assert.equal(sent.length, 0); assert.equal(logs.length, 1);
});
await t("dark by default: enabled=false sends nothing and logs the decision", async () => {
  const { d, sent, logs } = mk({ enabled: false }); const r = await noticeAfterOptOut(d, ["c1"], "x");
  assert.equal(r[0].action, "logged_dark"); assert.equal(sent.length, 0); assert.match(logs[0], /DARK/);
});
await t("the same contractor id twice in one call is noticed once", async () => {
  const { d, sent } = mk(); await noticeAfterOptOut(d, ["c1", "c1"], "x"); assert.equal(sent.length, 2);
});
await t("no contractor e-mail on file: owner alert still goes, result is partial", async () => {
  const { d, sent } = mk({ contractor: async () => ({ email: null, contact_name: null, company_name: "Acme" }) });
  const r = await noticeAfterOptOut(d, ["c1"], "x"); assert.equal(r[0].action, "partial"); assert.equal(sent.length, 1); assert.equal(sent[0].to, "owner@example.com");
});
await t("neither e-mail carries a phone number; the owner alert is internal text only", async () => {
  const body = contractorNoticeText("Pat") + ownerAlertText("c1", "Acme", "sms STOP");
  assert.ok(!/\+?\d{3}[-.\s)]*\d{3}[-.\s]*\d{4}/.test(body.replace("(844) 875-3412", "")), "no stray phone number");
  assert.ok(contractorNoticeText("Pat").includes("reply START") && contractorNoticeText("Pat").includes("verify the number again in Settings"));
});
console.log(`PASS: gh-3770 ${n} checks`);
