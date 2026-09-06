/**
 * A static USPS ZIP-code first-3-digit ("ZIP3") prefix -> state/territory
 * lookup table (gh-1579 RULING (b), CTO ruling on issue #1579, comment
 * 2026-09-04T19:15:12Z).
 *
 * Source: the standard public USPS ZIP-code prefix allocation -- the same
 * first-three-digit -> state assignment widely reproduced by, e.g., the
 * Wikipedia "ZIP Code" article's prefix table and the Census Bureau's
 * ZCTA-to-state crosswalk. Compiled 2026-09-04. No network call, no vendor
 * dependency, no 5-digit-level data -- this is deliberately a compact set
 * of ranges covering all 1000 possible 3-digit prefixes, not the full
 * ~42,000-row 5-digit ZIP database.
 *
 * Why this exists: parseAddress() in ./utils.ts captures a candidate
 * 2-letter state token from free-text signup addresses, but a whitelist of
 * valid state codes alone can't tell a real state from a same-letters
 * street word ("...In 46201" -> the word "In", not Indiana) or a USPS
 * street-suffix abbreviation that also happens to be a real state code
 * ("...Ct 12345" -> "Court", not Connecticut). A US ZIP code determines
 * its state deterministically, so cross-checking the token against the
 * ZIP's actual state is a real signal instead of another guess.
 *
 * A prefix that is genuinely shared by more than one state/territory (and
 * so cannot be resolved at 3-digit granularity) maps to `null` rather than
 * guessing. Also mapped to `null`: military/diplomatic ZIP blocks (Armed
 * Forces Americas/Europe/Pacific -- "AA"/"AE"/"AP") which are not real US
 * states, and unassigned/reserved low prefixes. Every `null` range below,
 * plus the two disclosed granularity limits, are listed in the gh-1579
 * RULING (b) PR body:
 *   - 090-098 (AE - Armed Forces Europe/Canada/Middle East) -> null
 *   - 340 (AA - Armed Forces Americas) -> null
 *   - 962-966 (AP - Armed Forces Pacific) -> null
 *   - 969 (Guam AND the Northern Mariana Islands both use this prefix;
 *     genuinely ambiguous at 3-digit resolution) -> null
 *   - 000-005 (unassigned/reserved) -> null. DISCLOSED GAP: the two unique
 *     Holtsville, NY IRS ZIPs (00501, 00544) technically fall in this
 *     block; they are non-residential special-purpose codes and are not
 *     resolved by this table.
 *   - DISCLOSED GAP: American Samoa's single ZIP code (96799) falls inside
 *     the 967-968 Hawaii range and is not distinguishable from Hawaii at
 *     3-digit granularity; it resolves to 'HI' here, which is wrong for
 *     that one code. Not fixable without 5-digit data, which this table
 *     deliberately does not carry.
 */

type Zip3Range = readonly [start: number, end: number, state: string | null];

// Inclusive [start, end] ranges of 3-digit ZIP prefixes, ascending order.
// Ranges not covered below (small historical gaps between blocks) fall
// through to `null` via the lookup function's default -- never a guess.
const ZIP3_RANGES: readonly Zip3Range[] = [
  [0, 5, null], // unassigned/reserved (see Holtsville NY disclosed gap above)
  [6, 7, 'PR'], // Puerto Rico
  [8, 8, 'VI'], // US Virgin Islands
  [9, 9, 'PR'], // Puerto Rico
  [10, 27, 'MA'],
  [28, 29, 'RI'],
  [30, 38, 'NH'],
  [39, 49, 'ME'],
  [50, 59, 'VT'],
  [60, 69, 'CT'],
  [70, 89, 'NJ'],
  [90, 98, null], // Armed Forces Europe/Canada/Middle East (AE) -- not a state
  [100, 149, 'NY'],
  [150, 196, 'PA'],
  [197, 199, 'DE'],
  [200, 205, 'DC'],
  [206, 219, 'MD'],
  [220, 246, 'VA'],
  [247, 268, 'WV'],
  [270, 289, 'NC'],
  [290, 299, 'SC'],
  [300, 319, 'GA'],
  [320, 339, 'FL'],
  [340, 340, null], // Armed Forces Americas (AA) -- not a state
  [341, 349, 'FL'],
  [350, 369, 'AL'],
  [370, 385, 'TN'],
  [386, 397, 'MS'],
  [398, 399, 'GA'],
  [400, 427, 'KY'],
  [430, 459, 'OH'],
  [460, 479, 'IN'],
  [480, 499, 'MI'],
  [500, 528, 'IA'],
  [530, 549, 'WI'],
  [550, 567, 'MN'],
  [570, 577, 'SD'],
  [580, 588, 'ND'],
  [590, 599, 'MT'],
  [600, 629, 'IL'],
  [630, 658, 'MO'],
  [660, 679, 'KS'],
  [680, 693, 'NE'],
  [700, 701, 'LA'],
  [703, 711, 'LA'],
  [716, 729, 'AR'],
  [730, 731, 'OK'],
  [734, 749, 'OK'],
  [750, 799, 'TX'],
  [800, 816, 'CO'],
  [820, 831, 'WY'],
  [832, 839, 'ID'],
  [840, 847, 'UT'],
  [850, 865, 'AZ'],
  [870, 884, 'NM'],
  [885, 885, 'TX'], // El Paso, TX exclave prefix
  [889, 898, 'NV'],
  [900, 961, 'CA'],
  [962, 966, null], // Armed Forces Pacific (AP) -- not a state
  [967, 968, 'HI'], // see disclosed American Samoa gap above
  [969, 969, null], // Guam / Northern Mariana Islands -- ambiguous at 3-digit resolution
  [970, 979, 'OR'],
  [980, 994, 'WA'],
  [995, 999, 'AK'],
];

/**
 * Resolve a ZIP (5-digit, ZIP+4, or bare 3-digit prefix) to its state via
 * the static ZIP3 table above. Returns null when the prefix is malformed,
 * falls in a disclosed gap, or is genuinely multi-state -- never a guess.
 */
export function zip3ToState(zip: string | null | undefined): string | null {
  const digits = (zip || '').trim().slice(0, 3);
  if (!/^\d{3}$/.test(digits)) return null;

  const prefix = Number(digits);
  for (const [start, end, state] of ZIP3_RANGES) {
    if (prefix >= start && prefix <= end) return state;
  }
  return null;
}
