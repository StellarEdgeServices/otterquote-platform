'use client';

/**
 * gh-1925 (CEO ask on R-177 SIGNED 5964083241): unknown URLs on app.otterquote.com render this page inside the root layout,
 * which loads Google Analytics, so the ruled "Do Not Sell or Share" link must be present here too. Not-found pathnames are
 * arbitrary, so the link is rendered UNCONDITIONALLY (no route allowlist). The layout-mounted <DoNotSellLink /> renders only
 * on its five real routes, none of which can reach not-found, so the link never appears twice.
 * Wording and href are the ruled strings (5881048326), reused from DoNotSellLink unchanged.
 * Marked 'use client' so the string constants imported from the client module are real values, not client references.
 *
 * Home link (CEO non-blocking ask on R-177 SIGNED 5964192057): points at the marketing site, because the app's own "/" is
 * still the D-211 scaffold page, not a homeowner landing page.
 */
import { DO_NOT_SELL_HREF, DO_NOT_SELL_TEXT } from './components/DoNotSellLink';

const NOT_FOUND_HOME_HREF = 'https://otterquote.com/';
const NOT_FOUND_HOME_TEXT = 'Go to the homepage';

export default function NotFound() {
  return (
    <>
      <main style={{ padding: '48px 16px', textAlign: 'center' }}>
        <h1>Page not found</h1>
        <p>
          <a id="not-found-home-link" href={NOT_FOUND_HOME_HREF}>{NOT_FOUND_HOME_TEXT}</a>
        </p>
      </main>
      <footer className="oq-dns-footer" style={{ fontSize: '0.75rem', padding: '16px 16px 24px', textAlign: 'center' }}>
        <a id="footer-do-not-sell-link" href={DO_NOT_SELL_HREF}>{DO_NOT_SELL_TEXT}</a>
      </footer>
    </>
  );
}
