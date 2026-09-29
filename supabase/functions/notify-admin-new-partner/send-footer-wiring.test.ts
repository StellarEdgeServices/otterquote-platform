// Deno unit test for gh-1824 footer-batch-6 (notify-admin-new-partner): the handler's
// real Mailgun send must carry the D-237 postal address in BOTH the text and html parts.
// templates.test.ts pins the rendered bodies; this test pins the WIRING at the send site
// (REVIEW: FAIL 5881354201 on PR #2331 showed the suite still passed with the wrap
// removed). Removing appendPostalFooterText/Html from index.ts fails this test.
// Run: deno test --no-check -A supabase/functions/notify-admin-new-partner/send-footer-wiring.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { handleNotifyAdminNewPartner, type PartnerDeps, type PartnerRow } from "./index.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";
import { appendPostalFooterHtml, appendPostalFooterText } from "./footer-append.ts";
import { buildEmailHtml, partnerSignupText } from "./templates.ts";

const SERVICE_ROLE_KEY = "fake-service-role-key";

const PARTNER: PartnerRow = {
  id: "a1111111-2222-3333-4444-555555555555",
  user_id: null,
  agent_type: "real_estate_agent",
  first_name: "Jamie",
  last_name: "Agent",
  email: "jamie@example.com",
  company: "Acme Realty & Co",
  funnel_id: "fb-fall-1",
  fbclid: "present-but-never-rendered",
  is_test: false,
  created_at: "2026-09-28T15:15:00Z",
};

// Minimal structural fake of the two reads and one insert the handler makes.
const supabase: PartnerDeps["supabase"] = {
  from(_table: string) {
    const chain = {
      select(_cols: string) {
        return chain;
      },
      eq(_col: string, _val: unknown) {
        return chain;
      },
      limit(_n: number) {
        return Promise.resolve({ data: [], error: null });
      },
      single() {
        return Promise.resolve({ data: PARTNER, error: null });
      },
      insert(_row: Record<string, unknown>) {
        return Promise.resolve({ error: null });
      },
    };
    return chain;
  },
};

Deno.test("gh-1824 notify-admin-new-partner: the handler's Mailgun send carries the D-237 footer in text AND html, wrapping the pinned bodies", async () => {
  let sent: FormData | null = null;
  const fetchImpl = ((_input: string | Request | URL, init?: RequestInit) => {
    sent = init?.body as FormData;
    return Promise.resolve(new Response(JSON.stringify({ id: "<m1@mail.otterquote.test>" }), { status: 200 }));
  }) as typeof fetch;
  const deps: PartnerDeps = {
    serviceRoleKey: SERVICE_ROLE_KEY,
    mailgunKey: "fake-mailgun-key",
    mailgunDomain: "mail.otterquote.test",
    supabase,
    fetchImpl,
  };
  const req = new Request("https://x.supabase.co/functions/v1/notify-admin-new-partner", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ partner_id: PARTNER.id }),
  });

  const res = await handleNotifyAdminNewPartner(req, deps);
  assertEquals(res.status, 200);

  const form = sent as FormData | null;
  if (!form) throw new Error("handler never called Mailgun");
  const args = [false, "Jamie Agent", "real_estate_agent", "jamie@example.com", "Acme Realty & Co", "fb-fall-1", true, "9/28/2026, 10:15:00 AM"] as const;
  const text = String(form.get("text"));
  const html = String(form.get("html"));
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
  assertEquals(text, appendPostalFooterText(partnerSignupText(...args)));
  assertEquals(html, appendPostalFooterHtml(buildEmailHtml(...args)));
});
