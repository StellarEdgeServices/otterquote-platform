import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredToolbarParams, hideToolbarTrigger, makeBeforeSend, scrubEvent, scrubReferrer, scrubUrl } from "../heycatch-privacy";

// gh-3352 items 1 and 2. The event below has the shape the real SDK 0.8.3 produced in headless Chromium
// for /get-started opened from a signed-in page, with the values the review planted.
const SIGNED_IN = "https://app.otterquote.com/bids?claim_id=CLAIMREF999&email=pat%40example.com#sec";
const CLAIM_IN_PATH = "https://app.otterquote.com/contractor/bid/CLAIMPATH777?x=1#y";

function realisticEvent() {
  return {
    uuid: "u1",
    event: "$autocapture",
    timestamp: new Date("2026-11-03T18:00:00Z"),
    properties: {
      $current_url: "https://app.otterquote.com/get-started?utm_source=meta&utm_medium=paid&utm_campaign=hail&claim_id=CLAIMQ777&email=a%40b.com&gclid=<masked>#frag=1",
      $pathname: "/get-started",
      $host: "app.otterquote.com",
      $referrer: SIGNED_IN,
      $referring_domain: "app.otterquote.com",
      $session_entry_referrer: SIGNED_IN,
      $session_entry_url: "https://app.otterquote.com/get-started?utm_source=meta&utm_campaign=hail&code=ABC123",
      $session_entry_pathname: "/get-started",
      $elements: [{ tag_name: "a", attr__href: "/contract-signing?claim_id=CLAIMQ777&bid=9#x", nth_child: 1 }],
      $elements_chain: 'a:attr__href="/contract-signing?claim_id=CLAIMQ777&bid=9#x"attr__id="go"href="/contract-signing?claim_id=CLAIMQ777&bid=9#x"nth-child="1"',
      $external_click_url: "https://example.com/p?email=a%40b.com",
      $set: { $current_url: "https://app.otterquote.com/get-started?email=a%40b.com" },
    },
    $set_once: {
      $initial_referrer: SIGNED_IN,
      $initial_current_url: "https://app.otterquote.com/get-started?utm_source=meta&claim_id=CLAIMQ777",
      $referrer: SIGNED_IN,
      $initial_pathname: "/get-started",
    },
    $set: { $internal_or_test_user: false },
  };
}

describe("HeyCatch scrubUrl", () => {
  it("drops the fragment and every query key except UTMs on a current-page URL", () => {
    expect(scrubUrl("https://a.test/p?claim_id=1&utm_source=meta&email=x%40y.com&utm_medium=paid#f", true)).toBe("https://a.test/p?utm_source=meta&utm_medium=paid");
    expect(scrubUrl("https://a.test/p?claim_id=1#f", true)).toBe("https://a.test/p");
    expect(scrubUrl("/p?utm_content=c1&utm_term=t1", true)).toBe("/p?utm_content=c1&utm_term=t1");
  });
  it("drops a UTM value that is long or looks like an address", () => {
    expect(scrubUrl("https://a.test/p?utm_term=a%40b.com&utm_source=meta", true)).toBe("https://a.test/p?utm_source=meta");
    expect(scrubUrl(`https://a.test/p?utm_term=${"x".repeat(101)}`, true)).toBe("https://a.test/p");
    expect(scrubUrl("https://a.test/p?utm_source=%E0%A4%A", true)).toBe("https://a.test/p");
  });
  it("keeps nothing from a link target but its path, and cuts opaque schemes to the scheme", () => {
    expect(scrubUrl("https://a.test/bids.html?claim_id=1&utm_source=x#f", false)).toBe("https://a.test/bids.html");
    expect(scrubUrl("mailto:pat@example.com?subject=hi", false)).toBe("mailto:");
    expect(scrubUrl("tel:+13175550100", false)).toBe("tel:");
    expect(scrubUrl("$direct", false)).toBe("$direct");
    expect(scrubUrl(undefined, false)).toBeUndefined();
  });
});

