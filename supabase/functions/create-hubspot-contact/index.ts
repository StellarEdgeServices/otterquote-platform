/**
 * OtterQuote Edge Function: create-hubspot-contact -- DISABLED (gh-2426).
 * See handler.ts. The old implementation is in index.pre-gh2426.ts.txt.
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handle } from "./handler.ts";

serve(handle);
