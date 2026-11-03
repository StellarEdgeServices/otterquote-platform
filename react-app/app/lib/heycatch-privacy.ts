/**
 * HeyCatch privacy helpers, app. Typed mirror of js/heycatch-privacy.js, which
 * holds the full statement of what is kept and what is dropped (gh-3352).
 * tests/gh3352-heycatch-privacy.mjs runs both files against the same cases.
 *
 * Item 1: query strings and fragments are removed from every URL-bearing event
 * property, keeping only utm_source/medium/campaign/content/term on current-page
 * URLs. Item 2: the SDK's toolbar loader (maybeLoadToolbar) fires from a
 * `__posthog=` or `state=` fragment, read when the SDK module is EVALUATED and
 * again inside init(), or from localStorage._postHogToolbarParams. 0.8.3 has no
 * option to turn it off, so both triggers are removed before `import("@heycatch/sdk")`.
 */

const KEEP_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const MAX_KEPT_VALUE = 100;
const CURRENT_URL_KEYS = ["$current_url", "$initial_current_url", "$session_entry_url", "$session_entry_current_url"];
const URL_KEY = /(url|referrer|href|action|src)$/i;
const OPAQUE_SCHEME = /^(mailto|tel|sms|javascript|data|blob):/i;
const MAX_DEPTH = 10;

function keepPair(pair: string): boolean {
  const eq = pair.indexOf("=");
  const rawKey = eq < 0 ? pair : pair.slice(0, eq);
  const rawVal = eq < 0 ? "" : pair.slice(eq + 1);
  let key: string;
  let val: string;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    val = decodeURIComponent(rawVal.replace(/\+/g, " "));
  } catch {
    return false;
  }
  if (!KEEP_KEYS.includes(key)) return false;
  return val.length > 0 && val.length <= MAX_KEPT_VALUE && !val.includes("@");
}

export function scrubUrl<T>(value: T, keepAttribution: boolean): T | string {
  if (typeof value !== "string") return value;
  const m = OPAQUE_SCHEME.exec(value);
  if (m) return m[0];
  let s: string = value;
  const h = s.indexOf("#");
  if (h !== -1) s = s.slice(0, h);
  const q = s.indexOf("?");
  if (q === -1) return s;
  const base = s.slice(0, q);
  if (!keepAttribution) return base;
  const kept = s.slice(q + 1).split("&").filter(keepPair);
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

function scrubChain(chain: string): string {
  return chain.replace(/((?:attr__)?(?:href|action|src)=")((?:[^"\\]|\\.)*)"/g, (_all, head: string, val: string) => `${head}${scrubUrl(val, false)}"`);
}

function isPlain(v: object): boolean {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function walk(v: unknown, key: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof v === "string") {
    if (key === "$elements_chain") return scrubChain(v);
    if (key && URL_KEY.test(key)) return scrubUrl(v, CURRENT_URL_KEYS.includes(key));
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1));
  if (v && typeof v === "object" && isPlain(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = walk((v as Record<string, unknown>)[k], k, depth + 1);
    return out;
  }
  return v;
}

/** A scrubbed copy of the event, or null if it cannot be scrubbed. Never throws. */
export function scrubEvent<T>(event: T): T | null {
  try {
    if (!event || typeof event !== "object") return null;
    return walk(event, "", 0) as T;
  } catch {
    return null;
  }
}

/** The SDK calls beforeSend without a try/catch, so this never throws: a failure drops the event. */
export function makeBeforeSend(gate?: () => boolean): <T>(event: T) => T | null {
  return <T,>(event: T): T | null => {
    try {
      if (gate && !gate()) return null;
      return scrubEvent(event);
    } catch {
      return null;
    }
  };
}

const STORED_KEY = "_postHogToolbarParams";
const HASH_TRIGGER = /__posthog=|state=/;

export function clearStoredToolbarParams(): void {
  try { window.localStorage.removeItem(STORED_KEY); } catch { /* storage blocked */ }
  try { window.sessionStorage.removeItem(STORED_KEY); } catch { /* storage blocked */ }
}

/**
 * Call BEFORE importing the SDK. Returns { restore } when it is safe to load the SDK, or null
 * when a trigger is in the address and could not be removed (the caller must not load the SDK).
 */
export function hideToolbarTrigger(): { restore: () => void } | null {
  clearStoredToolbarParams();
  let hash = "";
  try { hash = window.location.hash || ""; } catch { return null; }
  if (!HASH_TRIGGER.test(hash)) return { restore: clearStoredToolbarParams };
  const base = window.location.pathname + window.location.search;
  try {
    window.history.replaceState(window.history.state, "", base);
  } catch {
    return null;
  }
  if (HASH_TRIGGER.test(window.location.hash || "")) return null;
  return {
    restore: () => {
      clearStoredToolbarParams();
      try {
        // Only if nothing moved the page in the meantime.
        if (window.location.hash === "" && window.location.pathname + window.location.search === base) {
          window.history.replaceState(window.history.state, "", base + hash);
        }
      } catch { /* leave the address without the fragment */ }
    },
  };
}
