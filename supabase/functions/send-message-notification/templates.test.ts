// Deno unit test for gh-1824 footer-batch-2: send-message-notification's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/send-message-notification/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmail, messageNotificationText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 send-message-notification: buildEmail includes the D-237 postal address", () => {
  const html = buildEmail("<p>You have a new message.</p>");
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 send-message-notification: messageNotificationText includes the D-237 postal address", () => {
  const text = messageNotificationText(
    "Jane",
    "Acme Roofing",
    "Hey, following up on the estimate",
    false,
    "https://otterquote.com/dashboard",
  );
  assertEquals(text.includes(POSTAL_ADDRESS), true);
});
