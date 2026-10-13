/**
 * OtterQuote Edge Function: hover-oauth-callback -- DISABLED (gh-1873).
 *
 * See handler.ts for the behaviour and handler.test.ts for the tests CI runs. This file reads no secret and makes no
 * outbound call. The previous implementation is in git history (index.ts at main 4f331d4).
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handle } from "./handler.ts";

serve(handle);
