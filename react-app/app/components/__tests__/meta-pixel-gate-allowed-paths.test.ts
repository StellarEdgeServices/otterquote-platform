/**
 * gh-2078 / D-330 -- literal enumeration proof that the MetaPixelGate.tsx
 * path guard still excludes every authenticated (or otherwise non-marketing)
 * route in this app EXCEPT the one D-330 exception (`/help-measurements`),
 * and still excludes every unauthenticated route this app serves other than
 * `/get-started`.
 *
 * Ben (CEO RUN 60, gh-2078 comment 5780616043) required this proven, not
 * asserted: "fragment guard proven" -- the existing guard pattern that keeps
 * the Meta Pixel off authenticated/non-marketing surfaces must be
 * demonstrated still working for every OTHER surface once
 * `/help-measurements` is added.
 *
 * ROUTE_TABLE below is not hand-picked -- it is every `page.tsx` this app
 * serves, found with:
 *
 *   cd react-app/app && find . -name "page.tsx" | sort
 *
 * which returned (2026-09-22, this branch):
 *   (homeowner)/bids/page.tsx
 *   (homeowner)/color-selection/page.tsx
 *   (homeowner)/contract-signing/page.tsx
 *   (homeowner)/dashboard/page.tsx
 *   (homeowner)/help-estimate/page.tsx
 *   (homeowner)/help-materials/page.tsx
 *   (homeowner)/help-measurements/page.tsx   <- D-330 exception, ALLOWED
 *   (homeowner)/project-confirmation/page.tsx
 *   (homeowner)/repair-intake/page.tsx
 *   admin/cert-verifications/page.tsx
 *   admin/contractors/page.tsx
 *   admin/fee-config/page.tsx
 *   admin/payouts/page.tsx
 *   admin/referrals/page.tsx
 *   admin/template-review/page.tsx
 *   admin/warranty-drift/page.tsx
 *   auth-callback/page.tsx
 *   contractor/auto-bids/page.tsx
 *   contractor/bid/[claimId]/page.tsx
 *   contractor/dashboard/page.tsx
 *   contractor/login/page.tsx
 *   contractor/opportunities/page.tsx
 *   contractor/pre-approval/page.tsx
 *   contractor/profile/page.tsx
 *   contractor/settings/page.tsx
 *   contractor/sign/[claimId]/page.tsx
 *   get-started/page.tsx                     <- pre-existing ALLOWED (D-322)
 *   login/page.tsx
 *   page.tsx                                 (root "/")
 *   partner/dashboard/page.tsx
 *   refer/page.tsx
 *   trade-selector/page.tsx
 *
 * `(homeowner)` is a Next.js route GROUP -- the parens are stripped from the
 * URL -- so `(homeowner)/help-measurements/page.tsx` serves `/help-measurements`,
 * not `/(homeowner)/help-measurements`. Dynamic segments (`[claimId]`) are
 * exercised with a representative id, since isAllowedPath only ever compares
 * pathname strings (it has no notion of dynamic segments).
 *
 * If a future PR adds a new page.tsx, this list goes stale silently in one
 * direction only (a new route would pass this test by being ABSENT from
 * ROUTE_TABLE, not by wrongly evaluating true) -- the accompanying
 * `find`-vs-ROUTE_TABLE count assertion below turns that into a failing test
 * instead, so ROUTE_TABLE has to be updated deliberately rather than drift.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isAllowedPath, ALLOWED_PATHS } from '../MetaPixelGate';

const APP_DIR = path.resolve(__dirname, '../..');

/** Route group folders (parens) are stripped from the served URL by Next.js. */
function stripRouteGroups(routePath: string): string {
  return routePath
    .split('/')
    .filter(seg => !(seg.startsWith('(') && seg.endsWith(')')))
    .join('/');
}

function findAllPageRoutes(): string[] {
  const out: string[] = [];
  function walk(dir: string, urlPrefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const segUrl = entry.name.startsWith('(') && entry.name.endsWith(')')
          ? urlPrefix
          : `${urlPrefix}/${entry.name}`;
        walk(path.join(dir, entry.name), segUrl);
      } else if (entry.name === 'page.tsx') {
        out.push(urlPrefix === '' ? '/' : urlPrefix);
      }
    }
  }
  walk(APP_DIR, '');
  return out.sort();
}

