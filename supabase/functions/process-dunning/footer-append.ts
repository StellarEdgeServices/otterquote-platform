// footer-append.ts (gh-1824 footer batch 6)
//
// Appends the D-237 postal-address footer (email-footer.ts) to an
// already-built outgoing email body at this function's single Mailgun send
// funnel. Split out of index.ts so it can be unit-tested without importing
// index.ts (which calls serve() at module load time).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

/** Inserts the postal-address block just before the last </body>; appends if there is none. */
export function appendPostalFooterHtml(html: string): string {
  const footer = footerPostalAddressHtml();
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i === -1 ? html + footer : html.slice(0, i) + footer + html.slice(i);
}

/** Appends the postal address as a final plain-text paragraph. */
export function appendPostalFooterText(text: string): string {
  return `${text}\n\n${footerPostalAddressText()}`;
}
