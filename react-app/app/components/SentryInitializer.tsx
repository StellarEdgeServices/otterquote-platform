"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { redactLeadDeep } from "../lib/sentry-scrub";

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
        // (e.g. Claude's HTML preview renders pages via data: URIs).
        denyUrls: [/^data:/, /^file:/, /^blob:/, /data:text\/html/],
        beforeSend(event) {
          if (typeof window !== "undefined") {
            const proto = window.location.protocol;
            if (proto !== "http:" && proto !== "https:") return null;
          }
          const url = event.request?.url;
          if (url && /^(data|file|blob):/.test(url)) return null;
          // gh-2046: redact `lead=<uuid>` from every string in the event —
          // request.url, tags, extra, and any browser-timing span that
          // slipped through outside beforeSendTransaction (e.g. an error
          // event carries its own request/breadcrumb data).
          return redactLeadDeep(event);
        },
        // gh-2046: the pageload transaction's browser.* spans
        // (domContentLoadedEvent, loadEvent, connect, TLS/SSL, cache, DNS,
        // request, response) copy their description/data from the
        // Navigation Timing / Resource Timing entries, which still hold
        // the *original* request URL — history.replaceState in the
        // early-strip head script cannot touch them. Redact `lead=` out
        // of every span's description and data (url, http.url, etc.),
        // and out of the transaction's own request.url, before the
        // envelope leaves the browser. Spans are kept, not dropped.
        beforeSendTransaction(event) {
          return redactLeadDeep(event);
        },
        // Defense in depth: a breadcrumb (e.g. an XHR/fetch breadcrumb
        // recording its request URL) must not carry the lead id either,
        // including on events beforeSend/beforeSendTransaction never see
        // (breadcrumbs are attached to whatever event follows them).
        beforeBreadcrumb(breadcrumb) {
          return redactLeadDeep(breadcrumb);
        },
        debug: false,
      });
    }
  }, []);

  return null;
}
