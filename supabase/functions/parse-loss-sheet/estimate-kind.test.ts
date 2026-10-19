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

const err = (message: string) => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });

Deno.test("file-caused provider rejections are 'failed' (413, and a 400 that names the file)", () => {
  assertEquals(isFileRejection(413, "request_too_large"), true);
  assertEquals(isFileRejection(400, err("messages.0.content.0.image.source.base64: image exceeds 5 MB maximum: 5300000 bytes > 5242880 bytes")), true);
  assertEquals(isFileRejection(400, err("messages.0.content.0.document.source.base64.data: The PDF specified was not valid")), true);
  assertEquals(isFileRejection(400, err("The PDF specified is password protected")), true);
  assertEquals(isFileRejection(400, err("PDF has too many pages (limit 100)")), true);
  assertEquals(isFileRejection(400, err("Could not process image")), true);
});
Deno.test("account / config 400s and every other status are NOT the file (transient 502 + alert, never 'failed')", () => {
  assertEquals(isFileRejection(400, err("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")), false);
  assertEquals(isFileRejection(400, err("model: claude-sonnet-x is not a valid model ID")), false);
  assertEquals(isFileRejection(400, err("This organization has been disabled.")), false);
  assertEquals(isFileRejection(400, err("max_tokens: 99999 > 8192, which is the maximum allowed number of output tokens for the model")), false);
  assertEquals(isFileRejection(400, "<html>Bad Request</html>"), false);
  assertEquals(isFileRejection(400, ""), false);
  for (const st of [401, 403, 404, 408, 429, 500, 502, 503, 529]) assertEquals(isFileRejection(st, err("image document pdf")), false);
});
