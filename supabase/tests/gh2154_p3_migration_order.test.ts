// gh-2154 P-3 review round 3 (REVIEW FAIL 5833567534) — fail-first test.
//
// The review found: the trigger migration
// (20260924200316_gh2154_p3_partner_new_alert_trigger.sql) sorts BEFORE the
// column migration (20260925131429_gh2154_p3_notifications_referral_agent_id.sql)
// that adds the column its Edge Function dedupe query needs, and had no
// guard against being applied first. It also found the notifications RLS
// policies were not tightened (a signed-in user could forge/suppress a
// partner alert) and the dedupe unique index was not partial on
// notification_type.
//
// This test reads the migration SQL files as plain text (no DB connection —
// it can run anywhere, including CI, with no Supabase credentials) and
// asserts the structural fixes are present. It FAILS on 8a1ac3b3 (the head
// REVIEW FAIL 5833567534 was filed against) and PASSES once the guard +
// WITH CHECK + partial-index fixes land.
//
// Run: deno test --allow-read=supabase supabase/tests/gh2154_p3_migration_order.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const TRIGGER_MIGRATION_PATH = "supabase/migrations/20260924200316_gh2154_p3_partner_new_alert_trigger.sql";
const COLUMN_MIGRATION_PATH  = "supabase/migrations/20260925131429_gh2154_p3_notifications_referral_agent_id.sql";
const PROOF_SQL_PATH         = "supabase/tests/gh2154_p3_proof.sql";
const SCHEMA_PENDING_PATH    = "sql/schema-pending.json";

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

Deno.test("(a) trigger migration filename still sorts before the column migration filename (unguarded ordering hazard exists at the filesystem level)", () => {
  // This is true both before and after the fix -- the guard, not a
  // rename, is what makes the wrong order safe. Documents the hazard the
  // guard exists to cover.
  const triggerStamp = TRIGGER_MIGRATION_PATH.match(/(\d{14})/)![1];
  const columnStamp  = COLUMN_MIGRATION_PATH.match(/(\d{14})/)![1];
  assertEquals(triggerStamp < columnStamp, true);
});

Deno.test("(b) trigger migration RAISEs an EXCEPTION if notifications.referral_agent_id is missing", async () => {
  const sql = await read(TRIGGER_MIGRATION_PATH);
  // Must reference the column it depends on AND raise, inside a guard that
  // runs before the trigger/function are created (i.e. before "CREATE
  // TRIGGER trg_notify_admin_new_partner").
  const guardIdx  = sql.indexOf("RAISE EXCEPTION");
  const columnIdx = sql.indexOf("notifications.referral_agent_id");
  const createTriggerIdx = sql.indexOf("CREATE TRIGGER trg_notify_admin_new_partner");
  assertEquals(guardIdx > -1, true, "no RAISE EXCEPTION found in the trigger migration");
  assertEquals(columnIdx > -1 && columnIdx < guardIdx, true, "guard does not reference notifications.referral_agent_id before raising");
  assertEquals(guardIdx < createTriggerIdx, true, "guard does not run before the trigger is created");
  assertStringIncludes(sql, "information_schema.columns");
});

Deno.test("(c) column migration's insert policy WITH CHECK forbids a user-authored referral_agent_id", async () => {
  const sql = await read(COLUMN_MIGRATION_PATH);
  const stmt = sql.match(/ALTER POLICY "Authenticated can insert notifications"[\s\S]*?;/)?.[0] ?? "";
  assertEquals(stmt.length > 0, true, "no ALTER POLICY for the insert policy found");
  assertStringIncludes(stmt, "referral_agent_id IS NULL");
});

Deno.test("(d) column migration's update policy WITH CHECK forbids a user-authored referral_agent_id", async () => {
  const sql = await read(COLUMN_MIGRATION_PATH);
  const stmt = sql.match(/ALTER POLICY "Users can update own notifications"[\s\S]*?;/)?.[0] ?? "";
  assertEquals(stmt.length > 0, true, "no ALTER POLICY for the update policy found");
  assertStringIncludes(stmt, "referral_agent_id IS NULL");
});

Deno.test("(e) dedupe unique index is partial on notification_type='admin_new_partner_alert', not just referral_agent_id IS NOT NULL", async () => {
  const sql = await read(COLUMN_MIGRATION_PATH);
  const idxStmt = sql.match(/CREATE UNIQUE INDEX[\s\S]*?notifications_partner_alert_dedupe_idx[\s\S]*?;/)?.[0] ?? "";
  assertEquals(idxStmt.length > 0, true, "no CREATE UNIQUE INDEX for notifications_partner_alert_dedupe_idx found");
  assertStringIncludes(idxStmt, "notification_type = 'admin_new_partner_alert'");
});

Deno.test("(f) proof SQL applies the column migration before the trigger migration", async () => {
  const sql = await read(PROOF_SQL_PATH);
  const columnIdx  = sql.indexOf("ADD COLUMN IF NOT EXISTS referral_agent_id");
  const triggerIdx = sql.indexOf("CREATE TRIGGER trg_notify_admin_new_partner");
  assertEquals(columnIdx > -1, true, "proof SQL does not inline the column migration");
  assertEquals(triggerIdx > -1, true, "proof SQL does not inline the trigger migration");
  assertEquals(columnIdx < triggerIdx, true, "proof SQL applies the trigger before the column it depends on");
});

Deno.test("(g) proof SQL's synthetic insert produces an admin_new_partner_alert notifications row", async () => {
  const sql = await read(PROOF_SQL_PATH);
  assertStringIncludes(sql, "notification_type, referral_agent_id, recipient, message_preview");
  assertStringIncludes(sql, "'admin_new_partner_alert'");
  assertStringIncludes(sql, "synthetic admin_new_partner_alert notification row was not produced");
});

Deno.test("(h) schema-pending.json's notifications note states the corrected go-live order (131429 before the trigger)", async () => {
  const text = await read(SCHEMA_PENDING_PATH);
  const pending = JSON.parse(text);
  const note: string = pending.notifications?.referral_agent_id?.note ?? "";
  assertEquals(note.length > 0, true, "no sql/schema-pending.json notifications.referral_agent_id entry found");
  assertStringIncludes(note, "apply 131429 first");
});
