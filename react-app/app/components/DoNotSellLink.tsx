'use client';

/**
 * gh-1925 (CEO ruling #2304 comment 5963898698, item 5): the already-ruled CPRA "Do Not Sell or Share" link on the consumer
 * React routes that load the ad tags/analytics but have no shell footer. The wording is Dustin's ruling 5881048326 string,
 * verbatim and unchanged; the href is the same absolute privacy.html section 12 anchor the shells and /get-started use
 * (privacy.html is served from otterquote.com, the React app from app.otterquote.com).
 *
 * Rendered once from the root layout, gated on an explicit allowlist (not a deny-list) so a new route never silently gains or
 * loses the link. Staff-only /admin/*, /auth-callback and every route whose shell/page already carries the link
 * (HomeownerShell, ContractorShell, /get-started) are deliberately absent, so the link never renders twice.
 * The link is a plain anchor: the opt-out itself (oq_ad_optout cookie, gpc:true, profiles write) happens on the section 12
 * button of privacy.html, so no click handler is needed here.
 */
import { usePathname } from 'next/navigation';

export const DO_NOT_SELL_TEXT = 'Do Not Sell or Share My Personal Information';
export const DO_NOT_SELL_HREF = 'https://otterquote.com/privacy.html#do-not-sell-or-share';
export const DO_NOT_SELL_ROUTES = ['/', '/login', '/refer', '/trade-selector', '/partner/dashboard'] as const;

export function shouldShowDoNotSell(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return (DO_NOT_SELL_ROUTES as readonly string[]).includes(p);
}

export function DoNotSellLink() {
  const pathname = usePathname();
  if (!shouldShowDoNotSell(pathname)) return null;
  return (
    <footer className="oq-dns-footer" style={{ fontSize: '0.75rem', padding: '16px 16px 24px', textAlign: 'center' }}>
      <a id="footer-do-not-sell-link" href={DO_NOT_SELL_HREF}>{DO_NOT_SELL_TEXT}</a>
    </footer>
  );
}
