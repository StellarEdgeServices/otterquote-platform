/**
 * OtterQuote Edge Function: fetch-roof-image (gh-1413 / D-317 cl. 6)
 * Geocodes the caller's claim address (US Census geocoder) and stores a fixed-size USGS NAIP crop at
 * claim-roof-images/{claim_id}/roof-{address hash}.jpg (service role write; a changed address gives a new name, so the image regenerates). No paid vendor, no API key, no new secret.
 * Imagery credit: "Imagery: USDA/USGS NAIP".
 * FEATURE FLAG: ROOF_IMAGE_ENABLED must equal "true"; unset means the function does nothing (OFF by default).
 * Caller: the claim's own homeowner (user JWT, from bids.html), verified in-handler (auth.getUser + claims.user_id). Contractors have no access (D-371).
 * verify_jwt = true (supabase/config.toml), like the sibling homeowner-called get-contractor-info. Idempotent: an existing image for the same address is not re-fetched.
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
    list: async (claimId) => {
      const { data, error } = await sb.storage.from(BUCKET).list(claimId);
      if (error) throw new Error(error.message);
      return (data ?? []).map((o) => o.name);
    },
    upload: async (p, bytes) => {
      const { error } = await sb.storage.from(BUCKET).upload(p, bytes, { contentType: "image/jpeg", upsert: false });
      if (error) throw new Error(error.message);
    },
    remove: async (paths) => { await sb.storage.from(BUCKET).remove(paths); },
  });
});
