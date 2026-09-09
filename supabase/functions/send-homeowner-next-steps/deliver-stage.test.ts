// gh-1570 / gh-1859 review fix — the three properties the dry-run mode's
// safety actually rests on, each asserted against recording fakes.
//
// PR #1859's REVIEW: FAIL (comment 5584464326) was that these had ZERO
// assertions: "Move that `continue` five lines down in a future refactor and
// the function stamps and emails, with a green suite." These tests are what
// makes that mutant fail.
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { deliverStage, type DeliverDeps, type DeliverCtx } from "./deliver-stage.ts";

const FIXTURE_EMAIL = "fixture-homeowner@example.invalid";

function ctx(overrides: Partial<DeliverCtx> = {}): DeliverCtx {
  return {
    claimId: "11111111-2222-3333-4444-555555555555",
    userId: "66666666-7777-8888-9999-000000000000",
    stage: "2h",
    homeownerEmail: FIXTURE_EMAIL,
    homeownerName: "Fixture Homeowner",
    measurementsUrl: "https://otterquote.com/help-measurements.html",
    colorUrl: "https://otterquote.com/color-selection.html?claim_id=x",
    optOutUrl: "https://example.invalid/functions/v1/homeowner-email-optout?t=TOKEN",
    ...overrides,
  };
}

function fakes(opts: { dryRun: boolean; stampError?: { code?: string; message?: string }; sendOk?: boolean; mailgun?: boolean }) {
  const inserted: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const deps: DeliverDeps = {
    dryRun: opts.dryRun,
    mailgunConfigured: opts.mailgun ?? true,
    buildEmail: (name, m, c, o) => ({
      subject: "You're one step from bids",
      textBody: `Hi ${name},\nbody ${m} ${c}\nStop these updates: ${o}`,
      htmlBody: `<html><a href="${o}">Stop these updates</a></html>`,
    }),
    insertActivityLog: (row) => {
      inserted.push(row);
      return Promise.resolve({ error: opts.stampError ?? null });
    },
    sendEmail: (to) => {
      sent.push(to);
      return Promise.resolve(opts.sendOk === false ? { ok: false, error: "Mailgun 500" } : { ok: true });
    },
  };
  return { deps, inserted, sent };
}

Deno.test("PROPERTY 2 — a dry run performs NO activity_log insert", async () => {
  const { deps, inserted } = fakes({ dryRun: true });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "previewed");
  assertEquals(inserted.length, 0);
});

Deno.test("PROPERTY 3 — a dry run makes NO Mailgun call", async () => {
  const { deps, sent } = fakes({ dryRun: true });
  await deliverStage(deps, ctx());
  assertEquals(sent.length, 0);
});

Deno.test("PII — a preview carries no recipient address anywhere in its payload", async () => {
  const { deps } = fakes({ dryRun: true });
  const outcome = await deliverStage(deps, ctx());
  assert(outcome.kind === "previewed");
  const serialized = JSON.stringify(outcome.preview);
  // The whole point of blocker 2: the address must not leave the function.
  assertEquals(serialized.includes(FIXTURE_EMAIL), false);
  assertEquals(serialized.includes("@"), false);
  // …while still saying a deliverable address WAS resolved.
  assertEquals(outcome.preview.recipient_present, true);
  assertEquals(outcome.preview.claim_id, ctx().claimId);
  assertEquals(outcome.preview.stage, "2h");
});

Deno.test("D-320 — the preview asserts the opt-out link in BOTH bodies", async () => {
  const { deps } = fakes({ dryRun: true });
  const outcome = await deliverStage(deps, ctx());
  assert(outcome.kind === "previewed");
  assertEquals(outcome.preview.has_optout_link_text, true);
  assertEquals(outcome.preview.has_optout_link_html, true);

  // NEGATIVE CONTROL: a renderer that drops the footer from the HTML half
  // only must report has_optout_link_html === false, not true. The first
  // version checked the text body alone and would have said "fine".
  const broken = fakes({ dryRun: true });
  broken.deps.buildEmail = (name, _m, _c, o) => ({
    subject: "s",
    textBody: `Hi ${name}\nStop these updates: ${o}`,
    htmlBody: "<html>no footer here</html>",
  });
  const out2 = await deliverStage(broken.deps, ctx());
  assert(out2.kind === "previewed");
  assertEquals(out2.preview.has_optout_link_text, true);
  assertEquals(out2.preview.has_optout_link_html, false);
});

Deno.test("NEGATIVE CONTROL — a REAL run does stamp once and does send once", async () => {
  const { deps, inserted, sent } = fakes({ dryRun: false });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "sent");
  // Exactly the fail-beside-the-pass the dry-run assertions need: the same
  // fakes, the same call, one flag different, and both effects happen.
  assertEquals(inserted.length, 1);
  assertEquals(sent, [FIXTURE_EMAIL]);
  assertEquals(inserted[0].event_type, "next_steps_nudge_sent");
  assertEquals(inserted[0].is_test, false);
  assertEquals((inserted[0].metadata as Record<string, unknown>).nudge_stage, "2h");
});

Deno.test("a real run stamps BEFORE sending, and a failed stamp sends nothing", async () => {
  const { deps, inserted, sent } = fakes({ dryRun: false, stampError: { message: "boom" } });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "stamp_failed");
  assertEquals(inserted.length, 1);
  assertEquals(sent.length, 0);
});

Deno.test("23505 means a concurrent run won the race — no send, counted separately", async () => {
  const { deps, sent } = fakes({ dryRun: false, stampError: { code: "23505" } });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "already_sent");
  assertEquals(sent.length, 0);
});

Deno.test("MAILGUN_API_KEY unset: stamp recorded, nothing sent (dev/staging)", async () => {
  const { deps, inserted, sent } = fakes({ dryRun: false, mailgun: false });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "sent");
  assertEquals(inserted.length, 1);
  assertEquals(sent.length, 0);
});

Deno.test("a stamped-but-failed send is reported, not counted as sent", async () => {
  const { deps, inserted, sent } = fakes({ dryRun: false, sendOk: false });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "send_failed");
  assertEquals(inserted.length, 1);
  assertEquals(sent.length, 1);
});
