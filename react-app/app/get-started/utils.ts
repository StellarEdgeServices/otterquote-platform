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
