/**
 * gh-1482 §2 regression guard.
 *
 * The partner-dashboard link cards now state a destination for the Recruit
 * Link ("picks their profession and applies to become an Otter Quotes
 * partner"). That claim went stale once already without anyone noticing:
 * gh-865's header comment in recruit.html described a design the code
 * beneath it no longer implemented, and nothing caught the drift until
 * Dustin clicked his own link (see gh-1482 §1). This test pins the actual
 * runtime behavior so a future change to handleRecruit()'s routing logic
 * breaks CI instead of a partner's inbox.
 */
import { test, expect } from '@playwright/test';

test('recruit.html with a resolvable code redirects to /partners.html', async ({ page }) => {
  // Stub the recruiter lookup so this test doesn't depend on a real seeded
  // row in the live Supabase project. get_referral_agents_public is a
  // SECURITY DEFINER RPC called via PostgREST; a resolvable, non-'customer'
  // agent_type is the case this test exists to pin (the 'customer' type is
  // a deliberate, separately-documented exception in recruit.html).
  await page.route('**/rest/v1/rpc/get_referral_agents_public**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agent_type: 're_agent', status: 'active' }),
    })
  );

  await page.goto('/recruit.html?code=r-TESTCODE');
  await page.waitForURL('**/partners.html**');

  const url = new URL(page.url());
  expect(url.pathname).toBe('/partners.html');
  expect(url.searchParams.get('recruit')).toBe('r-TESTCODE');
});

test('gh-1648: a case-folded recruit code is normalised before lookup and forwarding', async ({ page }) => {
  // Mail/SMS clients case-fold URLs. generate_recruit_code() emits 'r-' + 6 UPPERCASE
  // alphanumerics, so before gh-1648 'R-TESTCODE' / 'r-testcode' missed at PostgREST and the
  // referral was silently voided. Pin: the lookup and the forwarded ?recruit= both carry the
  // normalised code.
  let lookedUp: string | null = null;
  await page.route('**/rest/v1/rpc/get_referral_agents_public**', (route) => {
    lookedUp = new URL(route.request().url()).searchParams.get('recruit_code');
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agent_type: 're_agent', status: 'active' }),
    });
  });

  await page.goto('/recruit.html?code=R-testcode');
  await page.waitForURL('**/partners.html**');

  expect(lookedUp).toBe('eq.r-TESTCODE');
  const url = new URL(page.url());
  expect(url.searchParams.get('recruit')).toBe('r-TESTCODE');
});
