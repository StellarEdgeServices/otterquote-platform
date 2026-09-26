import * as Sentry from "@sentry/nextjs";
import { safeRedactLeadDeep } from "./app/lib/sentry-scrub";

type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

const options: SentryInitOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: "react-app",
  tracesSampleRate: 1.0,
  debug: false,
  // gh-2046 S1: the node http.server span records url.full, http.url and
  // http.target with the query string, and request data records
  // query_string -- either can carry `lead=<uuid>` for a server-rendered
  // hit on /get-started. Scrub it before the event/transaction leaves the
  // server, same as the browser-side hooks in SentryInitializer.
  beforeSend(event) {
    return safeRedactLeadDeep(event);
  },
  beforeSendTransaction(event) {
    return safeRedactLeadDeep(event);
  },
};

Sentry.init(options);
