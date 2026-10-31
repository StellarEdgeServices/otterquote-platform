/**
 * D-391 / #2875 layer 4: the ONE place a contractor-facing SMS sender gets its recipient numbers.
 *
 * D-391 makes the one-time-code-verified NUMBER the unit of consent. Every contractor SMS sender
 * (notify-contractors, process-dunning, send-contractor-nudge) must text ONLY the numbers returned by
 * public.contractor_textable_numbers(contractor_id) (service_role only; status verified, confirmed within 395 days,
 * not on the suppression list, not paused by a pending free-text opt-out review). It must NOT fall back to
 * contractors.notification_phones, contractors.phone, profiles.phone or contractors.sms_opt_in.
 *
 * A contractor with no verified number gets no text. The skip is logged as one structured line with reason
 * `unverified_number` (see contractor-sms-release.ts). Email is unaffected.
 *
 * Fails closed: an rpc error, a missing contractor id, or a malformed row all resolve to "no recipients" (never to
 * "send anyway"). The lookup is a pure read; it never writes.
 *
 * Consent record: for each number returned, one structured line `contractor_sms_verified_recipient` is logged with the
 * masked number, the number id, verified_at and the disclosure version id read from contractor_sms_numbers, so the
 * production probe can paste the consent record beside the send. A failed consent-record read does not block the send
 * (the number is already verified per the function); the fields are logged as null.
 *
 * Order at a send site: the is_test / TCR release gate (contractor-sms-release.ts) stays IN FRONT of this lookup.
 */
import { logContractorSmsRefusal, maskPhoneLast4 } from "./contractor-sms-release.ts";

export const TEXTABLE_RPC = "contractor_textable_numbers";

/** One row of public.contractor_textable_numbers(uuid). */
export interface TextableNumberRow {
  number_id: string;
  phone_e164: string;
  is_primary: boolean;
}

export interface ConsentRecord {
  verified_at: string | null;
  disclosure_version_id: string | null;
}

export interface TextableRecipient {
  /** E.164, as stored on the verified-number record. The only value a sender may pass to Twilio / send-sms. */
  phone: string;
  number_id: string;
  is_primary: boolean;
  consent: ConsentRecord;
}

/** The slice of the supabase-js client this module needs (structural, so tests can fake it). */
export interface TextableClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

export interface ResolveOptions {
  /** Call-site label for the log lines, e.g. "notify-contractors/new_opportunity". */
  site: string;
  /** Defaults to console.warn; injectable for tests. */
  log?: (line: string) => void;
  /** Defaults to console.log for the verified-recipient line; injectable for tests. */
  info?: (line: string) => void;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * The numbers this contractor may be texted, primary first. Empty = send nothing (and a refusal with reason
 * `unverified_number` has already been logged).
 */
export async function resolveContractorTextableNumbers(
  sb: TextableClient,
  contractorId: string | null | undefined,
  opts: ResolveOptions,
): Promise<TextableRecipient[]> {
  const refuse = (detail: string): TextableRecipient[] => {
    logContractorSmsRefusal("unverified_number", contractorId, { site: opts.site, phones: [], log: opts.log, detail });
    return [];
  };
  if (!contractorId) return refuse("no_contractor_id");

  let rows: TextableNumberRow[] = [];
  try {
    const { data, error } = await sb.rpc(TEXTABLE_RPC, { p_contractor_id: contractorId });
    if (error) return refuse("lookup_failed");
    rows = Array.isArray(data) ? (data as TextableNumberRow[]) : [];
  } catch {
    return refuse("lookup_failed");
  }

  const seen = new Set<string>();
  const valid: TextableNumberRow[] = [];
  for (const r of rows) {
    const phone = typeof r?.phone_e164 === "string" ? r.phone_e164 : "";
    if (!E164.test(phone) || !r.number_id || seen.has(phone)) continue;
    seen.add(phone);
    valid.push({ number_id: r.number_id, phone_e164: phone, is_primary: r.is_primary === true });
  }
  if (valid.length === 0) return refuse("no_verified_number");

  const consent = new Map<string, ConsentRecord>();
  try {
    const { data } = await sb
      .from("contractor_sms_numbers")
      .select("id, verified_at, disclosure_version_id")
      .in("id", valid.map((v) => v.number_id)) as { data: Array<{ id: string; verified_at: string | null; disclosure_version_id: string | null }> | null };
    for (const c of data ?? []) {
      consent.set(c.id, { verified_at: c.verified_at ?? null, disclosure_version_id: c.disclosure_version_id ?? null });
    }
  } catch {
    // logged as null below; never blocks a verified number
  }

  const info = opts.info ?? ((l: string) => console.log(l));
  return valid.map((v) => {
    const rec: TextableRecipient = {
      phone: v.phone_e164,
      number_id: v.number_id,
      is_primary: v.is_primary,
      consent: consent.get(v.number_id) ?? { verified_at: null, disclosure_version_id: null },
    };
    info(`[contractor-textable] ${JSON.stringify({
      event: "contractor_sms_verified_recipient",
      contractor_id: contractorId,
      site: opts.site,
      phone: maskPhoneLast4(rec.phone),
      number_id: rec.number_id,
      is_primary: rec.is_primary,
      verified_at: rec.consent.verified_at,
      disclosure_version_id: rec.consent.disclosure_version_id,
    })}`);
    return rec;
  });
}
