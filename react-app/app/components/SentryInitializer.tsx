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
        debug: false,
      });
    }
  }, []);

  return null;
}
