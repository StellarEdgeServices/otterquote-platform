/**
 * The SHA-256 of an email address, exactly as the server-side Meta CAPI Purchase computes it.
 *
 * INLINED COPY of `hashEmailSha256` in supabase/functions/stripe-webhook/meta-capi.ts (PR #2107). Ben's ruling c. on #2078
 * (5805593465) and the REVIEW of the suppression table (5806174399): the value written to public.ad_sharing_suppressions must be
 * the SAME digest the CAPI send looks up, so the two must never drift. An Edge Function cannot import another function's module
 * (the deploy path bundles only its own directory, and does not resolve `_shared/`), so this is a copy kept in sync by TEST:
 * email-hash.test.ts compares it with the real one in meta-capi.ts on a set of addresses, and with known answers.
 *
 * trim, lower-case, UTF-8, SHA-256, lowercase hex, two characters per byte.
 */
export async function hashEmailSha256(rawEmail: string): Promise<string> {
  const normalized = rawEmail.trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
