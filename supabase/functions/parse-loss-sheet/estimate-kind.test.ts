import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { detectEstimateKind, MAX_IMAGE_BYTES } from "./estimate-kind.ts";

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
Deno.test("an image over the provider's 5 MB limit is unsupported; a PDF of that size is not judged here", () => {
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  assertEquals(detectEstimateKind(big), null);
});
