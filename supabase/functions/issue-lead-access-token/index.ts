/**
 * OtterQuote Edge Function: issue-lead-access-token
 *
 * gh-2121 (HO-3, #2121 row 3.2). Wiring only -- see ./handler.ts for all
 * request handling (no imports there, unit-tested directly).
 *
 * verify_jwt is pinned to false in supabase/config.toml (pre-auth caller,
 * same reasoning as record-lead-details).
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { handleRequest } from "./handler.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
);

serve((req: Request) =>
  handleRequest(req, {
    rpc: (name, args) => sb.rpc(name, args) as unknown as Promise<{ data: unknown; error: unknown }>,
  })
);
