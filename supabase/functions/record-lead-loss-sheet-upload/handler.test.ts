// deno test --allow-read=. supabase/functions/record-lead-loss-sheet-upload/handler.test.ts
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { handleRequest, MAX_BASE64_LENGTH, safeFileName, validateBody, type Deps } from "./handler.ts";

const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GOOD_TOKEN = "a".repeat(32);
const SMALL_PDF_B64 = btoa("not really a pdf but fine for a unit test");

function req(body: unknown): Request {
  return new Request("https://x/functions/v1/record-lead-loss-sheet-upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    resolveLead: (token) => Promise.resolve(token === GOOD_TOKEN ? { leadId: LEAD_ID } : null),
    checkRateLimit: () => Promise.resolve({ allowed: true }),
    uploadToStorage: ({ leadId, fileName }) => Promise.resolve({ storagePath: `${leadId}/123-${fileName}` }),
    insertUploadRow: () => Promise.resolve({ id: "upload_1" }),
    notifyUploadReceived: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("validateBody rejects an unsupported content type", () => {
  const v = validateBody({ lead_token: GOOD_TOKEN, content_type: "application/x-msdownload", file_base64: SMALL_PDF_B64 });
  assertEquals(v.ok, false);
});

Deno.test("validateBody rejects an oversized payload", () => {
  const v = validateBody({ lead_token: GOOD_TOKEN, content_type: "application/pdf", file_base64: "a".repeat(MAX_BASE64_LENGTH + 1) });
  assertEquals(v.ok, false);
});

Deno.test("validateBody accepts a well-formed request", () => {
  const v = validateBody({ lead_token: GOOD_TOKEN, content_type: "application/pdf", file_base64: SMALL_PDF_B64, filename: "loss-sheet.pdf" });
  assertEquals(v.ok, true);
});

Deno.test("safeFileName never echoes the caller's raw filename, only a safe extension", () => {
  assertEquals(safeFileName("../../etc/passwd.pdf"), "upload.pdf");
  assertEquals(safeFileName("normal.PDF"), "upload.pdf");
  assertEquals(safeFileName(undefined), "upload");
  assertEquals(safeFileName("no-extension-at-all"), "upload");
});

Deno.test("happy path: uploads and records a row for a valid token", async () => {
  const res = await handleRequest(
    req({ lead_token: GOOD_TOKEN, content_type: "application/pdf", file_base64: SMALL_PDF_B64, filename: "loss-sheet.pdf" }),
    baseDeps(),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.upload_id, "upload_1");
});

Deno.test("NEGATIVE CONTROL: a bad/expired token is rejected with 401 and nothing is ever uploaded or recorded", async () => {
  let uploadCalled = false;
  let insertCalled = false;
  const deps = baseDeps({
    resolveLead: () => Promise.resolve(null),
    uploadToStorage: () => {
      uploadCalled = true;
      return Promise.resolve({ storagePath: "should/never/exist" });
    },
    insertUploadRow: () => {
      insertCalled = true;
      return Promise.resolve({ id: "should_never_exist" });
    },
  });
  const res = await handleRequest(
    req({ lead_token: "b".repeat(32), content_type: "application/pdf", file_base64: SMALL_PDF_B64 }),
    deps,
  );
  assertEquals(res.status, 401);
  assertEquals(uploadCalled, false);
  assertEquals(insertCalled, false);
});

Deno.test("NEGATIVE CONTROL: rate-limited caller is refused before the lead is resolved or anything is uploaded", async () => {
  let resolveCalled = false;
  let uploadCalled = false;
  const deps = baseDeps({
    checkRateLimit: () => Promise.resolve({ allowed: false, reason: "too_many" }),
    resolveLead: () => {
      resolveCalled = true;
      return Promise.resolve({ leadId: LEAD_ID });
    },
    uploadToStorage: () => {
      uploadCalled = true;
      return Promise.resolve({ storagePath: "should/never/exist" });
    },
  });
  const res = await handleRequest(
    req({ lead_token: GOOD_TOKEN, content_type: "application/pdf", file_base64: SMALL_PDF_B64 }),
    deps,
  );
  assertEquals(res.status, 429);
  assertEquals(resolveCalled, false);
  assertEquals(uploadCalled, false);
});

Deno.test("a storage upload failure never proceeds to record a row for a nonexistent file", async () => {
  let insertCalled = false;
  const deps = baseDeps({
    uploadToStorage: () => Promise.resolve({ error: "storage down" }),
    insertUploadRow: () => {
      insertCalled = true;
      return Promise.resolve({ id: "should_never_exist" });
    },
  });
  const res = await handleRequest(
    req({ lead_token: GOOD_TOKEN, content_type: "application/pdf", file_base64: SMALL_PDF_B64 }),
    deps,
  );
  assertEquals(res.status, 500);
  assertEquals(insertCalled, false);
});

Deno.test("GET is rejected with 405", async () => {
  const res = await handleRequest(new Request("https://x/functions/v1/record-lead-loss-sheet-upload", { method: "GET" }), baseDeps());
  assertEquals(res.status, 405);
});
