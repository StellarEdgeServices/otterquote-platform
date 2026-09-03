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
//
// NOTE: this regex alone accepts *any* two-letter alphabetic token as
// "state" — including street-suffix abbreviations like "Rd"/"Ct"/"Ln"/"Dr"/
// "Pl" on a comma-less address. A match here is only trusted once the
// captured token is checked against VALID_STATE_CODES below (gh-1579
// follow-up: a wrong-but-real state code is worse than the NULL this PR
// set out to fix, since it silently passes downstream state-gate checks).
const TRAILING_STATE_ZIP_RE = /^(.*?),?\s*\b([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/;

// The 50 states + DC, plus the US territories this product plausibly serves
// (Puerto Rico — hurricane/storm-damage roofing demand is real there).
// Deliberately excludes non-plausible territories (Guam, American Samoa,
// the Northern Mariana Islands, US Virgin Islands) and military/diplomatic
// "state" codes (AA/AE/AP) — none of those are realistic contractor-signup
// markets for this product today. Revisit if the product expands there.
const VALID_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR',
]);

// gh-1579 round 3: the round-2 fix hand-picked "CT" as the one ambiguous
// code and asserted (wrongly — see review comment on PR #1583) that no
// other 2-letter USPS street-suffix abbreviation collides with a state in
// VALID_STATE_CODES. A second one ("Wy"/Way vs. Wyoming) was found by
// inspection immediately after. Hand-picking is a treadmill: every future
// reviewer who thinks of one more suffix finds one more collision. Instead,
// derive the ambiguous set structurally as an intersection.
//
// DERIVATION: USPS Publication 28, Appendix C1 ("Street Suffix
// Abbreviations"). Take every two-character abbreviation that can appear in
// a written address for a primary suffix name — which means BOTH the
// "Postal Service Standard Suffix Abbreviation" column AND the "Commonly
// Used Street Suffix or Abbreviation" column (name → abbreviation):
// Branch→BR, Camp→CP, Court→CT, Cove→CV, Dale→DL, Dam→DM, Divide→DV,
// Drive→DR, Fort→FT, Hill→HL, Island→IS, Key→KY, Loaf→LF, Lake→LK,
// Lane→LN, Mill→ML, Mount→MT, Place→PL, Prairie→PR, Point→PT, Road→RD,
// Square→SQ, Street→ST, Union→UN, Ville→VL, View→VW, Way→WY.
//
// ⚠ READ BEFORE RE-DERIVING. `WY` comes from the COMMONLY-USED column, not
// the Standard column — Way's Standard abbreviation is the three-letter
// `WAY`. Re-deriving from the Standard column ALONE drops `WY` and silently
// reintroduces the exact bug this set exists to prevent: '100 Sunset Wy
// 90210' parsing as Wyoming with a truncated street (gh-1579 review round
// 2). Both columns, always. The Standard column also contributes `WL`
// (Well→WL), which is harmless here only because WL is not a state code —
// do not treat its absence as evidence the Standard column is sufficient.
//
// (Every other primary suffix — Avenue, Boulevard, Circle, etc. —
// abbreviates to three or more letters in both columns and can't collide
// with a 2-letter state code at all, so it's excluded from the candidate
// set before the intersection even runs.)
//
// USPS_TWO_LETTER_SUFFIX_ABBREVIATIONS is that candidate set. Intersecting
// it against VALID_STATE_CODES below is the actual ambiguity set — not
// asserted, computed — so re-deriving it is just re-running this
// intersection against Pub 28's table, not re-guessing suffixes by eye.
const USPS_TWO_LETTER_SUFFIX_ABBREVIATIONS = new Set([
  'BR', 'CP', 'CT', 'CV', 'DL', 'DM', 'DV', 'DR', 'FT', 'HL',
  'IS', 'KY', 'LF', 'LK', 'LN', 'ML', 'MT', 'PL', 'PR', 'PT',
  'RD', 'SQ', 'ST', 'UN', 'VL', 'VW', 'WY',
]);

