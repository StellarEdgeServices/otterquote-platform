// gh-2462 -- TEST-ONLY kit shared by the <fn>/caller-gate.test.ts files (never imported by
// an index.ts, so the "deploy path does not resolve _shared/" constraint does not apply).
//
// Gives each test a counting fake for the two I/O doors an Edge Function has:
//   - global fetch (Stripe, Mailgun, other EFs), replaced for the duration of one call;
//   - the supabase client, injected through the handler's `makeClient` parameter.
// A 401/403 with `fetchCalls === 0 && clientCalls.length === 0` proves the gate ran before
// any DB read, vendor call, email or refund.

export const SERVICE_KEY = "fixture-runtime-service-key-0123456789"; // runtime SUPABASE_SERVICE_ROLE_KEY
export const SECRET_DEFAULT = "fixture-rotated-default-key-9876543210"; // SUPABASE_SECRET_KEYS.default (vault cron key / docusign-webhook)
// Three-segment fixtures (the shape looksLikeJwt() admits) -- not real tokens, and
// deliberately not `eyJ...` so the credential sweep's JWT_SHAPED class stays clean.
export const ANON_JWT = "fixture-anon-header.fixture-anon-payload.fixture-anon-signature";
export const PUBLISHABLE = "sb_publishable_fixture";
export const USER_JWT = "fixture-user-header.fixture-user-payload.fixture-user-signature";
export const USER_ID = "7d6c5b4a-3f2e-4d1c-8b0a-9e8f7d6c5b4a";
export const OTHER_USER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";

export type Env = Record<string, string | undefined>;
export const BASE_ENV: Env = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_DEFAULT }),
  MAILGUN_API_KEY: "fixture-mailgun",
  MAILGUN_DOMAIN: "mail.example.test",
  STRIPE_SECRET_KEY: "fixture-stripe",
};

/** The bearers that must be refused, with a label for assertion messages. */
export const BAD_BEARERS: readonly [string, string | null][] = [
  ["no Authorization header", null],
  ["anon key (legacy JWT shape)", `Bearer ${ANON_JWT}`],
  ["anon key (sb_publishable_)", `Bearer ${PUBLISHABLE}`],
  ["wrong bearer", "Bearer wrong"],
  ["near-miss service key (+x)", `Bearer ${SERVICE_KEY}x`],
  ["near-miss service key (-1)", `Bearer ${SERVICE_KEY.slice(0, -1)}`],
  ["near-miss secret default (+x)", `Bearer ${SECRET_DEFAULT}x`],
  ["non-Bearer scheme", `Basic ${SERVICE_KEY}`],
  ["empty bearer", "Bearer "],
  ["key without scheme", SERVICE_KEY],
];

export type Rows = Record<string, Record<string, unknown>[]>;

/**
 * Fake supabase client factory. Every query resolves to `rows[table]` (filters are
 * ignored); auth.getUser accepts only USER_JWT (as `userId`). Every touch is recorded.
 */
export function fakeSupabase(rows: Rows = {}, userId: string = USER_ID) {
  const calls: string[] = [];
  const builder = (table: string): unknown => {
    const b: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve({ data: rows[table] ?? [], error: null }).then(res, rej);
        }
        if (prop === "single" || prop === "maybeSingle") {
          return () => {
            calls.push(`${table}.${String(prop)}`);
            return Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null });
          };
        }
        return (..._args: unknown[]) => {
          calls.push(`${table}.${String(prop)}`);
          return b;
        };
      },
    });
    return b;
  };
  // deno-lint-ignore no-explicit-any
  const make = ((_url: string, _key: string) => {
    calls.push("createClient");
    return {
      from: (t: string) => {
        calls.push(`from:${t}`);
        return builder(t);
      },
      rpc: (n: string) => {
        calls.push(`rpc:${n}`);
        return Promise.resolve({ data: null, error: null });
      },
      auth: {
        getUser: (tok: string) => {
          calls.push("auth.getUser");
          return Promise.resolve(
            tok === USER_JWT
              ? { data: { user: { id: userId } }, error: null }
              : { data: { user: null }, error: { message: "invalid JWT" } },
          );
        },
      },
    };
  }) as any;
  return { make, calls };
}

/** Runs `fn` with global fetch replaced by a counting stub answering `{"id":"stub"}` 200. */
export async function withFetchStub<T>(fn: () => Promise<T>): Promise<{ result: T; fetchCalls: string[] }> {
  const realFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    fetchCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(new Response(JSON.stringify({ id: "stub" }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  try {
    return { result: await fn(), fetchCalls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

export function req(url: string, body: unknown, auth: string | null, method = "POST"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== null) headers.Authorization = auth;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
