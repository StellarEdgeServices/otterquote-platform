/**
 * Pure helpers for the trade-selector signup completion flow (D-211 Phase 2).
 *
 * gh-1579: the free-text `cs_signup.address` field is never guaranteed to
 * arrive as "street, city, state, zip" (4 comma segments) — a typed or
 * autocompleted address can just as easily be "9000 Windpointe Pass,
 * Zionsville IN 46077" (2 segments), leaving `address_state` /
 * `address_zip` / `claims.property_state` NULL when the old comma-index
 * parser (`addressParts[2]`, `addressParts[3]`) ran out of segments.
 *
 * parseAddress() is the single parser both write sites in page.tsx route
 * through (profiles upsert + claims insert/update) so the two call sites
 * can no longer drift out of sync with each other.
 */

export interface ParsedAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

// Google Places formatted_address sometimes appends a trailing country
// segment ("…, CA 94043, USA") that is not part of state/zip/city/street.
const TRAILING_COUNTRY_RE = /,\s*(?:USA|United States(?: of America)?)\s*$/i;

// A trailing "STATE ZIP[-4]" token pair, wherever it falls in the string —
// tolerant of 0, 1, 2, or 3 commas before it. Requires WHITESPACE (not a
// comma) directly between the state and the zip, so the legacy 4-segment
// shape ("…, state, zip" — comma-separated) deliberately falls through to
// the comma-split fallback below instead of matching here.
const TRAILING_STATE_ZIP_RE = /^(.*?),?\s*\b([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/;

function cleanState(raw: string | null | undefined): string | null {
  const token = (raw || '').trim().split(/\s+/)[0] || '';
  return token ? token.toUpperCase() : null;
}

/**
 * Parse a free-text signup address into street/city/state/zip.
 *
 * 1. Strip a trailing ", USA" / ", United States" country segment, if any.
 * 2. Look for a trailing 2-letter state + 5(-4) digit zip token at the very
 *    end of the string, regardless of comma placement. When found, split
 *    everything before it into street/city on the last comma — or, if
 *    there is no comma at all, on the last whitespace-separated word.
 * 3. When no such trailing token is found (e.g. the legacy "street, city,
 *    state, zip" shape, where state and zip are themselves comma-
 *    separated), fall back unchanged to the original 4-segment comma
 *    split so addresses that already parse correctly today do not
 *    regress.
 */
export function parseAddress(raw: string | null | undefined): ParsedAddress {
  const address = (raw || '').trim();
  if (!address) {
    return { street: null, city: null, state: null, zip: null };
  }

  const withoutCountry = address.replace(TRAILING_COUNTRY_RE, '').trim();
  const match = withoutCountry.match(TRAILING_STATE_ZIP_RE);

  if (match) {
    const [, headRaw, state, zip] = match;
    const head = headRaw.trim().replace(/,\s*$/, '');
    let street: string | null = null;
    let city: string | null = null;

    if (head) {
      if (head.includes(',')) {
        const parts = head.split(',').map((s) => s.trim()).filter(Boolean);
        city = parts.pop() || null;
        street = parts.join(', ') || null;
      } else {
        const words = head.split(/\s+/).filter(Boolean);
        if (words.length > 1) {
          city = words.pop() || null;
          street = words.join(' ') || null;
        } else {
          street = head;
        }
      }
    }

    return { street: street || null, city: city || null, state: cleanState(state), zip };
  }

  // Fallback: legacy 4-segment comma split — unchanged shape/semantics for
  // addresses that already parse correctly today (gh-1579 must-not-regress).
  const parts = address.split(',').map((s) => s.trim());
  return {
    street: parts[0] || null,
    city: parts[1] || null,
    state: cleanState(parts[2]),
    zip: parts[3] || null,
  };
}
