/**
 * OtterQuote Edge Function: fetch-roof-image (gh-1413 / D-317 cl. 6)
 * Geocodes the caller's claim address (US Census geocoder) and stores a fixed-size USGS NAIP crop at
 * claim-roof-images/{claim_id}/roof.jpg (service role write). No paid vendor, no API key, no new secret.
 * Imagery credit: "Imagery: USDA/USGS NAIP".
 * FEATURE FLAG: ROOF_IMAGE_ENABLED must equal "true"; unset means the function does nothing (OFF by default).
 * Caller: the claim's own homeowner (JWT). Idempotent: an existing object is not re-fetched.
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { handle } from "./handler.ts";

const BUCKET = "claim-roof-images";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return handle(req, {
    enabled: Deno.env.get("ROOF_IMAGE_ENABLED") === "true",
    fetchFn: fetch,
    getUserId: async (t) => (await sb.auth.getUser(t)).data.user?.id ?? null,
    getClaim: async (id) =>
      (await sb.from("claims").select("id, user_id, property_address, property_city, property_state, property_zip").eq("id", id).maybeSingle()).data ?? null,
    exists: async (p) => {
      const slash = p.lastIndexOf("/");
      const { data } = await sb.storage.from(BUCKET).list(p.slice(0, slash), { search: p.slice(slash + 1) });
      return (data ?? []).some((o) => o.name === p.slice(slash + 1));
    },
    upload: async (p, bytes) => {
      const { error } = await sb.storage.from(BUCKET).upload(p, bytes, { contentType: "image/jpeg", upsert: false });
      if (error) throw new Error(error.message);
    },
  });
});