describe("HeyCatch scrubReferrer", () => {
  it("sends the origin only, never a path, query or fragment", () => {
    expect(scrubReferrer(SIGNED_IN)).toBe("https://app.otterquote.com");
    expect(scrubReferrer(CLAIM_IN_PATH)).toBe("https://app.otterquote.com");
    expect(scrubReferrer("https://www.google.com/search?q=roof+claim#x")).toBe("https://www.google.com");
    expect(scrubReferrer("http://127.0.0.1:3000/a/b")).toBe("http://127.0.0.1:3000");
  });
  it("keeps $direct, drops anything that is not an http(s) URL", () => {
    expect(scrubReferrer("$direct")).toBe("$direct");
    expect(scrubReferrer("not a url")).toBeUndefined();
    expect(scrubReferrer("/contractor/bid/CLAIMPATH777")).toBeUndefined();
    expect(scrubReferrer("android-app://com.google.android.gm/")).toBeUndefined();
    expect(scrubReferrer("")).toBeUndefined();
  });
});

describe("HeyCatch scrubEvent", () => {
  it("removes claim ids and emails from every URL-bearing property, including $set, $set_once and autocapture elements", () => {
    const out = scrubEvent(realisticEvent())!;
    const text = JSON.stringify(out);
    for (const bad of ["CLAIMREF999", "CLAIMQ777", "claim_id", "pat%40", "a%40b.com", "code=ABC123", "frag=1", "bid=9", "gclid"]) expect(text).not.toContain(bad);
    expect(out.properties.$referrer).toBe("https://app.otterquote.com");
    expect(out.properties.$session_entry_referrer).toBe("https://app.otterquote.com");
    expect(out.$set_once.$initial_referrer).toBe("https://app.otterquote.com");
    expect(out.$set_once.$referrer).toBe("https://app.otterquote.com");
    expect(out.properties.$external_click_url).toBe("https://example.com/p");
    expect(out.properties.$elements[0].attr__href).toBe("/contract-signing");
    expect(out.properties.$elements_chain).toContain('attr__href="/contract-signing"');
    expect(out.properties.$elements_chain).toContain('href="/contract-signing"nth-child');
  });

  it("keeps UTM attribution on current-page URLs and leaves paths, hosts and other properties alone", () => {
    const e = realisticEvent();
    const out = scrubEvent(e)!;
    expect(out.properties.$current_url).toBe("https://app.otterquote.com/get-started?utm_source=meta&utm_medium=paid&utm_campaign=hail");
    expect(out.properties.$session_entry_url).toBe("https://app.otterquote.com/get-started?utm_source=meta&utm_campaign=hail");
    expect(out.$set_once.$initial_current_url).toBe("https://app.otterquote.com/get-started?utm_source=meta");
    expect(out.properties.$set.$current_url).toBe("https://app.otterquote.com/get-started");
    expect(out.properties.$pathname).toBe("/get-started");
    expect(out.properties.$host).toBe("app.otterquote.com");
    expect(out.properties.$referring_domain).toBe("app.otterquote.com");
    expect(out.$set).toEqual({ $internal_or_test_user: false });
    expect(out.timestamp).toBeInstanceOf(Date);
    expect(out.uuid).toBe("u1");
  });

  it("does not modify the event it was given", () => {
    const e = realisticEvent();
    const before = JSON.stringify(e);
    scrubEvent(e);
    expect(JSON.stringify(e)).toBe(before);
  });

  it("never sends the path of a signed-in referrer, including a claim id in the path", () => {
    const e = { event: "$pageview", properties: { $referrer: CLAIM_IN_PATH, $session_entry_referrer: CLAIM_IN_PATH, $referring_domain: "app.otterquote.com" }, $set_once: { $initial_referrer: CLAIM_IN_PATH } };
    const text = JSON.stringify(scrubEvent(e));
    expect(text).not.toContain("CLAIMPATH777");
    expect(text).not.toContain("/contractor");
    expect(text).not.toContain("/bids");
    const out = scrubEvent({ event: "x", properties: { $referrer: "$direct", $initial_referrer: "garbage", $referring_domain: "$direct" } })!;
    expect(out.properties.$referrer).toBe("$direct");
    expect("$initial_referrer" in out.properties).toBe(false);
    expect(out.properties.$referring_domain).toBe("$direct");
  });

  it("treats an unknown property whose name ends in url, referrer or href as a URL", () => {
    const out = scrubEvent({ event: "x", properties: { $future_landing_url: "https://a.test/p?claim_id=1", $x_referrer: "https://a.test/q/r?e=1#h" } })!;
    expect(out.properties.$future_landing_url).toBe("https://a.test/p");
    expect(out.properties.$x_referrer).toBe("https://a.test");
  });

  it("returns null instead of throwing", () => {
    const hostile = { event: "x", properties: {} as Record<string, unknown> };
    Object.defineProperty(hostile.properties, "$current_url", { enumerable: true, get() { throw new Error("boom"); } });
    expect(scrubEvent(hostile)).toBeNull();
    const circular: Record<string, unknown> = { event: "x" };
    circular.self = circular;
    expect(() => scrubEvent(circular)).not.toThrow();
    expect(scrubEvent(null)).toBeNull();
  });
});

