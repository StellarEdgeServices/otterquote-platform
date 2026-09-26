// deno test --allow-read=. supabase/functions/record-lead-loss-sheet-upload/handler.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  decodedByteLength,
  type Deps,
  handleRequest,
  MAX_BASE64_LENGTH,
  MAX_FILE_BYTES,
  sniffFileType,
  validateBody,
} from "./handler.ts";

const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GOOD_TOKEN = "a".repeat(32);

function b64(bytes: number[] | string): string {
  const arr = typeof bytes === "string" ? Array.from(bytes, (c) => c.charCodeAt(0)) : bytes;
  return btoa(String.fromCharCode(...arr));
}
const PDF = b64("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n");
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HEIC = b64([0, 0, 0, 24, ...Array.from("ftypheic", (c) => c.charCodeAt(0)), 0, 0, 0, 0]);
const HTML = b64("<html><script>alert(1)</script></html>");
const SVG = b64('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function req(body: unknown): Request {
  return new Request("https://x/functions/v1/record-lead-loss-sheet-upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Spy = Deps & { uploads: Array<{ fileName: string; contentType: string }>; rows: Array<Record<string, unknown>>; alerts: string[] };

function baseDeps(overrides: Partial<Deps> = {}): Spy {
  const uploads: Array<{ fileName: string; contentType: string }> = [];
  const rows: Array<Record<string, unknown>> = [];
  const alerts: string[] = [];
  const deps: Deps = {
    resolveLead: (token) => Promise.resolve(token === GOOD_TOKEN ? { leadId: LEAD_ID, isSynthetic: false } : null),
    checkRateLimit: () => Promise.resolve({ allowed: true }),
    uploadToStorage: ({ leadId, fileName, contentType }) => {
      uploads.push({ fileName, contentType });
      return Promise.resolve({ storagePath: `${leadId}/1-${fileName}` });
    },
    insertUploadRow: (row) => {
      rows.push(row as unknown as Record<string, unknown>);
      return Promise.resolve({ id: "upload_1" });
    },
    alert: (_t, m) => { alerts.push(m); return Promise.resolve(); },
    notifyUploadReceived: () => Promise.resolve(),
    ...overrides,
  };
  return Object.assign(deps, { uploads, rows, alerts });
}

// ── D13: magic bytes decide the type ────────────────────────────────────────────
Deno.test("D13: PDF, JPEG, PNG and HEIC are recognised by their leading bytes", () => {
  const head = (s: string) => Uint8Array.from(atob(s.slice(0, 24)), (c) => c.charCodeAt(0));
  assertEquals(sniffFileType(head(PDF))?.contentType, "application/pdf");
  assertEquals(sniffFileType(head(JPEG))?.contentType, "image/jpeg");
  assertEquals(sniffFileType(head(PNG))?.contentType, "image/png");
  assertEquals(sniffFileType(head(HEIC))?.contentType, "image/heic");
  assertEquals(sniffFileType(head(HTML)), null);
  assertEquals(sniffFileType(head(SVG)), null);
});

Deno.test("D13: an HTML file declared as application/pdf and named .pdf is refused, nothing stored", async () => {
  const deps = baseDeps();
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, content_type: "application/pdf", filename: "loss.pdf", file_base64: HTML }), deps);
  assertEquals(res.status, 400);
  assertEquals(deps.uploads.length, 0);
  assertEquals(deps.rows.length, 0);
});

Deno.test("D13: an SVG is refused whatever the client claims", async () => {
  const deps = baseDeps();
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, content_type: "image/png", filename: "x.png", file_base64: SVG }), deps);
  assertEquals(res.status, 400);
  assertEquals(deps.uploads.length, 0);
});

Deno.test("D13: the stored type and extension come from the bytes, not the client (a real PNG named evil.html is stored as upload.png, image/png)", async () => {
  const deps = baseDeps();
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, content_type: "text/html", filename: "evil.html", file_base64: PNG }), deps);
  assertEquals(res.status, 200);
  assertEquals(deps.uploads[0], { fileName: "upload.png", contentType: "image/png" });
  assertEquals(deps.rows[0].contentType, "image/png");
  assertEquals(deps.rows[0].originalFilename, "evil.html");
});