/** Dynamic segments (`[claimId]`) resolved to a representative concrete id for the guard check. */
function resolveDynamicSegments(routePath: string): string {
  return routePath.replace(/\[([^\]]+)\]/g, 'sample-$1-value');
}

const REAL_ROUTES = findAllPageRoutes();

const EXPECTED_ALLOWED = new Set(['/get-started', '/help-measurements']);

describe('MetaPixelGate ALLOWED_PATHS guard (D-330 / gh-2078, R-147 literal enumeration)', () => {
  it('the guard exposes exactly the two documented allowed roots', () => {
    expect(ALLOWED_PATHS.sort()).toEqual(['/get-started', '/help-measurements']);
  });

  it('found every page.tsx this app actually serves (sanity check on the enumeration itself)', () => {
    // Pinned to the literal `find . -name "page.tsx" | sort` count from the
    // header comment above (32, run 2026-09-22 on this branch) rather than
    // re-shelling out to `find` here -- `child_process.execSync('find ...')`
    // is not portable to a Windows dev shell (no POSIX `find` under cmd.exe),
    // and CI (ubuntu-latest, .github/workflows/react-app-tests.yml) is not
    // the only place this suite runs. A route added or removed without
    // updating this number (and the header comment's list) fails here
    // instead of silently narrowing what this test actually proves -- see
    // this file's header for the intended update procedure.
    const EXPECTED_ROUTE_COUNT = 32;
    expect(REAL_ROUTES.length).toBe(EXPECTED_ROUTE_COUNT);
  });

  it('evaluates every enumerated route, printing PASS/FAIL per route', () => {
    const results = REAL_ROUTES.map(routePath => {
      const served = resolveDynamicSegments(stripRouteGroups(routePath));
      const expected = EXPECTED_ALLOWED.has(served);
      const actual = isAllowedPath(served);
      return { routePath, served, expected, actual, ok: expected === actual };
    });

    // eslint-disable-next-line no-console
    console.log(
      results
        .map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.routePath.padEnd(45)} -> served="${r.served}" allowed=${r.actual} (expected ${r.expected})`)
        .join('\n')
    );

    const failures = results.filter(r => !r.ok);
    expect(failures).toEqual([]);
  });

  it('the D-330 exception path and its sub-paths are allowed', () => {
    expect(isAllowedPath('/help-measurements')).toBe(true);
    expect(isAllowedPath('/help-measurements/anything')).toBe(true);
  });

  it('every other homeowner (authenticated) surface stays denied -- literal per-route negative check', () => {
    const otherHomeownerRoutes = [
      '/bids',
      '/color-selection',
      '/contract-signing',
      '/dashboard',
      '/help-estimate',
      '/help-materials',
      '/project-confirmation',
      '/repair-intake',
    ];
    for (const route of otherHomeownerRoutes) {
      expect(isAllowedPath(route)).toBe(false);
    }
  });

  it('every admin, contractor and partner surface stays denied', () => {
    const authRoutes = [
      '/admin/cert-verifications',
      '/admin/contractors',
      '/admin/fee-config',
      '/admin/payouts',
      '/admin/referrals',
      '/admin/template-review',
      '/admin/warranty-drift',
      '/contractor/auto-bids',
      '/contractor/bid/sample-claimId-value',
      '/contractor/dashboard',
      '/contractor/login',
      '/contractor/opportunities',
      '/contractor/pre-approval',
      '/contractor/profile',
      '/contractor/settings',
      '/contractor/sign/sample-claimId-value',
      '/partner/dashboard',
    ];
    for (const route of authRoutes) {
      expect(isAllowedPath(route)).toBe(false);
    }
  });

  it('unauthenticated non-marketing routes stay denied (root, login, refer, auth-callback, trade-selector)', () => {
    for (const route of ['/', '/login', '/refer', '/auth-callback', '/trade-selector']) {
      expect(isAllowedPath(route)).toBe(false);
    }
  });

  it('null/empty pathname is denied (fail-closed)', () => {
    expect(isAllowedPath(null)).toBe(false);
    expect(isAllowedPath('')).toBe(false);
  });
});