// The computed intersection: 2-letter USPS suffix abbreviations that are
// ALSO real state/territory codes in VALID_STATE_CODES. For every code in
// this set, the whitelist alone can't tell "…Riverside Ct 12345" (a
// street) from "…Hartford CT 06103" (a city, Connecticut) by the token
// alone — so we use the *shape* of the address as the tiebreaker: a comma
// in the head (a "street, city" split already happened) is a strong signal
// the trailing token really is the state, whereas a fully comma-less head
// is exactly the shape that produces the false suffix-as-state misfire.
// On that ambiguous, comma-less shape we deliberately fall through to the
// legacy fallback (null state) rather than guess — consistent with this
// fix's overall principle that a NULL is safer than a confidently wrong
// state. As of this derivation the intersection is: CT (Court/
// Connecticut), KY (Key/Kentucky), MT (Mount/Montana), PR (Prairie/Puerto
// Rico), WY (Way/Wyoming).
const AMBIGUOUS_STATE_SUFFIX_CODES = new Set(
  [...USPS_TWO_LETTER_SUFFIX_ABBREVIATIONS].filter((code) => VALID_STATE_CODES.has(code))
);

function cleanState(raw: string | null | undefined): string | null {
  const token = (raw || '').trim().split(/\s+/)[0] || '';
  return token ? token.toUpperCase() : null;
}

function isValidStateCode(token: string): boolean {
  return VALID_STATE_CODES.has(token.toUpperCase());
}

function isTrustworthyStateMatch(token: string, head: string): boolean {
  if (!isValidStateCode(token)) return false;
  if (AMBIGUOUS_STATE_SUFFIX_CODES.has(token.toUpperCase())) {
    // Only trust a code in the derived intersection (currently CT/KY/MT/
    // PR/WY) as a state when a comma already separated a city segment from
    // it; a comma-less head is the ambiguous street-suffix shape.
    return head.trim().includes(',');
  }
  return true;
}

/**
 * Parse a free-text signup address into street/city/state/zip.
 *
 * 1. Strip a trailing ", USA" / ", United States" country segment, if any.
 * 2. Look for a trailing 2-letter state + 5(-4) digit zip token at the very
 *    end of the string, regardless of comma placement, AND require that
 *    the captured 2-letter token is a real US state/DC/territory code
 *    (VALID_STATE_CODES) — not just any two letters. When both hold, split
 *    everything before the token into street/city on the last comma — or,
 *    if there is no comma at all, on the last whitespace-separated word.
 * 3. When no such trailing token is found, OR the token is found but is
 *    not a real state code, OR it is one of the codes that are both a real
 *    state and a 2-letter USPS street-suffix abbreviation (CT/KY/MT/PR/WY —
 *    see AMBIGUOUS_STATE_SUFFIX_CODES, derived by intersecting the USPS
 *    Pub-28 2-letter suffix table against VALID_STATE_CODES) appearing on a
 *    fully comma-less address, fall back unchanged to the original
 *    4-segment comma split — identical treatment to a regex miss, so this
 *    never invents a third behavior.
 *    This also covers the legacy "street, city, state, zip" shape, where
 *    state and zip are themselves comma-separated and so never match the
 *    trailing-token regex to begin with.
 */
export function parseAddress(raw: string | null | undefined): ParsedAddress {
  const address = (raw || '').trim();
  if (!address) {
    return { street: null, city: null, state: null, zip: null };
  }

  const withoutCountry = address.replace(TRAILING_COUNTRY_RE, '').trim();
  const match = withoutCountry.match(TRAILING_STATE_ZIP_RE);
  const head = match ? match[1].trim().replace(/,\s*$/, '') : '';

  if (match && isTrustworthyStateMatch(match[2], head)) {
    const [, , state, zip] = match;
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
