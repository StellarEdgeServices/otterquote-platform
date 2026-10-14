// notify.ts (gh-2564, CEO RUN 104 point 5) -- sends the homeowner the one "contractor withdrew" notice.
// Dependency-free of Deno.serve so a test can import it and pass a mock `send` (the test never touches Mailgun).
//
// Same send path as process-bid-expirations (Mailgun form POST from notifications@<MAILGUN_DOMAIN>, homeowner
// address read from profiles.email via claims.user_id). Inlined per function directory because the EF body-deploy
// path does not resolve imports across directories (see ../_shared/email.ts header).

import { buildBidWithdrawnHomeownerEmail } from "./templates.ts";

export type SendFn = (
  to: string,
  from: string,
  subject: string,
  text: string,
  html: string,
) => Promise<boolean>;

// Minimal structural view of the supabase client: .from(t).select(c).eq(k, v).maybeSingle().
// deno-lint-ignore no-explicit-any
export interface LookupClient { from(table: string): any }

export function mailgunSender(apiKey: string, domain: string, fetchImpl: typeof fetch = fetch): SendFn {
  return async (to, from, subject, text, html) => {
    const form = new URLSearchParams();
    form.append("from", from);
    form.append("to", to);
    form.append("subject", subject);
    form.append("text", text);
    form.append("html", html);
    const resp = await fetchImpl(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
      body: form,
    });
    if (!resp.ok) {
      console.error(`[rescind-bid] Mailgun error (${resp.status}):`, await resp.text());
      return false;
    }
    return true;
  };
}

export async function notifyHomeownerOfWithdrawal(
  db: LookupClient,
  send: SendFn,
  ctx: { claimId: string | null; contractorId: string; mailgunDomain: string; otherLiveBids: boolean },
): Promise<{ sent: boolean; reason?: string }> {
  if (!ctx.claimId) return { sent: false, reason: "no_claim" };

  const { data: claim } = await db.from("claims").select("user_id").eq("id", ctx.claimId).maybeSingle();
  if (!claim?.user_id) return { sent: false, reason: "no_homeowner" };

  const { data: profile } = await db.from("profiles").select("full_name, email").eq("id", claim.user_id).maybeSingle();
  if (!profile?.email) return { sent: false, reason: "no_homeowner_email" };

  const { data: contractor } = await db.from("contractors").select("company_name").eq("id", ctx.contractorId).maybeSingle();

  const email = buildBidWithdrawnHomeownerEmail({
    homeownerName: profile.full_name || "there",
    contractorName: contractor?.company_name || "A contractor",
    bidsUrl: `https://otterquote.com/bids.html?claim=${ctx.claimId}`,
    mailgunDomain: ctx.mailgunDomain,
    hasOtherLiveBids: ctx.otherLiveBids,
  });

  const ok = await send(
    profile.email,
    `Otter Quotes <notifications@${ctx.mailgunDomain}>`,
    email.subject,
    email.text,
    email.html,
  );
  return ok ? { sent: true } : { sent: false, reason: "send_failed" };
}
