/**
 * OtterQuote Edge Function: create-hubspot-contact -- DISABLED (gh-2426).
 *
 * The company's paid HubSpot plan ends 2026-10-15/16, so this function no longer talks to
 * HubSpot. Every POST answers HTTP 200 {success:false, disabled:true, reason:"hubspot_disabled"};
 * see handler.ts for the behaviour and handler.test.ts for the tests CI runs.
 *
 * It stays deployed (instead of being deleted) so a stale caller such as an old browser tab
 * gets a clean "disabled" answer and not a 404. The previous implementation (homeowner,
 * contractor and bootstrap modes) is in git history (index.ts at main 6fc2b7a).
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handle } from "./handler.ts";

serve(handle);
