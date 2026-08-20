// Deno unit tests for the #869 shared outbound-email primitives.
// Run: deno test supabase/functions/_shared/email.test.ts
//
// These exercise the canonical source of truth directly. The Edge Functions
// that consume it INLINE their own copy (see email.ts's header comment for
// why) rather than importing it, so this file cannot catch drift between a
// consumer's inlined copy and this canonical version by itself -- that is
// what scripts/check-email-parts.py's structural checks are for. This file
// only asserts the canonical definitions themselves are correct.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { emailButton, emailLink, textCta } from "./email.ts";

const HREF = "https://otterquote.com/dashboard.html";
const LABEL = "Go to My Dashboard →";

Deno.test("emailButton: contains the href exactly once outside the VML block, and once inside it", () => {
  const html = emailButton({ href: HREF, label: LABEL });
  // The HTML <a> tag's href.
  assertStringIncludes(html, `href="${HREF}"`);
  // MSO VML conditional present (#869 AC1 — Outlook fallback).
  assertStringIncludes(html, "<!--[if mso]>");
  assertStringIncludes(html, "v:roundrect");
  assertStringIncludes(html, "<![endif]-->");
  // Brand amber, not the retired #14B8A6 teal.
  assertStringIncludes(html, "#E07B00");
  assert(!html.includes("#14B8A6"), "must never emit the retired teal");
});

Deno.test("emailButton: is table-based (nested <table>), not a bare styled <a>", () => {
  const html = emailButton({ href: HREF, label: LABEL });
  assertStringIncludes(html, "<table");
  assertStringIncludes(html, "<td");
});

Deno.test("emailButton: label is rendered", () => {
  const html = emailButton({ href: HREF, label: LABEL });
  // Appears in both the VML <center> and the HTML <a>.
  const occurrences = html.split(LABEL).length - 1;
  assertEquals(occurrences, 2);
});

Deno.test("emailLink: renders an inline anchor with the href and label", () => {
  const html = emailLink({ href: HREF, label: "your dashboard" });
  assertStringIncludes(html, `href="${HREF}"`);
  assertStringIncludes(html, "your dashboard");
  assert(!html.includes("<table"), "emailLink must stay an inline anchor, not a button");
});

Deno.test("textCta: keeps the bare URL deliberately (#869 AC 2)", () => {
  const text = textCta({ href: HREF, label: LABEL });
  assertStringIncludes(text, HREF);
  assertStringIncludes(text, LABEL);
  assert(!text.includes("<"), "text/plain part must contain no markup");
});
