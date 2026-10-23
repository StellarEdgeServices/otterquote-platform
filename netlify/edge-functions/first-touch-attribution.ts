/**
 * first-touch-attribution.ts — Netlify Edge Function (gh-1983)
 *
 * On otterquote.com (static site), when a page GET lands and no first touch is
 * stored yet (gh-3002: tagged with utm params, fbclid or gclid, or not; an untagged record
 * is upgraded by a later tagged landing), add `Set-Cookie: oq_ft=…; Domain=.otterquote.com; Max-Age=90d`
 * to whatever response Netlify would have served — including the
 * `/get-started* -> https://app.otterquote.com/get-started 301` redirect, so
 * the attribution crosses to the React app before any JavaScript runs.
 *
 * Why server-side: a cookie set in an HTTP response is not subject to Safari
 * ITP's 7-day cap on script-written cookies, and it exists even when the
 * Facebook / Instagram in-app browser never finishes running page JS.
 *
 * Requests that already carry a non-upgradable oq_ft cookie, untagged
 * non-navigation requests (Accept lacks text/html), and
 * non-GET requests return undefined immediately (Netlify continues the normal
 * pipeline without buffering the response). The decision logic is shared with
 * the React app's Next middleware — react-app/app/lib/attribution-core.ts.
 */

import { firstTouchSetCookie } from "../../react-app/app/lib/attribution-core.ts";

// deno-lint-ignore no-explicit-any
export default async (req: Request, context: any) => {
  if (req.method !== "GET") return;
  let setCookie: string | null = null;
  try {
    setCookie = firstTouchSetCookie(
      req.url,
      req.headers.get("cookie"),
      req.headers.get("referer"),
      new Date(),
      req.headers.get("accept"),
    );
  } catch {
    setCookie = null;
  }
  if (!setCookie) return;

  const res: Response = await context.next();
  try {
    const out = new Response(res.body, res);
    out.headers.append("Set-Cookie", setCookie);
    return out;
  } catch {
    return res;
  }
};
