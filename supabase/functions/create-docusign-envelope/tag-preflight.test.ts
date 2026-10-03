// gh-1314 — the send-time preflight. Every refusal is paired with an acceptance by the same code.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assertNoLabeledSignTags, LabeledSignTagError, LABELED_SIGN_TAG_CODE, preflightTemplateTags } from "./tag-preflight.ts";

const enc = (s: string) => btoa(s);
const GOOD = "Agreement {{text|1|*|Customer Name|customer_name}} {{sign|1|*||contractor_signature}} {{date|1|*||contractor_signature_date}} {{sign|2|*||homeowner_signature}}";
const BAD = "Agreement {{text|1|*|Customer Name|customer_name}} {{sign|1|*|Contractor Signature|contractor_signature}} {{date|1|*|Contractor Sign Date|contractor_signature_date}}";

Deno.test("preflight: empty-label template passes (control)", async () => {
  const r = await preflightTemplateTags(enc("pdf"), "ctx", () => Promise.resolve(GOOD));
  assertEquals(r, { scanned: true });
});

Deno.test("preflight: labeled sign/date REFUSES with a clear error naming each tag", async () => {
  const err = await assertRejects(
    () => preflightTemplateTags(enc("pdf"), "contractor_sign template for contractor C1", () => Promise.resolve(BAD)),
    LabeledSignTagError,
  );
  assertEquals(err.code, LABELED_SIGN_TAG_CODE);
  assertEquals(err.statusCode, 422);
  assertEquals(err.violations.length, 2);
  assertStringIncludes(err.message, "refusing to send to BoldSign");
  assertStringIncludes(err.message, "{{sign|1|*|Contractor Signature|contractor_signature}}");
  assertStringIncludes(err.message, "{{date|1|*||contractor_signature_date}}");
});

Deno.test("preflight: no send happens — the guard runs before any fetch (nothing to un-record)", async () => {
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { fetched++; return Promise.resolve(new Response("{}")); }) as typeof fetch;
  try {
    await assertRejects(() => preflightTemplateTags(enc("pdf"), "ctx", () => Promise.resolve(BAD)), LabeledSignTagError);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(fetched, 0);
});

Deno.test("preflight: an extraction failure does not block the send (logged, scanned:false)", async () => {
  const orig = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    const r = await preflightTemplateTags(enc("pdf"), "ctx", () => Promise.reject(new Error("pdfjs boom")));
    assertEquals(r, { scanned: false });
  } finally {
    console.error = orig;
  }
  assert(logged.some((l) => l.includes("WITHOUT the labeled-tag check")));
});

Deno.test("assertNoLabeledSignTags: throws for labeled, silent for text-only labels", () => {
  assertNoLabeledSignTags("{{text|1|*|Label|id}}", "ctx");
  let threw = false;
  try { assertNoLabeledSignTags("{{init|1|*|I|id}}", "ctx"); } catch (e) { threw = e instanceof LabeledSignTagError; }
  assert(threw);
});

Deno.test("wiring: index.ts runs the preflight before each template-carrying /v1/document/send, and maps the error to 422", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const sends = [...src.matchAll(/`\$\{BOLDSIGN_API_BASE\}\/v1\/document\/send`/g)].map((m) => m.index!);
  const pre = [...src.matchAll(/await preflightTemplateTags\(templateBase64,/g)].map((m) => m.index!);
  assertEquals(pre.length, 2, "handleContractorSign and handleLegacyFlow");
  // each preflight precedes the send that follows it, with no other send in between
  for (const p of pre) {
    const next = sends.find((s) => s > p);
    assert(next !== undefined, "a send follows the preflight");
    assertEquals(sends.filter((s) => s > p && s < next!).length, 0);
  }
  assertStringIncludes(src, "error instanceof LabeledSignTagError");
});
