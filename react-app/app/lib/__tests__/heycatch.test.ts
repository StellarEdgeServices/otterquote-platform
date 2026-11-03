import { describe, expect, it } from "vitest";
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
