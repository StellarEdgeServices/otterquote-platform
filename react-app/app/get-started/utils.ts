export function formatPhoneValue(raw: string): string {
  let v = raw.replace(/\D/g, '');
  if (v.length === 11 && v.startsWith('1')) v = v.slice(1);
  if (v.length > 10) v = v.slice(0, 10);
  if (v.length === 0) return '';
  if (v.length <= 3) return `(${v}`;
  if (v.length <= 6) return `(${v.slice(0, 3)}) ${v.slice(3)}`;
  return `(${v.slice(0, 3)}) ${v.slice(3, 6)}-${v.slice(6, 10)}`;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** gh-1993: exactly 5 digits — the ZIP box's own validation, independent of
 * any state/ZIP cross-check trade-selector's parseAddress() does later. */
export function isValidZip(zip: string): boolean {
  return /^\d{5}$/.test(zip.trim());
}

/**
 * gh-1993: recombine the four split address fields into the single-line
 * string existing readers still expect (auth-callback's HubSpot sync reads
 * `cs_signup.address`; nothing here reads it back apart from that and the
 * "We'll match your home..." Step 2 subtitle). Omits any blank segment
 * rather than emitting stray ", " runs.
 */
export function fullAddress(street: string, city: string, state: string, zip: string): string {
  const line2 = [city.trim(), [state.trim(), zip.trim()].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [street.trim(), line2].filter(Boolean).join(', ');
}

/**
 * gh-2046: split `leads.name` (a single free-text column — see the router's
 * own lead insert on start.html) into the first/last name fields Step 2's
 * form actually has. Splits on the FIRST space only, so a multi-word last
 * name ("Mary Anne Smith") stays intact as one field rather than losing
 * everything past the second word — the same trade-off a plain "first
 * space" split always makes for a two-field name form, and there is no
 * schema-level first/last split on `leads` to do better than a guess here.
 * A single-word name (no space) becomes first name only, last name empty —
 * both fields stay editable either way (this is prefill, not a lock).
 */
export function splitLeadName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.slice(0, spaceIndex),
    lastName: trimmed.slice(spaceIndex + 1).trim(),
  };
}
