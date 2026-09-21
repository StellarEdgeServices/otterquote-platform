// gh-1570 / gh-1859 review fix — the three properties the dry-run mode's
// safety actually rests on, each asserted against recording fakes.
//
// PR #1859's REVIEW: FAIL (comment 5584464326) was that these had ZERO
// assertions: "Move that `continue` five lines down in a future refactor and
// the function stamps and emails, with a green suite." These tests are what
// makes that mutant fail.
//
// gh-2069 UPDATE: the stamp order flipped (send first, then record the
// outcome — see deliver-stage.ts's file header for why), and every real send
// now also writes a `notifications` row carrying Mailgun's message id. These
// tests were rewritten to assert the NEW order and the new row, not just
// patched to keep passing.
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { deliverStage, type DeliverDeps, type DeliverCtx, type NotificationRow } from "./deliver-stage.ts";

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

function fakes(opts: {
  dryRun: boolean;
  stampError?: { code?: string; message?: string };
  sendOk?: boolean;
  mailgun?: boolean;
  mailgunId?: string;
}) {
  const inserted: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const notifications: NotificationRow[] = [];
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
      return Promise.resolve(
        opts.sendOk === false
          ? { ok: false, error: "Mailgun 500" }
          : { ok: true, mailgunId: opts.mailgunId ?? "<20260921000000.abc123@mail.otterquote.com>" },
      );
    },
    insertNotification: (row) => {
      notifications.push(row);
      return Promise.resolve({ error: null });
    },
  };
  return { deps, inserted, sent, notifications };
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

Deno.test("PROPERTY 4 — a dry run writes NO notifications row", async () => {
  const { deps, notifications } = fakes({ dryRun: true });
  await deliverStage(deps, ctx());
  assertEquals(notifications.length, 0);
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

Deno.test("gh-2069 — a real accepted send calls Mailgun BEFORE stamping activity_log", async () => {
  const { deps, inserted, sent } = fakes({ dryRun: false });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "sent");
  assertEquals(inserted.length, 1);
  assertEquals(sent, [FIXTURE_EMAIL]);
  assertEquals(inserted[0].event_type, "next_steps_nudge_sent");
  assertEquals(inserted[0].is_test, false);
  assertEquals(inserted[0].title, "Next-steps nudge sent (+2h)");
  assertEquals((inserted[0].metadata as Record<string, unknown>).nudge_stage, "2h");
});

Deno.test("gh-2069 — an accepted send writes ONE notifications row with delivered=true and the Mailgun id", async () => {
  const { deps, notifications } = fakes({ dryRun: false, mailgunId: "<msg-123@mail.otterquote.com>" });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "sent");
  assertEquals(notifications.length, 1);
  assertEquals(notifications[0].delivered, true);
  assertEquals(notifications[0].mailgun_id, "<msg-123@mail.otterquote.com>");
  assertEquals(notifications[0].channel, "email");
  assertEquals(notifications[0].recipient, FIXTURE_EMAIL);
  assertEquals(notifications[0].notification_type, "homeowner_next_steps_2h");
  assertEquals(notifications[0].claim_id, ctx().claimId);
});

Deno.test("gh-2069 — a rejected send writes a FAILED activity_log line, not a 'Sent' one, and NO auto-retry stamp swallowing", async () => {
  const { deps, inserted, sent } = fakes({ dryRun: false, sendOk: false });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "send_failed");
  // Mailgun WAS called (this is the point — no stamp exists yet to have
  // prevented the attempt).
  assertEquals(sent.length, 1);
  assertEquals(inserted.length, 1);
  assertEquals((inserted[0].title as string).startsWith("FAILED +2h nudge:"), true);
  assertEquals((inserted[0].title as string).includes("Mailgun 500"), true);
  assertEquals((inserted[0].metadata as Record<string, unknown>).send_failed, true);
});

Deno.test("gh-2069 — a rejected send writes ONE notifications row with delivered=false, no mailgun id, and the error", async () => {
  const { deps, notifications } = fakes({ dryRun: false, sendOk: false });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "send_failed");
  assertEquals(notifications.length, 1);
  assertEquals(notifications[0].delivered, false);
  assertEquals(notifications[0].mailgun_id, null);
  assertEquals(notifications[0].message_preview.includes("Mailgun 500"), true);
});

Deno.test("23505 on the post-send record means a concurrent run already recorded this send — still counted, still logged", async () => {
  const { deps, sent, notifications } = fakes({ dryRun: false, stampError: { code: "23505" } });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "already_sent");
  // gh-2069: the send already happened by the time the 23505 is seen — this
  // branch no longer PREVENTS a concurrent double-send (see file header for
  // the trade-off); it only detects one, after the fact. The notifications
  // row is still written so this send is not the one left unrecorded.
  assertEquals(sent.length, 1);
  assertEquals(notifications.length, 1);
  assertEquals(notifications[0].delivered, true);
});

Deno.test("MAILGUN_API_KEY unset: nothing sent (dev/staging), outcome still recorded", async () => {
  const { deps, inserted, sent, notifications } = fakes({ dryRun: false, mailgun: false });
  const outcome = await deliverStage(deps, ctx());
  assertEquals(outcome.kind, "sent");
  assertEquals(inserted.length, 1);
  assertEquals(sent.length, 0);
  assertEquals(notifications.length, 1);
  assertEquals(notifications[0].delivered, true);
  assertEquals(notifications[0].mailgun_id, null);
});
