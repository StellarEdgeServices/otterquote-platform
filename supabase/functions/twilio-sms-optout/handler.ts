/**
 * twilio-sms-optout -- D-391 layer 2 (#2875): the STOP / START side of the verified-number list.
 *
 * Twilio posts every inbound text here (messaging-service incoming-message webhook). With Advanced Opt-Out
 * enabled, Twilio adds `OptOutType` (STOP | START | HELP) and itself sends the single confirmation / HELP
 * reply. This function therefore SENDS NOTHING (no Twilio Messages call, no e-mail): it only keeps our list true.
 *
 *   STOP  -> open a row on public.sms_suppression_list for the sender's number FIRST (the sender read
 *            contractor_textable_numbers() excludes it at once), then mark every verified row for that number
 *            'opted_out' (the DB promotes the next-oldest verified number to primary).
 *   START -> release the open suppression row ONLY when the text was literally "START" (Ben's ruling,
 *            #2875 comment 6281163859: START only; UNSTOP / YES / a re-verification code do not release).
 *            The number is NOT re-added: the contractor must verify it again with a code.
 *   FREE TEXT -> any other body that contains an opt-out keyword as a WHOLE WORD ("please stop texting me", "stop by
 *            tomorrow", "opt-out") PAUSES every send to the number and queues it for human review on
 *            public.sms_optout_review (Marty's ruling, #2875 comment 6365843245: pause first, review second). It is NOT
 *            recorded as an opt-out, and nothing is suppressed or flipped, until a person reviews it.
 *   HELP / anything else -> no change (D-391: the HELP auto-reply changes nothing).
 *
 * Fails closed: no TWILIO_AUTH_TOKEN, no TWILIO_INBOUND_WEBHOOK_URL (the exact URL Twilio signs), or a bad
 * X-Twilio-Signature -> 403 and nothing is written. Writes are idempotent, so a Twilio retry after a 500 is safe.
 *
 * NOT in this layer (owed, needs wording or a decision): the e-mail to the contractor, the notice to Dustin,
 * the on-screen banner, and the review screen that clears or confirms a flagged number.
 */

export const FUNCTION_NAME = "twilio-sms-optout";

export interface Deps {
  env: (name: string) => string | undefined;
  now: () => Date;
  /** Open a suppression row for the number (no-op if one is already open); returns true on success. */
  suppress: (phone: string, keyword: string, atIso: string) => Promise<boolean>;
  /** Mark every verified row for the number opted_out (SMS keyword channel); returns true on success. */
  markOptedOut: (phone: string, keyword: string, atIso: string) => Promise<boolean>;
  /** Release the open suppression row with released_keyword = START; returns true on success. */
  release: (phone: string, atIso: string) => Promise<boolean>;
  /** Pause the number and queue the message for review (idempotent on messageSid); returns true on success. */
  flag: (phone: string, body: string, keywords: string[], messageSid: string | null, atIso: string) => Promise<boolean>;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const twiml = () => new Response(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } });
const refuse = (status: number) => new Response("", { status });

/** Twilio's request signature: base64(HMAC-SHA1(authToken, url + sorted(key+value...))). */
export async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Standard opt-out keywords, matched on the whole signed Body after trim, whitespace-collapse and upper-casing.
 * Sources: SMS terms in the CEO110 legal read s1b (STOP, END, CANCEL, QUIT, UNSUBSCRIBE, REVOKE, OPT OUT); s3 of that
 * read ("reasonable per se" list; Twilio also covers OPTOUT); STOPALL is Twilio's standard keyword. Exact match only:
 * free-text such as "stop by tomorrow" is NOT an opt-out here (free-text flagging is a later layer).
 */
export const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  "STOP", "STOPALL", "END", "CANCEL", "QUIT", "UNSUBSCRIBE", "REVOKE", "OPTOUT", "OPT OUT",
]);
export const normalizeBody = (b: string) => b.trim().replace(/\s+/g, " ").toUpperCase();

/**
 * Whole-word opt-out keyword finder for FREE TEXT (the pause-and-review flagger). Case-insensitive. A keyword counts only
 * when the characters on both sides are not letters, digits or underscore, so "stop" matches in "please stop texting me",
 * "stop by tomorrow", "STOP." and "stop-over", but NOT in "stopped by", "nonstop", "STOPPING", "unstoppable", "endpoint"
 * or "weekend". The two-word keyword OPT OUT also matches with a hyphen ("opt-out"). Returns the distinct keywords found,
 * upper-cased, in the order they appear. Deliberately broad: a false hit only pauses a number until a person looks at it.
 */
// Keywords are plain letters and one space, so no regex escaping is needed; the space becomes "whitespace or hyphen".
const KEYWORD_ALT = [...OPT_OUT_KEYWORDS].map((k) => k.replace(/ /g, "[\\s-]+")).join("|");
const KEYWORD_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(${KEYWORD_ALT})(?![\\p{L}\\p{N}_])`, "giu");
export function findOptOutKeywords(body: string): string[] {
  const found: string[] = [];
  for (const m of (body || "").matchAll(KEYWORD_RE)) {
    const k = m[1].toUpperCase().replace(/[\s-]+/g, " ");
    if (!found.includes(k)) found.push(k);
  }
  return found;
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method !== "POST") return refuse(405);
  const token = d.env("TWILIO_AUTH_TOKEN");
  const url = d.env("TWILIO_INBOUND_WEBHOOK_URL");
  if (!token || !url) return refuse(403);

  const params: Record<string, string> = {};
  try {
    for (const [k, v] of new URLSearchParams(await req.text())) params[k] = v;
  } catch {
    return refuse(400);
  }
  const given = req.headers.get("X-Twilio-Signature") || "";
  if (!given || !timingSafeEqual(given, await twilioSignature(token, url, params))) return refuse(403);

  const phone = (params.From || "").trim();
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) return twiml(); // not a number we can key on; nothing to do
  const type = (params.OptOutType || "").trim().toUpperCase();
  const body = normalizeBody(params.Body || "");
  const at = d.now().toISOString();

  // Honour STOP from the signed Body itself, whether or not Twilio tagged it (REVIEW 6323770893: no fail-open).
  if (type === "STOP" || OPT_OUT_KEYWORDS.has(body)) {
    const keyword = body.slice(0, 32);
    // Order matters: the suppression row is the write that stops texts; the status flip is bookkeeping.
    if (!(await d.suppress(phone, keyword, at))) return refuse(500);
    if (!(await d.markOptedOut(phone, keyword, at))) return refuse(500);
    return twiml();
  }
  if (type === "START" && body === "START") {
    if (!(await d.release(phone, at))) return refuse(500);
    return twiml();
  }
  // Free text that mentions an opt-out keyword as a whole word: pause + queue for review (never a silent drop: a failed
  // write is a 500 so Twilio retries, because losing a possible revocation is the one outcome we cannot accept).
  const keywords = findOptOutKeywords(params.Body || "");
  if (keywords.length > 0) {
    const sid = (params.MessageSid || params.SmsSid || "").trim() || null;
    if (!(await d.flag(phone, (params.Body || "").slice(0, 1600), keywords, sid, at))) return refuse(500);
    return twiml();
  }
  return twiml(); // HELP, UNSTOP, YES, ordinary replies: no change
}
