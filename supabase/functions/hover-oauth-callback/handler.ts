/**
 * hover-oauth-callback -- DISABLED (gh-1873, Hover retirement).
 *
 * The measurement vendor (Hover) is retired (Dustin: "Retire them now. We aren't using hover", #2382). This function no
 * longer talks to Hover: it reads NO secret (no HOVER_* name, no Deno.env.get), makes NO outbound call and NO database
 * call. Today's callers: Hover's OAuth redirect (a browser landing).
 *
 * It stays deployed (instead of being deleted) so a stale caller gets a clean answer instead of a 404; deletion is a
 * separate step after seven quiet days (gh-1873 plan, step 3). The previous implementation is in git history:
 * supabase/functions/hover-oauth-callback/index.ts at main 4f331d4.
 */

export const GONE_TEXT = "This Hover connection has been retired. You can close this window.";

/** Every request, whatever its method or query string, answers HTTP 410 Gone with a plain-text message. The code/state query parameters are never read. */
export function handle(_req: Request): Response {
  return new Response(GONE_TEXT, {
    status: 410,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
