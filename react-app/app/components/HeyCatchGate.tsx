"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { isInternalTraffic } from "../lib/internal-traffic";
import { isAdSharingOptedOut, readStoredOptOut, type ProfileReader } from "../lib/ad-optout";
import { isHeyCatchAllowedPath, loadHeyCatch } from "../lib/heycatch";

/**
 * HeyCatch trial (CEO RUN 144): the ONLY place the SDK loads in this app.
 *
 * Deliberate deviation from https://heycatch.ai/agents.md, which asks for an
 * unconditional static init on every route. Same posture as GA4Gate and
 * MetaPixelGate: production host only, never for internal traffic, never for an
 * opted-out visitor, never with a Supabase token in the fragment, and only on
 * the public /get-started route. Signed-in pages never load it.
 */
const ALLOWED_HOSTS = ["app.otterquote.com"];

export function HeyCatchGate() {
  const pathname = usePathname();

  useEffect(() => {
    if (isInternalTraffic()) return;
    if (!ALLOWED_HOSTS.includes(window.location.hostname)) return;
    if (!isHeyCatchAllowedPath(pathname)) return;
    if (isAdSharingOptedOut()) return;
    const hash = window.location.hash;
    if (/access_token|refresh_token|provider_token/.test(hash)) return;

    let cancelled = false;
    // Loaded lazily, as GA4Gate does, so the auth client is not pulled in before this check runs.
    void import("../lib/supabase")
      .then((m) => readStoredOptOut(m.supabase as unknown as ProfileReader))
      .catch(() => "unknown" as const)
      .then((stored) => {
        // No session: nothing stored to read. A session: only a definite "not opted out" loads it.
        if (!cancelled && (stored === "no_session" || stored === false) && !isAdSharingOptedOut()) void loadHeyCatch();
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return null;
}
