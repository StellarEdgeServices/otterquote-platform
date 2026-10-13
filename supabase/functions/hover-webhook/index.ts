/**
 * OtterQuote Edge Function: hover-webhook -- DISABLED (gh-1873).
 *
 * See handler.ts for the behaviour and handler.test.ts for the tests CI runs. This file reads no secret and makes no
 * Behaviour (see handler.ts): every request, whatever its method or body, answers HTTP 410 Gone with the disabled JSON body.
 * Removal: this entry point is deleted, with its handler, after seven quiet days (gh-1873 plan, step 3); until then it stays so a stale
 * caller gets a clean answer instead of a 404. Do not add a secret read or an outbound call here.
 * outbound call. The previous implementation is in git history (index.ts at main 4f331d4).
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handle } from "./handler.ts";

serve(handle);
