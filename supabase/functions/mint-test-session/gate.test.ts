// Deno unit tests for mint-test-session's R-174 gate logic (gh-1513).
// Run: deno test supabase/functions/mint-test-session/gate.test.ts
//
// Exercises resolveAndMint against a fake DbAdapter — no live Supabase
// client, no network access, no network listener (index.ts's serve() is
// never imported here; same source-split pattern as
// notify-contractors/test-exclusion.test.ts).

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  type ActivityLogRow,
  type DbAdapter,
  MAGIC_LINK_EXPIRES_IN,
  resolveAndMint,
  unexpectedErrorResponse,
} from "./gate.ts";

const ACTOR_EMAIL = "dustinstohler1@gmail.com";

function fakeDb(overrides: Partial<DbAdapter> = {}): DbAdapter {
  return {
    getContractorById: async () => ({ data: null, error: null }),
    getClaimsByUserId: async () => ({ data: null, error: null }),
    getAuthUserById: async () => ({ data: null, error: null }),
    generateMagicLink: async () => ({
      data: { action_link: "https://stub.supabase.co/auth/v1/verify?token=stub" },
      error: null,
    }),
    insertActivityLog: async () => ({ error: null }),
    ...overrides,
  };
}

Deno.test("403 on a non-test contractor", async () => {
  const db = fakeDb({
    getContractorById: async () => ({
      data: { id: "c1", user_id: "u1", email: "real-contractor@example.com", is_test: false },
      error: null,
    }),
  });
  const result = await resolveAndMint({ contractor_id: "c1" }, db, ACTOR_EMAIL);
  assertEquals(result.status, 403);
  assertEquals(typeof result.body.error, "string");
});

Deno.test("403 on a homeowner with a non-test claim", async () => {
  const db = fakeDb({
    getClaimsByUserId: async () => ({
      data: [
        { id: "claim1", is_test: true },
        { id: "claim2", is_test: false },
      ],
      error: null,
    }),
  });
  const result = await resolveAndMint({ user_id: "u2" }, db, ACTOR_EMAIL);
  assertEquals(result.status, 403);
});

Deno.test("403 on a homeowner who owns no claims", async () => {
  const db = fakeDb({ getClaimsByUserId: async () => ({ data: [], error: null }) });
  const result = await resolveAndMint({ user_id: "u3" }, db, ACTOR_EMAIL);
  assertEquals(result.status, 403);
});

Deno.test("200 shape on a test contractor (auth admin stubbed)", async () => {
  let generateLinkCalledWith: string | null = null;
  const db = fakeDb({
    getContractorById: async () => ({
      data: {
        id: "c4",
        user_id: "u4",
        email: "test-contractor@otterquote-internal.test",
        is_test: true,
      },
      error: null,
    }),
    generateMagicLink: async (email: string) => {
      generateLinkCalledWith = email;
      return {
        data: { action_link: "https://stub.supabase.co/auth/v1/verify?token=stub4" },
        error: null,
      };
    },
  });
  const result = await resolveAndMint({ contractor_id: "c4" }, db, ACTOR_EMAIL);
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals(result.body.action_link, "https://stub.supabase.co/auth/v1/verify?token=stub4");
  assertEquals(result.body.user_id, "u4");
  assertEquals(result.body.email, "test-contractor@otterquote-internal.test");
  assertEquals(result.body.is_test, true);
  assertEquals(result.body.expires_in, MAGIC_LINK_EXPIRES_IN);
  assertEquals(generateLinkCalledWith, "test-contractor@otterquote-internal.test");
});

Deno.test("activity_log write asserted (event_type, target user_id, actor)", async () => {
  const insertedLogs: ActivityLogRow[] = [];
  const db = fakeDb({
    getContractorById: async () => ({
      data: {
        id: "c5",
        user_id: "u5",
        email: "test-contractor-5@otterquote-internal.test",
        is_test: true,
      },
      error: null,
    }),
    insertActivityLog: async (row) => {
      insertedLogs.push(row);
      return { error: null };
    },
  });
  const result = await resolveAndMint({ contractor_id: "c5" }, db, ACTOR_EMAIL);
  assertEquals(result.status, 200);
  assertEquals(insertedLogs.length, 1);
  assertEquals(insertedLogs[0].event_type, "test_session_minted");
  assertEquals(insertedLogs[0].user_id, "u5");
  assertEquals(insertedLogs[0].is_test, true);
  assertEquals(
    (insertedLogs[0].metadata as Record<string, unknown>).actor,
    ACTOR_EMAIL,
  );
  assertEquals(
    (insertedLogs[0].metadata as Record<string, unknown>).target_user_id,
    "u5",
  );
});

Deno.test("400 when neither contractor_id nor user_id is provided", async () => {
  const db = fakeDb();
  const result = await resolveAndMint({}, db, ACTOR_EMAIL);
  assertEquals(result.status, 400);
});

Deno.test("400 when both contractor_id and user_id are provided", async () => {
  const db = fakeDb();
  const result = await resolveAndMint(
    { contractor_id: "c1", user_id: "u1" },
    db,
    ACTOR_EMAIL,
  );
  assertEquals(result.status, 400);
});

Deno.test("404 when contractor is is_test but has no linked auth user", async () => {
  const db = fakeDb({
    getContractorById: async () => ({
      data: { id: "c6", user_id: null, email: "orphan@example.com", is_test: true },
      error: null,
    }),
  });
  const result = await resolveAndMint({ contractor_id: "c6" }, db, ACTOR_EMAIL);
  assertEquals(result.status, 404);
});

// gh-1562 (js/stack-trace-exposure): index.ts's outer catch calls
// unexpectedErrorResponse for anything that escapes resolveAndMint's own
// gating (e.g. a thrown Error from client construction). The response body
// must never carry the error's message/stack — only a fixed generic
// string — while the real detail still reaches console.error so it is not
// silently lost.
Deno.test("unexpectedErrorResponse: generic body, real detail still logged", () => {
  const loggedCalls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedCalls.push(args);
  };

  try {
    const secretDetail = new Error("Supabase credentials not configured");
    secretDetail.stack = "Error: Supabase credentials not configured\n    at very/internal/path.ts:42:7";
    const result = unexpectedErrorResponse(secretDetail);

    assertEquals(result.status, 500);
    assertEquals(result.body, { error: "Internal server error" });
    assertEquals(JSON.stringify(result.body).includes("very/internal/path.ts"), false);
    assertEquals(JSON.stringify(result.body).includes("Supabase credentials"), false);

    assertEquals(loggedCalls.length, 1);
    const loggedText = Deno.inspect(loggedCalls[0]);
    assertStringIncludes(loggedText, "Supabase credentials not configured");
  } finally {
    console.error = originalConsoleError;
  }
});

// Non-Error throws (a plain string, a rejected value that isn't an Error
// instance) must also collapse to the same fixed generic body — the sink
// discipline does not depend on what shape the thrown value happens to be.
Deno.test("unexpectedErrorResponse: non-Error throw still yields the generic body", () => {
  const originalConsoleError = console.error;
  let called = false;
  console.error = () => {
    called = true;
  };

  try {
    const result = unexpectedErrorResponse("raw string throw with internal detail");
    assertEquals(result.status, 500);
    assertEquals(result.body, { error: "Internal server error" });
    assertEquals(called, true);
  } finally {
    console.error = originalConsoleError;
  }
});
