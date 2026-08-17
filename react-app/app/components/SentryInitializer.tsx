"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export function SentryInitializer() {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      Sentry.init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        environment: "react-app",
        tracesSampleRate: 1.0,
        // D-233: error-context-only replay — no ambient session recording; mask all inputs (PII).
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 1.0,
        integrations: [Sentry.replayIntegration({ maskAllInputs: true })],
        // gh-439: drop phantom events from data:/file:/blob: preview contexts
        // (e.g. Claude's HTML preview renders pages via data: URIs). Mirrors the
        // beforeSend in sentry.client.config.ts -- this init runs later and would
        // otherwise override that config without the filter.
        denyUrls: [/^data:/, /^file:/, /^blob:/, /data:text\/html/],
        beforeSend(event) {
          if (typeof window !== "undefined") {
            const proto = window.location.protocol;
            if (proto !== "http:" && proto !== "https:") return null;
          }
          const url = event.request?.url;
          if (url && /^(data|file|blob):/.test(url)) return null;
          return event;
        },
        debug: false,
      });
    }
  }, []);

  return null;
}
