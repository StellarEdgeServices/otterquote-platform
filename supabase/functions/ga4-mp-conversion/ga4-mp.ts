// gh-3051 -- GA4 Measurement Protocol v2 sender for the three homeowner conversions, sent from the server at row insert so a
// visitor's blocker / GPC / privacy setting cannot drop them (#1940 DECIDED 6369440672; evidence 6369429483: 1 of 4 real claims
// reached GA4 from the browser).
//
// Local module, NO imports, on purpose: the Edge Function body-deploy path does not resolve ../_shared imports (see create-invoice's
// header), and this file is unit-tested under plain `deno test` with no --allow-net.
//
// Rails (each has a test in handler.test.ts):
//   * no personal data: the payload carries a one-way hash as client_id and a short closed set of params -- never email, phone,
//     name, address, or a raw lead / user / claim id. assertNoPii() re-scans the serialised body and refuses to send on a hit.
//   * never throws: every failure (no secret, timeout, network error, non-2xx, bad JSON) comes back as a result object.
//   * bounded: 3 s abort timeout. The caller is a pg_net trigger that already ignores the response, so the user's insert is never
//     waiting on this.

export const GA4_MEASUREMENT_ID = "G-D1Y1TLGEFY"; // property 541423859 web stream (public id, also in every page's gtag config)
export const MP_COLLECT_URL = "https://www.google-analytics.com/mp/collect";
export const MP_DEBUG_URL = "https://www.google-analytics.com/debug/mp/collect";
export const SEND_TIMEOUT_MS = 3000;

export type ConversionKind = "lead" | "profile" | "claim";

/** The three conversions, keyed by the DB table whose INSERT is the moment of record. */
export const EVENT_FOR_KIND: Record<ConversionKind, string> = {
  lead: "router_contact_submitted",
  profile: "sign_up",
  claim: "claim_started",
};

export interface ConversionRow {
  kind: ConversionKind;
  /** The row's own id. Used ONLY to derive the hashed client_id and the idempotency marker; never sent. */
  id: string;
  /** Owning auth user id for a claim / profile (so a user's sign_up and claim_started share one client_id). Never sent. */
  userId?: string | null;
  isTest?: boolean | null;
  isSynthetic?: boolean | null;
  /** Used only to exclude internal addresses. Never sent. */
  email?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  /** Router arm for a lead (leads.variant). */
  variant?: string | null;
  /** 'email' | 'google' | ... for a sign_up. */
  method?: string | null;
  /** Row created_at, ISO. Used for timestamp_micros so a late send keeps the true event time. */
  createdAt?: string | null;
}

/** Hex SHA-256. crypto.subtle is a Deno / browser global. */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stable, one-way GA4 client_id in GA's own "<digits>.<digits>" shape. Same id in -> same client_id out, so a user's sign_up and
 * claim_started land on one GA4 user. The salt makes it useless as a lookup key outside GA4.
 */
export async function clientIdFor(id: string): Promise<string> {
  const h = await sha256Hex("oq-ga4-mp-v1:" + id);
  const a = parseInt(h.slice(0, 8), 16);
  const b = parseInt(h.slice(8, 16), 16);
  return `${a}.${b}`;
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PHONE_RE = /(?:\+?\d[\s().-]?){10,}/;

/** A utm / arm value: short, plain, and not shaped like personal data. Anything odd becomes undefined (dropped). */
export function cleanParam(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, 100);
  if (!t) return undefined;
  if (EMAIL_RE.test(t) || UUID_RE.test(t) || PHONE_RE.test(t)) return undefined;
  return t;
}

export interface Ga4Payload {
  client_id: string;
  timestamp_micros?: number;
  events: Array<{ name: string; params: Record<string, string | number> }>;
}

