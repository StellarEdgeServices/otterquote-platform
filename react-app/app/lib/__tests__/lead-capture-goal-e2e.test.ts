/**
 * gh-2121 (LRS HO-1 S16) -- end-to-end proof, CEO RUN 71 rank-1 handoff
 * (comment 5848588729, citing CLOSE-REVIEW: FAIL 5848566913 item 3).
 *
 * The refuter's finding: PR #2163 and its M1/M2/M3 follow-ups (see
 * ../lead-capture.ts and ../../layout.tsx) already wire the RPC call
 * mechanics and unit-test them in lead-capture.test.ts, but nothing in the
 * repo exercises the FULL round trip a real Arm F visitor takes -- the
 * thank-you screen's `?lead=<uuid>` link (js/router-variant-f.js:652-653,
 * CTA_DESTINATIONS) landing on /help-measurements or /help-estimate, the
 * beforeInteractive capture script in app/layout.tsx (LEAD_STRIP_SCRIPT)
 * actually running on THOSE paths, and the resulting `lead_goal_events`
 * row (supabase/migrations/20260924195639_gh2121_lead_goal_writeback.sql)
 * that a real purchase or upload would produce. `lead_goal_events` = 0
 * rows in production and "no synthetic goal traced to an Arm F lead" is
 * exactly that gap.
 *
 * This file closes the gap with a synthetic, fixture-driven walk -- no
 * production writes, no new DB objects:
 *
 *   1. LEAD_STRIP_SCRIPT is read VERBATIM out of app/layout.tsx (never
 *      hand-retyped -- same convention as tests/gh2122-arm-f.mjs's vm
 *      extraction of start.html) and run for real, in jsdom, against a URL
 *      shaped exactly like router-variant-f.js's redirectWithLeadId()
 *      output for both Arm F thank-you destinations.
 *   2. The REAL readPendingLeadId()/linkPendingLeadOnce() from
 *      ../lead-capture (not reimplemented) are called against a fixture
 *      RPC that models set_lead_converted's actual SQL (first-write-wins,
 *      24h window, auth.uid()-scoped -- see the migration's function body)
 *      over an in-memory `leads` row.
 *   3. deriveLeadGoalEvent() below mirrors lead_goal_events's SQL join
 *      (same file, "2. Goal/activation join view" section) over in-memory
 *      `claims`/`hover_orders` fixtures -- LEAST(first_hover_order_at,
 *      loss_sheet_parsed_at), the same goal_type CASE, one row per lead --
 *      to assert the view WOULD produce a row keyed to the lead id once a
 *      real purchase/upload lands, without touching any real database.
 *
 * Fail-first: run against commit 78f192a0 (the parent of 790b3bc7, PR
 * #2163's M1 fix) -- LEAD_STRIP_SCRIPT there checks
 * `window.location.pathname !== '/get-started'` only, so scenario 1 below
 * (path /help-measurements) never captures the id and the whole chain
 * comes up empty. See the PR/issue comment for both raw runs.
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

// Mirrors supabase/migrations/20260924195639_gh2121_lead_goal_writeback.sql's
// set_lead_converted(uuid): first-write-wins, 24h window, auth.uid()-scoped.
// A pure fixture double, never used to write anything real.
function makeSetLeadConvertedRpc(
  leads: Map<string, { createdAt: number; convertedUserId: string | null }>,
  authedUserId: string | null,
) {
  return vi.fn((fn: string, args?: Record<string, unknown>) => {
    if (fn !== 'set_lead_converted') {
      return Promise.resolve({ data: null, error: { message: 'unknown fn' }, status: 404 });
    }
    if (!authedUserId) {
      return Promise.resolve({ data: null, error: { message: 'authentication required' }, status: 401 });
    }
    const leadId = args?.p_lead_id as string;
    const lead = leads.get(leadId);
    if (!lead) return Promise.resolve({ data: false, error: null, status: 200 });
    const withinWindow = Date.now() - lead.createdAt < 24 * 60 * 60 * 1000;
    if (lead.convertedUserId === null && withinWindow) {
      lead.convertedUserId = authedUserId;
      return Promise.resolve({ data: true, error: null, status: 200 });
    }
    return Promise.resolve({ data: false, error: null, status: 200 }); // already converted / expired -- first-write-wins
  });
}

interface ClaimFixture {
  claimId: string;
  userId: string;
  firstHoverOrderAt: number | null;
  lossSheetParsedAt: number | null;
}

interface LeadGoalEventRow {
  leadId: string;
  claimId: string;
  goalAt: number;
  goalType: 'measurement_purchase' | 'loss_sheet_upload';
}

// Mirrors lead_goal_events's SQL (same migration, "2. Goal/activation join
// view"): claim_goals' LEAST(first_hover_order_at, loss_sheet_parsed_at) +
// goal_type CASE, then DISTINCT ON (lead_id) ordered by claim_goal_at ASC
// NULLS LAST -- the earliest goal across the converted user's claims wins,
// and a lead with no goal yet (or not converted) produces no row.
function deriveLeadGoalEvent(
  leads: Map<string, { convertedUserId: string | null }>,
  claims: ClaimFixture[],
  leadId: string,
): LeadGoalEventRow | null {
  const lead = leads.get(leadId);
  if (!lead || !lead.convertedUserId) return null;
  const candidates = claims
    .filter((c) => c.userId === lead.convertedUserId)
    .map((c) => {
      const isMeasurement =
        c.firstHoverOrderAt !== null && (c.lossSheetParsedAt === null || c.firstHoverOrderAt <= c.lossSheetParsedAt);
      const goalAt = isMeasurement ? c.firstHoverOrderAt : c.lossSheetParsedAt;
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
      const now = Date.now();

      // 1. The thank-you screen's own link shape (router-variant-f.js
      //    redirectWithLeadId): destBase + '?lead=' + leadId, plus whatever
      //    UTMs bridge.collectAttribution() would append -- a second param
      //    is included here to prove the strip script only removes `lead`.
      runStripScript(`${c.path}?lead=${leadId}&utm_source=facebook`);

      // The capture landed (window bridge for this load, sessionStorage for
      // the HomeownerShell-bounce round trip) and the visible URL is clean.
      expect(window.__oqRouterLeadId).toBe(leadId);
      expect(sessionStorage.getItem(LEAD_STORAGE_KEY)).not.toBeNull();
      expect(window.location.search).not.toContain('lead=');
      expect(window.location.search).toContain('utm_source=facebook');

      // 2. The page mounts signed in (HomeownerShell already gated on a
      //    resolved user -- see help-measurements/page.tsx's useEffect) and
      //    fires the REAL linkPendingLeadOnce() against a fixture
      //    set_lead_converted.
      const leads = new Map([[leadId, { createdAt: now, convertedUserId: null as string | null }]]);
      const rpc = makeSetLeadConvertedRpc(leads, userId);
      await linkPendingLeadOnce({ rpc });

      expect(rpc).toHaveBeenCalledWith('set_lead_converted', { p_lead_id: leadId });
      expect(leads.get(leadId)?.convertedUserId).toBe(userId); // the write-back the CLOSE-REVIEW found never happens
      expect(readPendingLeadId()).toBeNull(); // consumed on a definitive answer

      // 3. The purchase/upload itself (unchanged money path -- this PR
      //    threads the id, it does not touch create-hover-order/
      //    parse-loss-sheet) lands a claims/hover_orders row, and
      //    lead_goal_events (mirrored here) now has exactly one row for
      //    this lead.
      const claims: ClaimFixture[] =
        c.destGoal === 'measurement_purchase'
          ? [{ claimId: 'claim-1', userId, firstHoverOrderAt: now + 1000, lossSheetParsedAt: null }]
          : [{ claimId: 'claim-1', userId, firstHoverOrderAt: null, lossSheetParsedAt: now + 1000 }];

      const row = deriveLeadGoalEvent(leads, claims, leadId);
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
    const now = Date.now();

    // Same destination, same attribution params, but the router never
    // appended `lead` (e.g. the insert that produces it had not resolved --
    // see router-variant-f.js's afterDetails/redirectWithLeadId ordering).
    runStripScript('/help-measurements?utm_source=facebook');

    expect(window.__oqRouterLeadId).toBeUndefined();
    expect(sessionStorage.getItem(LEAD_STORAGE_KEY)).toBeNull();

    const leads = new Map([[leadId, { createdAt: now, convertedUserId: null as string | null }]]);
    const rpc = makeSetLeadConvertedRpc(leads, userId);
    await linkPendingLeadOnce({ rpc });

    expect(rpc).not.toHaveBeenCalled();
    expect(leads.get(leadId)?.convertedUserId).toBeNull();

    const claims: ClaimFixture[] = [{ claimId: 'claim-1', userId, firstHoverOrderAt: now + 1000, lossSheetParsedAt: null }];
    // Even though a purchase landed for this user on some OTHER lead's
    // account, this lead never converted -- deriveLeadGoalEvent must return
    // null for it, matching the view's `WHERE l.converted_user_id IS NOT
    // NULL` clause.
    expect(deriveLeadGoalEvent(leads, claims, leadId)).toBeNull();
  });
});
