// Deno unit test for gh-1824 footer-batch-6: footer-append.ts must put the
// D-237 postal address into both the HTML and plain-text bodies.
// Run: deno test supabase/functions/notify-admin-new-partner/footer-append.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { appendPostalFooterHtml, appendPostalFooterText } from "./footer-append.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 notify-admin-new-partner: appendPostalFooterHtml inserts the address before </body> and keeps the original markup", () => {
  const out = appendPostalFooterHtml("<html><body><p>Hi</p></body></html>");
  assertEquals(out, `<html><body><p>Hi</p><div style="margin-top:6px;">${POSTAL_ADDRESS}</div></body></html>`);
});

Deno.test("gh-1824 notify-admin-new-partner: appendPostalFooterHtml appends when there is no </body>", () => {
  assertEquals(appendPostalFooterHtml("<p>Hi</p>"), `<p>Hi</p><div style="margin-top:6px;">${POSTAL_ADDRESS}</div>`);
});

Deno.test("gh-1824 notify-admin-new-partner: appendPostalFooterText appends the address as a final paragraph", () => {
  assertEquals(appendPostalFooterText("Hi there"), `Hi there\n\n${POSTAL_ADDRESS}`);
});