/** Throws only on an internal-consistency failure (a bug), which the sender catches and reports -- it never reaches the caller. */
export function assertNoPii(payload: unknown, row: ConversionRow): void {
  const s = JSON.stringify(payload);
  // client_id ("<digits>.<digits>") and timestamp_micros are long digit runs by design, so the phone-shape scan covers events only.
  const ev = JSON.stringify((payload as Ga4Payload).events ?? payload);
  if (EMAIL_RE.test(s)) throw new Error("ga4-mp: payload contains an email-shaped value");
  if (UUID_RE.test(s)) throw new Error("ga4-mp: payload contains a uuid-shaped value");
  if (PHONE_RE.test(ev)) throw new Error("ga4-mp: payload contains a phone-shaped value");
  for (const raw of [row.id, row.userId, row.email]) {
    if (raw && s.includes(raw)) throw new Error("ga4-mp: payload contains a raw row value");
  }
}

export async function buildPayload(row: ConversionRow): Promise<Ga4Payload> {
  const name = EVENT_FOR_KIND[row.kind];
  // A lead keys on its own id; a profile or claim keys on the auth user, so sign_up and claim_started stitch to one user.
  const keyId = row.kind === "lead" ? row.id : (row.userId || row.id);
  const params: Record<string, string | number> = {
    event_source: "server", // lets GA4 reports split / de-duplicate against the unchanged browser events
    engagement_time_msec: 1,
  };
  const arm = cleanParam(row.variant);
  if (arm) params.arm = arm;
  const src = cleanParam(row.utmSource);
  if (src) params.source = src;
  const med = cleanParam(row.utmMedium);
  if (med) params.medium = med;
  const method = cleanParam(row.method);
  if (method && row.kind === "profile") params.method = method;
  const payload: Ga4Payload = { client_id: await clientIdFor(keyId), events: [{ name, params }] };
  const t = row.createdAt ? Date.parse(row.createdAt) : NaN;
  // GA4 accepts backdating up to 72 h; outside that window leave it off and GA4 stamps receipt time.
  if (Number.isFinite(t) && Date.now() - t >= 0 && Date.now() - t < 71 * 3600 * 1000) payload.timestamp_micros = t * 1000;
  assertNoPii(payload, row);
  return payload;
}

export interface SendResult {
  sent: boolean;
  reason?: string; // fixed vocabulary, no values
  status?: number;
  validationMessages?: unknown[];
}

export interface SendOptions {
  secret: string | undefined;
  debug?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (m: string) => void;
}

/** Posts one event. NEVER throws. */
export async function sendGa4(row: ConversionRow, opts: SendOptions): Promise<SendResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const name = EVENT_FOR_KIND[row.kind];
  try {
    if (!opts.secret) {
      log(`[gh-3051] ga4_mp ${name} not sent: GA4_MP_API_SECRET is not set`);
      return { sent: false, reason: "no_secret" };
    }
    const payload = await buildPayload(row);
    const base = opts.debug ? MP_DEBUG_URL : MP_COLLECT_URL;
    const url = `${base}?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${encodeURIComponent(opts.secret)}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? SEND_TIMEOUT_MS);
    try {
      const res = await (opts.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      let validationMessages: unknown[] | undefined;
      if (opts.debug) {
        try { validationMessages = (await res.json())?.validationMessages; } catch { /* ignore */ }
      } else {
        try { await res.body?.cancel(); } catch { /* ignore */ }
      }
      if (res.status < 200 || res.status >= 300) {
        log(`[gh-3051] ga4_mp ${name} not accepted: HTTP ${res.status}`);
        return { sent: false, reason: "http_error", status: res.status };
      }
      return { sent: true, status: res.status, validationMessages };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // Fixed text only: the error may embed the request URL, which carries the secret.
    log(`[gh-3051] ga4_mp ${name} not sent: ${e instanceof Error && e.name === "AbortError" ? "timeout" : "send_error"}`);
    return { sent: false, reason: e instanceof Error && e.name === "AbortError" ? "timeout" : "send_error" };
  }
}