Deno.test("NEGATIVE CONTROL (D13): a real PDF is accepted and stored as upload.pdf", async () => {
  const deps = baseDeps();
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, filename: "loss.pdf", file_base64: PDF }), deps);
  assertEquals(res.status, 200);
  assertEquals(deps.uploads[0], { fileName: "upload.pdf", contentType: "application/pdf" });
  assertEquals(deps.rows[0].byteSize, decodedByteLength(PDF));
});

Deno.test("D13: the base64 cap is exactly a 6 MiB file (8,388,608 chars) -- the client's 6 MiB limit and the server agree", () => {
  assertEquals(MAX_FILE_BYTES, 6291456);
  assertEquals(MAX_BASE64_LENGTH, 8388608);
  assertEquals(decodedByteLength("A".repeat(MAX_BASE64_LENGTH)), MAX_FILE_BYTES);
});

Deno.test("D13: a file of exactly 6 MiB passes validation; one byte more is refused", () => {
  // A 12-char PDF header ("%PDF-1.7\n", 9 bytes) padded with base64 'A' (zero bytes) to the target length.
  const head = btoa("%PDF-1.7\n");
  const pad = (len: number) => head + "A".repeat(len - head.length);
  const atCap = pad(MAX_BASE64_LENGTH);
  assertEquals(validateBody({ lead_token: GOOD_TOKEN, file_base64: atCap }).ok, true);
  const over = pad(MAX_BASE64_LENGTH + 4);
  assertEquals(validateBody({ lead_token: GOOD_TOKEN, file_base64: over }).ok, false);
});

Deno.test("D13: malformed base64 is refused before any storage write", async () => {
  const deps = baseDeps();
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, file_base64: "%%%not-base64%%%" }), deps);
  assertEquals(res.status, 400);
  assertEquals(deps.uploads.length, 0);
});

// ── D11 ─────────────────────────────────────────────────────────────────────────
Deno.test("D11: a synthetic lead's upload row carries is_test=true", async () => {
  const deps = baseDeps({ resolveLead: () => Promise.resolve({ leadId: LEAD_ID, isSynthetic: true }) });
  await handleRequest(req({ lead_token: GOOD_TOKEN, file_base64: PDF }), deps);
  assertEquals(deps.rows[0].isTest, true);
});

// ── token / rate limit negative controls ─────────────────────────────────────────
Deno.test("negative control: a bad/expired token is rejected with 401 and nothing is uploaded or recorded", async () => {
  const deps = baseDeps();
  const res = await handleRequest(req({ lead_token: "b".repeat(32), file_base64: PDF }), deps);
  assertEquals(res.status, 401);
  assertEquals(deps.uploads.length, 0);
  assertEquals(deps.rows.length, 0);
});

Deno.test("negative control: a rate-limited caller is refused before the lead is resolved", async () => {
  let resolved = false;
  const deps = baseDeps({
    checkRateLimit: () => Promise.resolve({ allowed: false }),
    resolveLead: () => { resolved = true; return Promise.resolve(null); },
  });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, file_base64: PDF }), deps);
  assertEquals(res.status, 429);
  assertEquals(resolved, false);
});

Deno.test("a row insert failure after the file landed alerts platform_alerts_log (never silent) and does not ask for a re-upload", async () => {
  const deps = baseDeps({ insertUploadRow: () => Promise.resolve({ error: "boom" }) });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, file_base64: PDF }), deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).recorded, false);
  assertEquals(deps.alerts.length, 1);
  assert(deps.alerts[0].includes(LEAD_ID));
});

Deno.test("a storage failure returns 500 and writes no row", async () => {
  const deps = baseDeps({ uploadToStorage: () => Promise.resolve({ error: "bucket" }) });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, file_base64: PDF }), deps);
  assertEquals(res.status, 500);
  assertEquals(deps.rows.length, 0);
});
