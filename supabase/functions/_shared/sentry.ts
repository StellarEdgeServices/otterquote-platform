/**
 * sentry.ts — canonical server-side Sentry envelope reporter for Edge Functions (#709).
 *
 * #709 audit: `docusign-webhook/index.ts`, `create-invoice/index.ts`, and
 * `send-bid-confirmation/index.ts` each already carry their own hand-copied
 * `reportToSentry()` (introduced under 86e1tz17j to de-blind swallowed
 * audit-write failures). All three copies are byte-for-byte identical. The
 * other 53 Edge Functions in this repo have NO error reporting of any kind —
 * a failure in any of them is currently invisible outside `console.error`,
 * which Supabase does not forward anywhere durable.
 *
 * This file is the single source of truth those three copies should be kept
 * in sync with, and the copy every future EF should start from.
 *
 * ── IMPORTANT: consumers must INLINE this, not import it ──────────────────
 * The EF body-deploy path in this repo does not resolve `_shared/` imports
 * (established precedent: see `_shared/email.ts` and `_shared/getHomeownerName.ts`
 * — both document the same constraint). This file exists so every
 * `reportToSentry` implementation in the codebase can be diffed against ONE
 * source of truth and kept in sync by eye, not so it can be `import`-ed
 * directly into a deployed function. If the deploy path is ever changed to
 * bundle `_shared/`, this export can become a real import with no signature
 * change.
 *
 * ── Target project ──────────────────────────────────────────────────────
 * As of 2026-08-17 the Sentry org `otter-quote` has exactly one project
 * (`javascript`, browser-only — static HTML pages + react-app client SDK).
 * No Edge Function has ever reported into it. #709's AC calls for a
 * dedicated project for server-side/EF errors so they stop being lumped
 * into (or invisible next to) browser noise. Attempting to provision one
 * (`supabase-edge-functions`) via the Sentry MCP during this session hit
 * HTTP 403 "Your organization has disabled this feature for members" —
 * project creation is blocked at the org level for the current
 * credential/role. Once Dustin either (a) creates the project by hand in
 * the Sentry dashboard (Settings -> Projects -> New Project, platform
 * Node, team `otter-quote`, slug `supabase-edge-functions`) or (b) grants
 * project:write to the integration, set the resulting DSN as the
 * `SENTRY_DSN` secret on this Supabase project. Nothing in this file or
 * its call sites needs to change — the reporter already reads `SENTRY_DSN`
 * from the environment and no-ops safely while it is unset, exactly as it
 * does today.
 *
 * ── Rollout plan (see #709 issue comment for the per-EF table + freeze note) ──
 * 1. Dustin provisions the `supabase-edge-functions` Sentry project + DSN
 *    (blocked on the 403 above — cannot be done by this agent).
 * 2. Set `SENTRY_DSN` (and optionally `SENTRY_ENVIRONMENT`) as a Supabase
 *    secret. The 3 EFs that already inline this reporter start reporting
 *    immediately on their next invocation — no code change, no redeploy.
 * 3. Backfill this reporter into the remaining 53 EFs, wrapping their
 *    existing best-effort `catch` blocks the same way 86e1tz17j did for
 *    the first 3 (never make a previously-swallowed error newly fatal).
 *    Email-path EFs (send-bid-confirmation, send-welcome-email,
 *    send-adjuster-email, send-partner-status-email, notify-*,
 *    process-*-reminders, docusign-webhook, create-invoice) are under a
 *    deploy freeze as of 2026-08-17 — do not redeploy those until the
 *    freeze lifts, even though 3 of them already contain this code.
 * 4. Verify with a deliberately triggered error in one already-wired,
 *    non-frozen EF once (1)+(2) land, per #709 AC — configuration alone
 *    is not evidence.
 */

export interface SentryReportContext {
  fn: string;
  op?: string;
  extra?: Record<string, unknown>;
}

/**
 * Best-effort Sentry reporter for swallowed Edge Function errors.
 * No-ops to console.error until the `SENTRY_DSN` secret is set, so it is
 * safe to inline into any EF before the secret (or the project it points
 * to) exists. Never throws; callers stay non-fatal.
 */
export async function reportToSentry(
  error: unknown,
  ctx: SentryReportContext,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sentry:${ctx.fn}${ctx.op ? ":" + ctx.op : ""}]`, message, ctx.extra ?? "");
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) return; // graceful no-op until the secret is configured
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const sentAt = new Date().toISOString();
    const event = {
      event_id: eventId, timestamp: sentAt, platform: "javascript", level: "error",
      logger: `edge.${ctx.fn}`,
      environment: Deno.env.get("SENTRY_ENVIRONMENT") || "production",
      tags: { fn: ctx.fn, ...(ctx.op ? { op: ctx.op } : {}) },
      extra: ctx.extra ?? {},
      exception: { values: [{ type: error instanceof Error ? error.name : "EdgeFunctionError", value: message }] },
    };
    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: sentAt }) + "\n" +
      JSON.stringify({ type: "event" }) + "\n" + JSON.stringify(event) + "\n";
    await fetch(`${u.protocol}//${u.host}/api/${projectId}/envelope/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=otterquote-ef/1.0, sentry_key=${u.username}` },
      body: envelope,
    });
  } catch (postErr) {
    console.error("[sentry] post failed (non-fatal):", postErr);
  }
}
