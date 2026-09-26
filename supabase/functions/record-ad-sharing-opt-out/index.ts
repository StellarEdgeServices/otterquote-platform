/**
 * OtterQuote Edge Function: record-ad-sharing-opt-out
 *
 * gh-2107 / D-330 half 2. An admin records an advertising-sharing opt-out that a person requested by email to
 * support@otterquote.com (privacy policy Section 12), so the server-side Meta CAPI Purchase skips them. Dustin's ruling "b."
 * (#2078 comment 5801822166), scope item 4. All request handling lives in ./handler.ts (unit-tested); this file wires it to
 * Supabase and the Deno server.
 *
 * Usage:
 *   POST /functions/v1/record-ad-sharing-opt-out       Authorization: Bearer <admin JWT>
 *   Body:     { "email": "person@example.com" }
 *   Response: { ok: true, suppressed: true, matched, updated }   200  (matched 0 = no account has it; it is on the suppression list)
 *             { error }                                 400 / 401 / 403 / 405 / 500
 *
 * verify_jwt is pinned false in supabase/config.toml, like approve-warranty-drift: the gate is in the handler (authenticate the
 * Bearer token, then the admin check), because the project-wide ES256/HS256 gateway mismatch makes gateway verification unreliable
 * for admin callers. NO admin page calls this function yet: an admin invokes it directly with their own JWT. A page for it is a
 * follow-up (not built here).
 *
 * No `_shared/` imports: the deploy path does not resolve them, so the admin gate is inlined (PRIMARY_ADMIN_EMAIL kept in
 * sync with supabase/functions/_shared/admin.ts by eye, exactly as approve-warranty-drift does).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { hashEmailSha256 } from "./email-hash.ts";
import { escapeLikePattern, handleRequest } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// gh-1534: kept in sync with supabase/functions/_shared/admin.ts PRIMARY_ADMIN_EMAIL -- do not edit without updating that
// file too (the deploy path does not resolve imports). The single primary email plus the DB template_review_role
// fallback, the same gate approve-warranty-drift uses.
const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com";

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

Deno.serve((req: Request) =>
  handleRequest(req, {
    authenticate: async (token) => {
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data?.user) return null;
      return { id: data.user.id, email: data.user.email ?? "" };
    },
    isAdmin: async (userId, email) => {
      if (email === PRIMARY_ADMIN_EMAIL) return true;
      const { data } = await sb.from("contractors").select("template_review_role").eq("user_id", userId).maybeSingle();
      return (data as { template_review_role?: string } | null)?.template_review_role === "admin";
    },
    hashEmail: (email) => hashEmailSha256(email),
    suppress: async (emailSha256) => {
      // Idempotent: a repeat request for the same address is not an error and never rewrites the original row.
      const { error } = await sb
        .from("ad_sharing_suppressions")
        .upsert({ email_sha256: emailSha256, source: "support_email" }, { onConflict: "email_sha256", ignoreDuplicates: true });
      return error ? { errorCode: (error as { code?: string }).code ?? null } : null;
    },
    flagProfiles: async (email, atIso) => {
      const found = await sb.from("profiles").select("id").ilike("email", escapeLikePattern(email));
      if (found.error) return { errorCode: (found.error as { code?: string }).code ?? null };
      const ids = ((found.data ?? []) as { id: string }[]).map((r) => r.id);
      if (ids.length === 0) return { matched: 0, updated: 0 };
      // Sets the flag TRUE only where it is not already true (never clears it, never rewrites the original time and source).
      const upd = await sb
        .from("profiles")
        .update({ ad_sharing_opt_out: true, ad_sharing_opt_out_at: atIso, ad_sharing_opt_out_source: "support_email" })
        .in("id", ids)
        .or("ad_sharing_opt_out.is.null,ad_sharing_opt_out.eq.false")
        .select("id");
      if (upd.error) return { errorCode: (upd.error as { code?: string }).code ?? null };
      return { matched: ids.length, updated: (upd.data ?? []).length };
    },
    audit: async (adminId, entry) => {
      // One row, the acting admin by user id and the source, counts only: no address, no digest, nothing from the request.
      const { error } = await sb.from("activity_log").insert({
        event_type: "ad_sharing_opt_out_recorded",
        title: "ad_sharing_opt_out_recorded",
        user_id: adminId,
        is_test: false,
        metadata: { source: entry.source, suppressed: entry.suppressed, matched: entry.matched, updated: entry.updated },
      });
      return error ? { errorCode: (error as { code?: string }).code ?? null } : null;
    },
    now: () => new Date(),
    log: (m) => console.log(m),
  })
);
