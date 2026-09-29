// gh-2356 -- ONE server-side guard for every outbound analytics dispatch (Meta Conversions API, GA4 Measurement Protocol).
//
// A QA walk (our own test fbclids, qa=1, is_test / is_synthetic rows) must never reach a production conversion signal. The browser
// side of this is the oqSyntheticSignal() block in js/ga-gate.js / js/meta-pixel-gate.js / js/internal-traffic.js and
// react-app/app/lib/internal-traffic.ts; this is its Edge Function twin. The pattern list is the same list, and
// tests/gh2356-synthetic-traffic-guard.mjs fails if the copies drift.
//
// Pure, no network, never throws.

// BEGIN oq-synthetic-guard-ts (gh-2356)
export const OQ_SYNTHETIC_VALUE_PATTERNS: RegExp[] = [/^TEST(FBCLID|GCLID)/i, /^(?:(?:ceo|cto|cro|sloane|marty|ben|kevin|rwf?|autodrive)[-_]?(?:\d|walk|probe|test|stub)|k\d+[-_]?(?:walk|probe|test|stub))/i];
export const OQ_SYNTHETIC_PARAM_KEYS: string[] = ["fbclid", "gclid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
// END oq-synthetic-guard-ts

export interface SyntheticSignals {
  /** claims.is_test / quotes.is_test of the row being reported. */
  isTest?: boolean | null;
  /** leads.is_synthetic of the row being reported, where the row has one. */
  isSynthetic?: boolean | null;
  /** Attribution values carried by the row or the payment metadata (fbclid, gclid, utm_*), and `qa` / `oq_internal` flags. */
  params?: Record<string, unknown> | null;
}

export type SuppressReason = "is_test" | "is_synthetic" | "qa_flag" | "oq_internal_flag" | "synthetic_value";

/** Returns the first reason this dispatch is QA traffic, or null for a real visitor/row. Never throws. */
export function syntheticTrafficReason(signals: SyntheticSignals | null | undefined): SuppressReason | null {
  try {
    if (!signals) return null;
    if (signals.isTest === true) return "is_test";
    if (signals.isSynthetic === true) return "is_synthetic";
    const p = signals.params;
    if (p && typeof p === "object") {
      if (String(p["qa"]) === "1") return "qa_flag";
      if (String(p["oq_internal"]) === "1") return "oq_internal_flag";
      for (const key of OQ_SYNTHETIC_PARAM_KEYS) {
        const v = p[key];
        if (typeof v !== "string" || v === "") continue;
        if (OQ_SYNTHETIC_VALUE_PATTERNS.some((re) => re.test(v))) return "synthetic_value";
      }
    }
  } catch {
    /* a detection error must never block a real dispatch */
  }
  return null;
}

/**
 * Gate for one dispatch. Suppress = do not call Meta / GA4. Logs ONE info line (event name + fixed reason, no values) and the
 * caller returns normally.
 */
export function shouldSuppressAnalyticsDispatch(
  channel: "meta_capi" | "ga4_mp",
  eventName: string,
  signals: SyntheticSignals | null | undefined,
  log: (msg: string) => void = (m) => console.log(m),
): boolean {
  const reason = syntheticTrafficReason(signals);
  if (!reason) return false;
  try {
    log(`[gh-2356] ${channel} ${eventName} suppressed: synthetic traffic (${reason})`);
  } catch {
    /* logging must never throw */
  }
  return true;
}
