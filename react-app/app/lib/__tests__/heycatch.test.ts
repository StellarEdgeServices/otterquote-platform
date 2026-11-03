import { describe, expect, it, vi } from "vitest";
import { isHeyCatchAllowedPath, restoreStrippedUtm, utmToKeep } from "../heycatch";

describe("HeyCatch page gate", () => {
  it("allows only the public sign-up route", () => {
    expect(isHeyCatchAllowedPath("/get-started")).toBe(true);
    for (const p of ["/", "/dashboard", "/bids", "/login", "/auth-callback", "/trade-selector", "/contract-signing", "/admin/contractors", "/get-startedx", null]) {
      expect(isHeyCatchAllowedPath(p)).toBe(false);
    }
  });
});

describe("HeyCatch UTM restore", () => {
  it("keeps ad UTMs but not the SDK's own short-link params", () => {
    expect(utmToKeep("?utm_source=meta&utm_medium=paid&utm_campaign=hail&gclid=1")).toEqual({ utm_source: "meta", utm_medium: "paid", utm_campaign: "hail" });
    expect(utmToKeep("?utm_source=heycatch&utm_campaign=a")).toEqual({});
    expect(utmToKeep("?utm_source=meta")).toEqual({});
  });

  it("puts stripped params back without touching others", () => {
    window.history.replaceState(null, "", "/get-started?gclid=1");
    restoreStrippedUtm({ utm_source: "meta", utm_campaign: "hail" });
    const p = new URLSearchParams(window.location.search);
    expect(p.get("gclid")).toBe("1");
    expect(p.get("utm_source")).toBe("meta");
    expect(p.get("utm_campaign")).toBe("hail");
  });
});

// gh-3352: loadHeyCatch against a stand-in SDK whose module factory records the address at the moment
// the SDK is EVALUATED (the real one reads location.hash then) and the config passed to init().
describe("HeyCatch loader (gh-3352)", () => {
  it("evaluates the SDK with no toolbar trigger in the address or storage, scrubs in beforeSend, then restores the fragment", async () => {
    vi.resetModules();
    const seen: { hashAtImport?: string; storedAtImport?: string | null; config?: Record<string, unknown>; hashAtInit?: string } = {};
    vi.doMock("@heycatch/sdk", () => {
      seen.hashAtImport = window.location.hash;
      seen.storedAtImport = window.localStorage.getItem("_postHogToolbarParams");
      return { analytics: { init: (c: Record<string, unknown>) => { seen.config = c; seen.hashAtInit = window.location.hash; } } };
    });
    const trigger = btoa(JSON.stringify({ action: "ph_authorize", token: "phc_public" }));
    window.localStorage.setItem("_postHogToolbarParams", JSON.stringify({ token: "phc_public" }));
    window.history.replaceState(null, "", `/get-started?utm_source=meta&utm_campaign=hail#__posthog=${trigger}`);
    const { loadHeyCatch } = await import("../heycatch");
    await loadHeyCatch();
    expect(seen.hashAtImport).toBe("");
    expect(seen.storedAtImport).toBeNull();
    expect(seen.hashAtInit).toBe("");
    expect(window.location.hash).toBe(`#__posthog=${trigger}`);
    const beforeSend = seen.config!.beforeSend as (e: unknown) => { properties: Record<string, string> } | null;
    const out = beforeSend({ event: "$pageview", properties: { $referrer: "https://app.otterquote.com/bids?claim_id=CLAIMREF999", $current_url: "https://app.otterquote.com/get-started?utm_source=meta&claim_id=C" } });
    expect(out!.properties.$referrer).toBe("https://app.otterquote.com/bids");
    expect(out!.properties.$current_url).toBe("https://app.otterquote.com/get-started?utm_source=meta");
    window.history.replaceState(null, "", "/dashboard");
    expect(beforeSend({ event: "$pageview", properties: {} })).toBeNull();
    vi.doUnmock("@heycatch/sdk");
  });
});