describe("HeyCatch makeBeforeSend", () => {
  it("drops the event when the gate says no, scrubs it when yes, and never throws", () => {
    expect(makeBeforeSend(() => false)(realisticEvent())).toBeNull();
    const sent = makeBeforeSend(() => true)(realisticEvent())!;
    expect(JSON.stringify(sent)).not.toContain("claim_id");
    expect(makeBeforeSend(() => { throw new Error("gate broke"); })(realisticEvent())).toBeNull();
    expect(makeBeforeSend()(undefined)).toBeNull();
  });
});

const PARAMS = "_postHogToolbarParams";
const TRIGGER = btoa(JSON.stringify({ action: "ph_authorize", token: "phc_public" }));

describe("HeyCatch toolbar trigger removal", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/faq");
  });
  afterEach(() => vi.restoreAllMocks());

  it("deletes stored toolbar params left by an earlier visit", () => {
    window.localStorage.setItem(PARAMS, JSON.stringify({ token: "phc_public" }));
    window.sessionStorage.setItem(PARAMS, "x");
    expect(hideToolbarTrigger()).not.toBeNull();
    expect(window.localStorage.getItem(PARAMS)).toBeNull();
    expect(window.sessionStorage.getItem(PARAMS)).toBeNull();
  });

  it.each(["__posthog", "state"])("takes a #%s= fragment off the address until the SDK is initialised, then puts it back", (key) => {
    window.history.replaceState(null, "", `/faq?utm_source=meta#${key}=${encodeURIComponent(TRIGGER)}`);
    const guard = hideToolbarTrigger()!;
    expect(guard).not.toBeNull();
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?utm_source=meta");
    guard.restore();
    expect(window.location.hash).toBe(`#${key}=${encodeURIComponent(TRIGGER)}`);
  });

  it("matches the SDK's own substring test, so a lookalike key is hidden too", () => {
    window.history.replaceState(null, "", "/faq#x=1&mystate=abc");
    const guard = hideToolbarTrigger()!;
    expect(window.location.hash).toBe("");
    guard.restore();
    expect(window.location.hash).toBe("#x=1&mystate=abc");
  });

  it("leaves an ordinary fragment alone", () => {
    window.history.replaceState(null, "", "/faq#pricing");
    const spy = vi.spyOn(window.history, "replaceState");
    hideToolbarTrigger()!.restore();
    expect(spy).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#pricing");
  });

  it("does not restore the fragment over a page that has since moved", () => {
    window.history.replaceState(null, "", `/faq#__posthog=${TRIGGER}`);
    const guard = hideToolbarTrigger()!;
    window.history.replaceState(null, "", "/other");
    guard.restore();
    expect(window.location.pathname + window.location.hash).toBe("/other");
  });

  it("reports failure, so the SDK is not loaded, when the fragment cannot be removed", () => {
    window.history.replaceState(null, "", `/faq#__posthog=${TRIGGER}`);
    vi.spyOn(window.history, "replaceState").mockImplementation(() => { throw new Error("blocked"); });
    expect(hideToolbarTrigger()).toBeNull();
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => clearStoredToolbarParams()).not.toThrow();
    expect(hideToolbarTrigger()).not.toBeNull();
  });
});
