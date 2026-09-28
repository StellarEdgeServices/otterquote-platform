// Deno unit test for gh-1824 footer-batch-2: send-welcome-email's rendered
// email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/send-welcome-email/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildWelcomeHtml, buildWelcomeText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const GREETING = "Acme Roofing";
const SETTINGS_URL = "https://otterquote.com/contractor-settings.html";

Deno.test("gh-1824 send-welcome-email: buildWelcomeHtml includes the D-237 postal address", () => {
  const html = buildWelcomeHtml(GREETING, SETTINGS_URL);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 send-welcome-email: buildWelcomeText includes the D-237 postal address", () => {
  const text = buildWelcomeText(GREETING, SETTINGS_URL);
  assertEquals(text.includes(POSTAL_ADDRESS), true);
});
