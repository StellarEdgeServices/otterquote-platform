/**
 * gh-3730 (Ben, CEO RUN 152, Tier B): app.otterquote.com/contractor/bid/* is retired in favour of the
 * static contractor-bid-form.html on otterquote.com. The React route writes no Section 2 `declarations`
 * and no included/extra breakdown, so a bid filed there is refused once #3711 is applied and leaves the
 * signed SOW without Contingencies rows (#3709 / #3724, root cause of #3719).
 *
 * Mapping (claim id from the path segment becomes ?claim_id=, every other query param is carried over
 * unchanged, so ?renew=true, ?action=rescind, ?oq_internal=1, ?trades=, utm_* all survive):
 *   https://app.otterquote.com/contractor/bid/<id>?renew=true
 *     -> https://otterquote.com/contractor-bid-form.html?renew=true&claim_id=<id>
 *
 * The page component under app/contractor/bid/[claimId] is NOT deleted; middleware answers first.
 * The session is not touched here: sb-otterquote-at / sb-otterquote-rt are Domain=.otterquote.com
 * cookies (cookie-storage.ts, js/cookie-storage.js), so the static page sees the same session.
 */

/** Public static-site origin (matches CONFIG.SITE_URL in js/config.js; hardcoded like app/refer/utils.ts). */
export const STATIC_BID_FORM_ORIGIN = 'https://otterquote.com';
export const STATIC_BID_FORM_PATH = '/contractor-bid-form.html';
export const BID_ROUTE_PREFIX = '/contractor/bid';

/** True for /contractor/bid, /contractor/bid/ and /contractor/bid/<anything> (not /contractor/bidding). */
export function isReactBidRoute(pathname: string): boolean {
  return pathname === BID_ROUTE_PREFIX || pathname.startsWith(`${BID_ROUTE_PREFIX}/`);
}

/** Static bid-form URL for a React bid-route request URL, or null when the URL is not a bid route. */
export function staticBidFormUrl(requestUrl: string): string | null {
  const url = new URL(requestUrl);
  if (!isReactBidRoute(url.pathname)) return null;

  const segment = url.pathname.slice(BID_ROUTE_PREFIX.length + 1).split('/')[0];
  let claimId = '';
  try {
    claimId = decodeURIComponent(segment);
  } catch {
    claimId = segment;
  }

  const out = new URL(STATIC_BID_FORM_PATH, STATIC_BID_FORM_ORIGIN);
  url.searchParams.forEach((value, key) => out.searchParams.append(key, value));
  // The path segment wins over any claim_id / project in the query (same precedence as resolveClaimId).
  if (claimId) {
    out.searchParams.delete('project');
    out.searchParams.set('claim_id', claimId);
  }
  return out.toString();
}
