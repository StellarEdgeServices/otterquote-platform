// owner-alert-sweep/sweep.ts
//
// gh-3428: pure logic for the owner phone alert, split out of index.ts (same source-split pattern as vault-resync/gate.ts and
// send-sms/sender-selection.ts) so it is unit-testable with no live Supabase client, no Twilio account and no call.
// Nothing here reads a phone number, a name, an address or an e-mail: the spoken text is built from event_kind, state and claim_id only.

export type EventKind = "measurement_paid" | "claim_bidding";

export interface LeasedAlert {
  id: string;
  event_kind: EventKind | string;
  claim_id: string;
  state: string | null;
  attempts: number;
}

export const MAX_ATTEMPTS = 3;
export const SPOKEN_REPEATS = 3;

// ---------------------------------------------------------------------------
// Caller gate: the service-role key only (same primitive as send-sms authorizeServiceOnly, gh-1916). The public anon key is a valid JWT,
// so verify_jwt = true would let it through; this function is therefore deployed with verify_jwt = false and refuses everything but the exact key.
// ---------------------------------------------------------------------------
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export type GateResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

export function authorizeServiceOnly(authHeader: string, serviceRoleKey: string): GateResult {
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "Authentication required" };
  if (!serviceRoleKey) return { ok: false, status: 403, error: "Forbidden: service role required" };
  if (!constantTimeEqual(token, serviceRoleKey)) return { ok: false, status: 403, error: "Forbidden: service role required" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Spoken message. Event kind, state, claim id, three times. Claim id is spoken as its first 8 characters (a full 32-character id three times
// is over a minute of speech); the full id is in owner_alerts.claim_id and the prefix finds the claim.
// ---------------------------------------------------------------------------
const EVENT_PHRASE: Record<string, string> = {
  measurement_paid: "Measurement purchase",
  claim_bidding: "New claim open for bids",
};

export function shortClaimId(claimId: string): string {
  return claimId.replace(/[^0-9a-fA-F]/g, "").slice(0, 8).toLowerCase();
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Owner-only test invocation (POST {"test_call": true} with the service-role key): not a real event, never stored. */
export const TEST_CALL_KIND = "test_call";
const TEST_CALL_TEXT = "This is a test of the owner alert system. No customer event has happened. This is only a test.";

/** True only for a JSON body whose test_call is the boolean true. Anything else (no body, bad JSON, "true", 1) is a normal sweep. */
export async function isTestCallRequest(req: Request): Promise<boolean> {
  try {
    const b = await req.json() as { test_call?: unknown } | null;
    return b !== null && typeof b === "object" && b.test_call === true;
  } catch {
    return false;
  }
}

export function buildTwiml(alert: Pick<LeasedAlert, "event_kind" | "state" | "claim_id">): string {
  if (alert.event_kind === TEST_CALL_KIND) {
    return `<Response>${`<Say voice="alice">${TEST_CALL_TEXT}</Say><Pause length="1"/>`.repeat(2)}</Response>`;
  }
  const phrase = EVENT_PHRASE[alert.event_kind] ?? "Owner alert";
  const st = (alert.state ?? "").trim().toUpperCase();
  const stateText = /^[A-Z]{2}$/.test(st)
    ? `State <say-as interpret-as="characters">${st}</say-as>.`
    : "State unknown.";
  const idText = `Claim <say-as interpret-as="characters">${xmlEscape(shortClaimId(alert.claim_id))}</say-as>.`;
  const once = `<Say voice="alice">${xmlEscape(phrase)}. ${stateText} ${idText}</Say><Pause length="1"/>`;
  return `<Response>${once.repeat(SPOKEN_REPEATS)}</Response>`;
}

// ---------------------------------------------------------------------------
// Twilio Programmable Voice. Secrets are read by NAME from the environment by index.ts and passed in; none is ever logged or returned.
// ---------------------------------------------------------------------------
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string; // existing Twilio number (TWILIO_PHONE_NUMBER)
  to: string;   // OWNER_ALERT_PHONE
}

export class CallError extends Error {
  /** A fixed code: never a response body, a number or a URL. */
  code: string;
  constructor(code: string) {
    super(code);
    this.name = "CallError";
    this.code = code;
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export const TWILIO_TIMEOUT_MS = 8000;

/** Place one call. Returns the call SID. Throws CallError with a fixed code on any failure. */
export async function placeCall(cfg: TwilioConfig, alert: LeasedAlert, fetchFn: FetchFn): Promise<string> {
  const body = new URLSearchParams({
    To: cfg.to,
    From: cfg.from,
    Twiml: buildTwiml(alert),
    Timeout: "30",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TWILIO_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${cfg.accountSid}:${cfg.authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (e) {
    // Name only: a network error's message can carry the request URL.
    throw new CallError(e instanceof Error && e.name === "AbortError" ? "twilio_timeout" : "twilio_network");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let twilioCode = "";
    try {
      const j = await res.json() as { code?: unknown };
      if (typeof j.code === "number") twilioCode = `_code_${j.code}`;
    } catch { /* body unreadable: status alone */ }
    throw new CallError(`twilio_http_${res.status}${twilioCode}`);
  }
  let sid = "";
  try {
    const j = await res.json() as { sid?: unknown };
    if (typeof j.sid === "string") sid = j.sid;
  } catch { /* accepted but unreadable: still a placed call */ }
  return sid || "sid_unreadable";
}

// ---------------------------------------------------------------------------
// One sweep tick. Dependencies are injected. Every failure is contained: nothing here throws to the caller, and no dependency touches a payment table.
// ---------------------------------------------------------------------------
export interface SweepDeps {
  claimBatch: () => Promise<LeasedAlert[]>;
  place: (alert: LeasedAlert) => Promise<string>;
  mark: (id: string, ok: boolean, sid: string | null, error: string | null) => Promise<string | null>;
  report: (err: unknown, ctx: { op: string; extra?: Record<string, unknown> }) => Promise<void>;
}

export interface SweepResult {
  leased: number;
  called: number;
  retry: number;
  failed_final: number;
  error?: string;
}

export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const result: SweepResult = { leased: 0, called: 0, retry: 0, failed_final: 0 };
  let batch: LeasedAlert[];
  try {
    batch = await deps.claimBatch();
  } catch (e) {
    result.error = "claim_batch_failed";
    await safeReport(deps, e, { op: "claim_batch" });
    return result;
  }
  result.leased = batch.length;
  for (const alert of batch) {
    try {
      const sid = await deps.place(alert);
      await deps.mark(alert.id, true, sid, null);
      result.called++;
    } catch (e) {
      const code = e instanceof CallError ? e.code : "call_failed";
      let status: string | null = null;
      try {
        status = await deps.mark(alert.id, false, null, code);
      } catch (markErr) {
        await safeReport(deps, markErr, { op: "mark_failed", extra: { alert_id: alert.id } });
      }
      if (status === "failed_final") result.failed_final++;
      else result.retry++;
      await safeReport(deps, e, {
        op: status === "failed_final" ? "call_failed_final" : "call_failed",
        extra: { alert_id: alert.id, event_kind: alert.event_kind, attempts: alert.attempts, code },
      });
    }
  }
  return result;
}

async function safeReport(deps: SweepDeps, err: unknown, ctx: { op: string; extra?: Record<string, unknown> }): Promise<void> {
  try {
    await deps.report(err, ctx);
  } catch { /* reporting must never throw */ }
}
