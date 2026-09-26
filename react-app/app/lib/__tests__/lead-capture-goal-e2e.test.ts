/**
 * gh-2121 (LRS HO-1 S16) -- end-to-end proof, CEO RUN 71 rank-1 handoff
 * (comment 5848588729, citing CLOSE-REVIEW: FAIL 5848566913 item 3), then
 * strengthened per REVIEW: FAIL 5849942876 (D1/D2/D4/D5).
 *
 * The refuter's ORIGINAL finding: PR #2163 and its M1/M2/M3 follow-ups (see
 * ../lead-capture.ts and ../../layout.tsx) already wire the RPC call
 * mechanics and unit-test them in lead-capture.test.ts, but nothing in the
 * repo exercises the FULL round trip a real Arm F visitor takes -- the
 * thank-you screen's `?lead=<uuid>` link (js/router-variant-f.js:652-653,
 * CTA_DESTINATIONS) landing on /help-measurements or /help-estimate, the
 * beforeInteractive capture script in app/layout.tsx (LEAD_STRIP_SCRIPT)
 * actually running on THOSE paths, and the resulting `lead_goal_events`
 * row that a real purchase or upload would produce.
 *
 * The refuter's SECOND round (5849942876) found three real defects in the
 * view/RPC this file mirrors, and one drift risk in the mirror itself:
 *   D1 (money): the ORIGINAL view counted a `hover_orders` row with no
 *      confirmed payment (a `status='pending'` row `lib/services.ts`'s
 *      `createHoverOrder()` inserts client-side, before any Edge Function
 *      call) as a completed `measurement_purchase`.
 *   D2 (proof quality): `deriveLeadGoalEvent` took an already-computed
 *      `firstHoverOrderAt` instead of `hover_orders`-shaped rows, so D1
 *      could never surface here -- the mirror hid the exact bug it should
 *      have caught.
 *   D4 (security): `set_lead_converted` checked only that the caller was
 *      signed in -- nothing tied the lead to the account claiming it, so a
 *      signed-in visitor editing `?lead=` to someone else's fresh lead id
 *      could hijack it (first-write-wins, permanent).
 *   D5 (attribution): the view joined ALL of a converted user's claims, so
 *      an existing customer's OLD paid claim (predating the Arm F lead
 *      entirely) could be credited as "the" goal for a brand-new lead.
 *
 * The fix migration, supabase/migrations/20260926221500_gh2121_s16_lead_
 * goal_security_fix.sql, requires a confirmed PaymentIntent + charge amount
 * on `hover_orders` (D1), an email match between the caller's JWT and the
 * lead (D4), and `claim_goal_at >= lead.created_at` (D5). This file's
 * mirror is rewritten to match that fixed SQL exactly, with `hover_orders`-
 * shaped fixtures (status/payment fields, not a precomputed timestamp) so
 * an unpaid order can no longer hide behind the mirror the way it did
 * before (closing D2's own hole, not just re-asserting the same shape).
 *
 * IMPORTANT (D2, per the refuter and the coordinator's follow-up): this
 * file is still a JS mirror of the SQL, not the SQL engine itself, and this
 * worker is hard-limited from executing SQL against any database (prod,
 * branch or local) to produce genuine engine output. The REAL proof --
 * PL/pgSQL assertions run inside one BEGIN...ROLLBACK batch against the
 * real `set_lead_converted`/`lead_goal_events` objects -- lives in
 * supabase/tests/gh2121_s16_lead_goal_proof.sql (P1-P7, covering the same
 * D1/D4/D5 scenarios this file covers as JS fixtures) and needs an operator
 * with DB access to run and paste the raw output; see that file's header.
 * This file remains the fast, CI-enforced regression net for the parts
 * that do not require a live database: the real capture script, the real
 * RPC-call code, and (as a fixture-level cross-check, not a replacement for
 * the SQL proof) the corrected join logic.
 *
 * Fail-first (capture path, unchanged from the first round): run against
 * commit 78f192a0 (the parent of 790b3bc7, PR #2163's M1 fix) --
 * LEAD_STRIP_SCRIPT there checks `window.location.pathname !==
 * '/get-started'` only, so both positive scenarios below fail. See the PR
 * comment for the raw run.
 *
 * Fail-first (D1, this round): the "pending/unpaid hover_orders" test below
 * asserts against `deriveLeadGoalEvent`'s CORRECTED payment predicate. Point
 * that function at the OLD predicate (delete the
 * `homeowner_stripe_payment_intent_id`/`homeowner_charge_amount` checks --
 * i.e. exactly what 20260924195639's original view did) and the same test
 * fails, because the pending order would then produce a row. See the PR
 * comment for that raw run too.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPendingLeadId, clearPendingLeadId, linkPendingLeadOnce, LEAD_STORAGE_KEY } from '../lead-capture';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extracted verbatim from app/layout.tsx's own source -- from its first
// `const LEAD_...` declaration (whichever consts that version defines --
// the pre-M1 commit has only LEAD_STRIP_SCRIPT itself, the current one also
// has LEAD_STORAGE_KEY/LEAD_CAPTURE_PATHS/LEAD_TTL_MS feeding its template
// interpolations) through the end of the `const LEAD_STRIP_SCRIPT = \`...\`;`
// statement, then evaluated for real via Function so the template literal's
// own `${...}` interpolations resolve exactly as they do at build time --
// never hand-retyped, so this test breaks (not silently drifts) the moment
// the real script changes shape.
function extractLeadStripScript(): string {
  const layoutSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'layout.tsx'), 'utf8');
  const start = layoutSrc.search(/const LEAD_\w+ = /);
  const scriptDecl = layoutSrc.match(/const LEAD_STRIP_SCRIPT = `[\s\S]*?`;/);
  if (start === -1 || !scriptDecl || scriptDecl.index === undefined) {
    throw new Error('LEAD_STRIP_SCRIPT declaration block not found in app/layout.tsx -- extraction is stale');
  }
  const end = scriptDecl.index + scriptDecl[0].length;
  const block = layoutSrc.slice(start, end);
  // eslint-disable-next-line no-new-func -- evaluating the REAL extracted declarations, not test-authored logic
  return new Function(`${block}\nreturn LEAD_STRIP_SCRIPT;`)();
}

function runStripScript(url: string) {
  window.history.pushState({}, '', url);
  // eslint-disable-next-line no-new-func -- running the REAL extracted script, not test-authored logic
  new Function(extractLeadStripScript())();
}

interface LeadFixture {
  email: string;
  createdAt: number;
  convertedUserId: string | null;
}

// Mirrors supabase/migrations/20260926221500_gh2121_s16_lead_goal_security_
// fix.sql's set_lead_converted(uuid): first-write-wins, 24h window,
// auth.uid()-scoped, AND (D4) the caller's JWT email must match the lead's
// email. A pure fixture double, never used to write anything real.
function makeSetLeadConvertedRpc(
  leads: Map<string, LeadFixture>,
  caller: { userId: string; email: string } | null,
) {
  return vi.fn((fn: string, args?: Record<string, unknown>) => {
    if (fn !== 'set_lead_converted') {
      return Promise.resolve({ data: null, error: { message: 'unknown fn' }, status: 404 });
    }
    if (!caller) {
      return Promise.resolve({ data: null, error: { message: 'authentication required' }, status: 401 });
    }
    const leadId = args?.p_lead_id as string;
    const lead = leads.get(leadId);
    if (!lead) return Promise.resolve({ data: false, error: null, status: 200 });
    const withinWindow = Date.now() - lead.createdAt < 24 * 60 * 60 * 1000;
    // D4: reject a caller whose JWT email does not match the lead's email --
    // this is what stops the "edit ?lead= to someone else's id" hijack.
    const emailMatches = lead.email === null || lead.email.toLowerCase() === caller.email.toLowerCase();
    if (lead.convertedUserId === null && withinWindow && emailMatches) {
      lead.convertedUserId = caller.userId;
      return Promise.resolve({ data: true, error: null, status: 200 });
    }
    return Promise.resolve({ data: false, error: null, status: 200 }); // already converted / expired / email mismatch
  });
}

// hover_orders-shaped fixture -- NOT a precomputed "goal happened at time X"
// value (that was D2's hole: it let an unpaid order look identical to a
// paid one to the mirror). status/paymentIntentId/chargeAmount mirror the
// real columns (supabase/migrations/20260101000000_v000_baseline_schema.sql
// :577-604) that create-hover-order's verifyHoverPayment() path -- and ONLY
// that path -- writes, and only after Stripe confirms the charge.
interface HoverOrderFixture {
  claimId: string;
  userId: string;
  createdAt: number;
  status: 'pending' | 'paid';
  paymentIntentId: string | null;
  chargeAmount: number | null;
}

interface ClaimFixture {
  claimId: string;
  userId: string;
  lossSheetParsedAt: number | null;
}

interface LeadGoalEventRow {
  leadId: string;
  claimId: string;
  goalAt: number;
  goalType: 'measurement_purchase' | 'loss_sheet_upload';
}

// Mirrors the FIXED lead_goal_events (20260926221500_gh2121_s16_lead_goal_
// security_fix.sql): claim_goals' LEAST(first_hover_order_at,
// loss_sheet_parsed_at) + goal_type CASE, where first_hover_order_at now
// comes ONLY from a hover_orders row with a confirmed PaymentIntent + a
// positive charge amount (D1) -- then DISTINCT ON (lead_id) ordered by
// claim_goal_at ASC NULLS LAST, and (D5) a claim's goal only counts if it
// happened at or after the lead's own created_at.
function deriveLeadGoalEvent(
  leads: Map<string, LeadFixture>,
  claims: ClaimFixture[],
  hoverOrders: HoverOrderFixture[],
  leadId: string,
): LeadGoalEventRow | null {
  const lead = leads.get(leadId);
  if (!lead || !lead.convertedUserId) return null;

  const firstPaidHoverOrderAtByClaim = new Map<string, number>();
  for (const ho of hoverOrders) {
    // D1: only a row with BOTH a real PaymentIntent id AND a positive
    // charge amount counts -- a pending row (createHoverOrder's client-side
    // insert, before any Edge Function call) has neither.
    if (ho.paymentIntentId === null || ho.chargeAmount === null || ho.chargeAmount <= 0) continue;
    const existing = firstPaidHoverOrderAtByClaim.get(ho.claimId);
    if (existing === undefined || ho.createdAt < existing) {
      firstPaidHoverOrderAtByClaim.set(ho.claimId, ho.createdAt);
    }
  }

  const candidates = claims
    .filter((c) => c.userId === lead.convertedUserId)
    .map((c) => {
      const firstHoverOrderAt = firstPaidHoverOrderAtByClaim.get(c.claimId) ?? null;
      const isMeasurement =
        firstHoverOrderAt !== null && (c.lossSheetParsedAt === null || firstHoverOrderAt <= c.lossSheetParsedAt);
      const goalAt = isMeasurement ? firstHoverOrderAt : c.lossSheetParsedAt;
      const goalType: LeadGoalEventRow['goalType'] | null = isMeasurement
        ? 'measurement_purchase'
        : c.lossSheetParsedAt !== null
          ? 'loss_sheet_upload'
          : null;
      return { claimId: c.claimId, goalAt, goalType };
    })
    .filter(
      (c): c is { claimId: string; goalAt: number; goalType: LeadGoalEventRow['goalType'] } =>
        c.goalAt !== null && c.goalType !== null,
    )
    // D5: a claim's goal must not predate the lead itself.
    .filter((c) => c.goalAt >= lead.createdAt)
    .sort((a, b) => a.goalAt - b.goalAt);

  if (candidates.length === 0) return null;
  const winner = candidates[0];
  return { leadId, claimId: winner.claimId, goalAt: winner.goalAt, goalType: winner.goalType };
}

describe('gh-2121 S16 end-to-end: Arm F thank-you -> lead capture -> set_lead_converted -> lead_goal_events', () => {
  const cases = [
    { label: 'help-measurements ($15 measurement purchase)', path: '/help-measurements', destGoal: 'measurement_purchase' as const },
    { label: 'help-estimate (loss-sheet upload)', path: '/help-estimate', destGoal: 'loss_sheet_upload' as const },
  ];

  for (const c of cases) {
    it(`${c.label}: a synthetic Arm F lead produces a lead_goal_events row keyed to that lead id`, async () => {
      sessionStorage.clear();
      clearPendingLeadId();

      const leadId = 'aaaaaaaa-0000-4000-8000-000000000001';
      const userId = 'user-11111111';
      const email = 'proof-a@example.test';
      const now = Date.now();

      // 1. The thank-you screen's own link shape (router-variant-f.js
      //    redirectWithLeadId): destBase + '?lead=' + leadId, plus whatever
      //    UTMs bridge.collectAttribution() would append -- a second param
      //    is included here to prove the strip script only removes `lead`.
      runStripScript(`${c.path}?lead=${leadId}&utm_source=facebook`);

      expect(window.__oqRouterLeadId).toBe(leadId);
      expect(sessionStorage.getItem(LEAD_STORAGE_KEY)).not.toBeNull();
      expect(window.location.search).not.toContain('lead=');
      expect(window.location.search).toContain('utm_source=facebook');

      // 2. The page mounts signed in (HomeownerShell already gated on a
      //    resolved user -- see help-measurements/page.tsx's useEffect) and
      //    fires the REAL linkPendingLeadOnce() against a fixture
      //    set_lead_converted, with the caller's JWT email matching the
      //    lead's own email (the legitimate case -- see D4 tests below for
      //    the hijack case).
      const leads = new Map<string, LeadFixture>([[leadId, { email, createdAt: now, convertedUserId: null }]]);
      const rpc = makeSetLeadConvertedRpc(leads, { userId, email });
      await linkPendingLeadOnce({ rpc });

      expect(rpc).toHaveBeenCalledWith('set_lead_converted', { p_lead_id: leadId });
      expect(leads.get(leadId)?.convertedUserId).toBe(userId);
      expect(readPendingLeadId()).toBeNull();

      // 3. The purchase/upload itself (unchanged money path -- this PR
      //    threads the id, it does not touch create-hover-order/
      //    parse-loss-sheet) lands a claims/hover_orders row, PAID (D1),
      //    and lead_goal_events (mirrored here against the FIXED SQL) now
      //    has exactly one row for this lead.
      const claims: ClaimFixture[] = [{ claimId: 'claim-1', userId, lossSheetParsedAt: c.destGoal === 'loss_sheet_upload' ? now + 1000 : null }];
      const hoverOrders: HoverOrderFixture[] =
        c.destGoal === 'measurement_purchase'
          ? [{ claimId: 'claim-1', userId, createdAt: now + 1000, status: 'paid', paymentIntentId: 'pi_test_1', chargeAmount: 1500 }]
          : [];

      const row = deriveLeadGoalEvent(leads, claims, hoverOrders, leadId);
      expect(row).not.toBeNull();
      expect(row?.leadId).toBe(leadId);
      expect(row?.goalType).toBe(c.destGoal);
    });
  }

  it('negative control: no ?lead= param on the thank-you link -> no capture, no RPC call, no lead_goal_events row', async () => {
    sessionStorage.clear();
    clearPendingLeadId();

    const leadId = 'aaaaaaaa-0000-4000-8000-000000000002';
    const userId = 'user-22222222';
    const email = 'proof-b@example.test';
    const now = Date.now();

    // Same destination, same attribution params, but the router never
    // appended `lead` (e.g. the insert that produces it had not resolved --
    // see router-variant-f.js's afterDetails/redirectWithLeadId ordering).
    runStripScript('/help-measurements?utm_source=facebook');

    expect(window.__oqRouterLeadId).toBeUndefined();
    expect(sessionStorage.getItem(LEAD_STORAGE_KEY)).toBeNull();

    const leads = new Map<string, LeadFixture>([[leadId, { email, createdAt: now, convertedUserId: null }]]);
    const rpc = makeSetLeadConvertedRpc(leads, { userId, email });
    await linkPendingLeadOnce({ rpc });

    expect(rpc).not.toHaveBeenCalled();
    expect(leads.get(leadId)?.convertedUserId).toBeNull();

    const claims: ClaimFixture[] = [{ claimId: 'claim-1', userId, lossSheetParsedAt: null }];
    const hoverOrders: HoverOrderFixture[] = [
      { claimId: 'claim-1', userId, createdAt: now + 1000, status: 'paid', paymentIntentId: 'pi_test_2', chargeAmount: 1500 },
    ];
    // Even though a PAID purchase landed for this user on some OTHER lead's
    // account, this lead never converted -- deriveLeadGoalEvent must return
    // null for it, matching the view's `WHERE l.converted_user_id IS NOT
    // NULL` clause.
    expect(deriveLeadGoalEvent(leads, claims, hoverOrders, leadId)).toBeNull();
  });

  it('D1 negative control: a pending/unpaid hover_orders row (reload-before-paying) produces NO lead_goal_events row', () => {
    const leadId = 'aaaaaaaa-0000-4000-8000-000000000003';
    const userId = 'user-33333333';
    const now = Date.now();

    const leads = new Map<string, LeadFixture>([[leadId, { email: 'proof-c@example.test', createdAt: now - 1000, convertedUserId: userId }]]);
    const claims: ClaimFixture[] = [{ claimId: 'claim-1', userId, lossSheetParsedAt: null }];
    // lib/services.ts createHoverOrder() inserts exactly this shape --
    // status='pending', no PaymentIntent, no charge amount -- before the
    // create-hover-order Edge Function has run at all. This is the reload-
    // before-paying scenario from REVIEW: FAIL 5849942876 D1.
    const hoverOrders: HoverOrderFixture[] = [
      { claimId: 'claim-1', userId, createdAt: now + 1000, status: 'pending', paymentIntentId: null, chargeAmount: null },
    ];

    // Fail-first for D1: comment out the `ho.paymentIntentId === null ||
    // ho.chargeAmount === null || ho.chargeAmount <= 0` guard inside
    // deriveLeadGoalEvent (i.e. restore the ORIGINAL 20260924195639
    // predicate, which had none) and this assertion fails -- the pending
    // order produces a false measurement_purchase row. See the PR comment
    // for that raw run.
    expect(deriveLeadGoalEvent(leads, claims, hoverOrders, leadId)).toBeNull();
  });

  it('D4: a caller whose JWT email does not match the lead\'s email cannot claim it (hijack via ?lead= edit)', async () => {
    sessionStorage.clear();
    clearPendingLeadId();

    const leadId = 'aaaaaaaa-0000-4000-8000-000000000004';
    const victimEmail = 'victim@example.test';
    const now = Date.now();

    runStripScript(`/help-measurements?lead=${leadId}`);
    expect(window.__oqRouterLeadId).toBe(leadId);

    const leads = new Map<string, LeadFixture>([[leadId, { email: victimEmail, createdAt: now, convertedUserId: null }]]);
    // The attacker is signed in as a DIFFERENT account, with a different
    // email, and simply edited the query string to the victim's fresh
    // lead id -- exactly the attack REVIEW: FAIL 5849942876 D4 describes.
    const rpc = makeSetLeadConvertedRpc(leads, { userId: 'attacker-uid', email: 'attacker@example.test' });
    await linkPendingLeadOnce({ rpc });

    expect(rpc).toHaveBeenCalledWith('set_lead_converted', { p_lead_id: leadId });
    expect(leads.get(leadId)?.convertedUserId).toBeNull(); // NOT hijacked
    // A non-2xx-success RPC answer (`data: false`) is still a definitive
    // 200 in this fixture (mirrors the real RPC returning boolean `false`,
    // not an error), so the capture is consumed either way -- the victim's
    // own later, legitimate link attempt is a separate call site's concern
    // (get-started/auth-callback), not this test's.
  });

  it('D5: a claim goal from BEFORE the lead was created is not attributed to that lead', () => {
    const leadId = 'aaaaaaaa-0000-4000-8000-000000000005';
    const userId = 'user-55555555';
    const now = Date.now();

    // An existing customer's account has an OLD paid claim, well before
    // this brand-new Arm F lead was even created.
    const leads = new Map<string, LeadFixture>([[leadId, { email: 'proof-e@example.test', createdAt: now, convertedUserId: userId }]]);
    const claims: ClaimFixture[] = [{ claimId: 'claim-old', userId, lossSheetParsedAt: null }];
    const hoverOrders: HoverOrderFixture[] = [
      { claimId: 'claim-old', userId, createdAt: now - 3 * 60 * 60 * 1000, status: 'paid', paymentIntentId: 'pi_old', chargeAmount: 1500 },
    ];

    expect(deriveLeadGoalEvent(leads, claims, hoverOrders, leadId)).toBeNull();
  });
});
