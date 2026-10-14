/**
 * hover-webhook -- DISABLED (gh-1873, Hover retirement).
 *
 * The measurement vendor (Hover) is retired (Dustin: "Retire them now. We aren't using hover", #2382). This function no
 * longer talks to Hover: it reads NO secret (no HOVER_* name, no Deno.env.get), makes NO outbound call and NO database
 * call. Today's callers: Hover's inbound webhook, registered in Hover's console.
 *
 * It stays deployed (instead of being deleted) so a stale caller gets a clean answer instead of a 404; deletion is a
 * separate step after seven quiet days (gh-1873 plan, step 3). The previous implementation is in git history:
 * supabase/functions/hover-webhook/index.ts at main 4f331d4.
 */

export const DISABLED_BODY = {
  success: false,
  disabled: true,
  reason: "hover_disabled",
} as const;

/**
 * Every request, whatever its method or body, answers HTTP 410 Gone. A vendor that retries on a non-2xx answer therefore
 * stops once it sees 410; nothing is read, stored or forwarded.
 */
export function handle(_req: Request): Response {
  return new Response(JSON.stringify(DISABLED_BODY), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  });
}
