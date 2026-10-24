import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { detectEstimateKind, isFileRejection, MAX_IMAGE_BYTES } from "./estimate-kind.ts";

const pad = (head: number[], n = 64) => Uint8Array.from([...head, ...new Array(Math.max(0, n - head.length)).fill(0)]);

Deno.test("PDF is a document block", () => {
  assertEquals(detectEstimateKind(pad([0x25, 0x50, 0x44, 0x46, 0x2d])), { block: "document", mediaType: "application/pdf" });
});
Deno.test("JPEG and PNG are image blocks with their real media type (they used to be sent as application/pdf)", () => {
  assertEquals(detectEstimateKind(pad([0xff, 0xd8, 0xff, 0xe0])), { block: "image", mediaType: "image/jpeg" });
  assertEquals(detectEstimateKind(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { block: "image", mediaType: "image/png" });
});
Deno.test("Word (.docx is a zip, .doc is OLE), HEIC, text and empty files are unsupported", () => {
  assertEquals(detectEstimateKind(pad([0x50, 0x4b, 0x03, 0x04])), null);
  assertEquals(detectEstimateKind(pad([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), null);
  assertEquals(detectEstimateKind(pad([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])), null);
  assertEquals(detectEstimateKind(new Uint8Array(0)), null);
  assertEquals(detectEstimateKind(new TextEncoder().encode("hello")), null);
});
Deno.test("the image cap is the raw size whose BASE64 fits in 5 MiB (3,932,160), not 5 MiB raw", () => {
  assertEquals(MAX_IMAGE_BYTES, 3932160);
  assertEquals(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 <= 5 * 1024 * 1024, true);
  const ok = new Uint8Array(MAX_IMAGE_BYTES); ok[0] = 0xff; ok[1] = 0xd8; ok[2] = 0xff;
  assertEquals(detectEstimateKind(ok)?.block, "image");
  const big = new Uint8Array(4 * 1024 * 1024); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff; // 4 MiB raw = 5.33 MiB base64
  assertEquals(detectEstimateKind(big), null);
});
Deno.test("an image over the provider's 5 MB limit is unsupported; a PDF of that size is not judged here", () => {
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  assertEquals(detectEstimateKind(big), null);
});

// Real provider error bodies (the reviewer's fixtures, REVIEW 6277457123 / 9a38cdeb probe).
const e = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message }, request_id: "req_011CTestAbc" });
const I = (m: string) => e("invalid_request_error", m);
const CASES: Array<[string, number, string, boolean]> = [
  ["image too large (base64 > 5 MB)", 400, I("messages.0.content.0.image.source.base64: image exceeds 5 MB maximum: 7062432 bytes > 5242880 bytes"), true],
  ["image dimensions too large", 400, I("messages.0.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels"), true],
  ["PDF too many pages", 400, I("messages.0.content.0.document.source.base64.data: A maximum of 100 PDF pages may be provided."), true],
  ["PDF not valid", 400, I("messages.0.content.0.document.source.base64.data: The PDF specified was not valid."), true],
  ["PDF password protected", 400, I("messages.0.content.0.document.source.base64.data: The PDF specified is password protected."), true],
  ["unsupported media type", 400, I("messages.0.content.0.image.source.base64.media_type: Input should be 'image/jpeg', 'image/png', 'image/gif' or 'image/webp'"), true],
  ["media type mismatch", 400, I("messages.0.content.0.image.source.base64.data: Image does not match the provided media type image/jpeg"), true],
  ["could not process image", 400, I("Could not process image"), true],
  ["prompt too long (huge PDF)", 400, I("prompt is too long: 215832 tokens > 200000 maximum"), true],
  ["input + max_tokens exceed context (huge PDF, N1)", 400, I("input length and `max_tokens` exceed context limit: 194120 + 8000 > 200000, decrease input length or `max_tokens` and try again"), true],
  ["413 request_too_large", 413, e("request_too_large", "Request exceeds the maximum allowed number of bytes."), true],
  ["credit balance too low", 400, I("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."), false],
  ["API usage limits reached", 400, I("You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."), false],
  ["workspace usage limits", 400, I("You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."), false],
  ["organization disabled", 400, I("This organization has been disabled."), false],
  ["authentication_error 401", 401, e("authentication_error", "invalid x-api-key"), false],
  ["permission_error 403", 403, e("permission_error", "Your API key does not have permission to use the specified resource."), false],
  ["billing_error 402", 402, e("billing_error", "Your account has an outstanding balance."), false],
  ["not_found model 404", 404, e("not_found_error", "model: claude-sonnet-4-6-typo"), false],
  ["model id invalid at 400", 400, I("model: claude-sonnet-x is not a valid model ID"), false],
  ["max_tokens over model cap (4096 cap model)", 400, I("max_tokens: 8000 > 4096, which is the maximum allowed number of output tokens for claude-3-haiku-20240307"), false],
  ["max_tokens over model cap (8192 cap model)", 400, I("max_tokens: 8000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-haiku-20241022"), false],
  ["bad anthropic-version header", 400, I("anthropic-version: invalid version"), false],
  ["document block unsupported by model", 400, I("messages.0.content.0: PDF input is not supported by this model"), false],
  ["overloaded 529", 529, e("overloaded_error", "Overloaded"), false],
  ["rate limit 429", 429, e("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"), false],
  ["api_error 500", 500, e("api_error", "Internal server error"), false],
  ["gateway html 400", 400, "<html><body>400 Bad Request</body></html>", false],
  ["empty body 400", 400, "", false],
];
for (const [name, status, body, want] of CASES) {
  Deno.test(`isFileRejection: ${name} -> ${want ? "file ('failed')" : "NOT the file (502 + alert, no mark)"}`, () => {
    assertEquals(isFileRejection(status, body), want);
  });
}
