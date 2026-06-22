'use client';

/**
 * Homeowner-track shell — D-211 Phase 20 (first homeowner page).
 *
 * Build ONCE, reuse across the homeowner track (dashboard, bids, help-*). Wraps
 * every authenticated homeowner page with the two recurring pieces:
 *
 *   1. Auth + homeowner-role gate. Reuses the shared AuthProvider via
 *      useAuthReady() (F-007 race-free) — does NOT re-implement auth. Gates on
 *      `loading`/`settled` before reading user/role, then renders content only
 *      for a permitted homeowner request.
 *
 *      The gate replicates the static Auth.requireAuth('homeowner') semantics
 *      (js/auth.js:233-298) EXACTLY — not stricter, not looser:
 *        • No user                       → static get-started.html (the static
 *                                           homeowner-login fallback). This is a
 *                                           real login, NOT the /sign-in.html
 *                                           404 dead-end (audit fold-in #4).
 *        • role === 'contractor'         → contractor dashboard (the static
 *                                           wrong-role redirect target).
 *        • role === 'homeowner' | null | any other non-contractor value → RENDER.
 *          requireAuth only redirects on `role && role !== 'homeowner'`, so a
 *          null/absent role is permitted; and for any other truthy non-contractor
 *          role its redirect target is '/dashboard.html' — i.e. this very page —
 *          so the faithful, non-looping equivalent is to render here.
 *
 *      Redirects are full cross-origin navigations to the static stack
 *      (otterquote.com), so window.location.href is used rather than the App
 *      Router; there is no same-route dashboard⇄login loop to guard against.
 *
 *   2. Homeowner nav chrome (64px top bar) + footer, with a notifications
 *      indicator (reusing useNotificationCount). Links to not-yet-migrated pages
 *      point at the static stack (coexistence by design); flip each href to its
 *      React route as that page migrates.
 */

import { useEffect } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { useNotificationCount } from '@/hooks/use-notification-count';

export type HomeownerNavId = 'dashboard' | 'bids';

// Static homeowner-login fallback — matches Auth.requireAuth('homeowner') (a real
// login page, NOT the /sign-in.html 404 dead-end from dashboard.html:3129).
export const HOMEOWNER_GET_STARTED_URL = 'https://otterquote.com/get-started.html';
// Wrong-role (contractor) redirect target — matches Auth.requireAuth.
export const CONTRACTOR_DASHBOARD_URL = 'https://otterquote.com/contractor-dashboard.html';

// Homeowner nav targets. `Dashboard` is the migrated React route; the others
// still serve from the static stack until their own phase migrates (coexistence
// by design). Single source of truth — flip an href here once its page lands.
export const HOMEOWNER_NAV_LINKS: { id: HomeownerNavId; label: string; href: string }[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  { id: 'bids', label: 'My Bids', href: 'https://otterquote.com/bids.html' },
];

interface HomeownerShellProps {
  /** Which nav item to highlight as the current page. */
  active: HomeownerNavId;
  children: React.ReactNode;
}

export function HomeownerShell({ active, children }: HomeownerShellProps) {
  const { user, role, loading, settled, signOut } = useAuthReady();

  // Only redirect a confirmed contractor or an unauthenticated request. A
  // homeowner, a null/unresolved role, and any other non-contractor role are all
  // permitted (see header — replicates requireAuth('homeowner') net behaviour).
  const blocked = !user || role === 'contractor';

  useEffect(() => {
    // Bounce ONLY once auth hydration is definitively resolved (`settled`). The
    // provider's 1.5s blank-screen fallback can flip `loading` to false with a
    // still-null user during a slow cold load or an expired-token refresh; acting
    // on that transient state would eject an authenticated homeowner mid-hydration
    // (postmortem 2026-06-16). The provider refreshes an expired token itself — we
    // wait for that resolution rather than bounce.
    if (!settled || loading) return;
    if (!user) {
      window.location.href = HOMEOWNER_GET_STARTED_URL;
    } else if (role === 'contractor') {
      window.location.href = CONTRACTOR_DASHBOARD_URL;
    }
  }, [settled, loading, user, role]);

  if (!settled || loading || blocked) {
    return (
      <div className="oqh-gate" role="status" aria-live="polite" aria-label="Loading">
        <div className="oqh-spin" />
        <style>{SPIN_CSS}</style>
      </div>
    );
  }

  return (
    <>
      <style>{STYLES}</style>
      <HomeownerNav active={active} userId={user.id} onSignOut={signOut} />
      <main className="oqh-main">{children}</main>
      <footer className="oqh-footer">© {new Date().getFullYear()} Otter Quotes</footer>
    </>
  );
}

function HomeownerNav({
  active,
  userId,
  onSignOut,
}: {
  active: HomeownerNavId;
  userId: string;
  onSignOut: () => void;
}) {
  const { count } = useNotificationCount(userId);
  const badge = count > 99 ? '99+' : String(count);

  return (
    <header className="oqh-nav">
      <a className="oqh-brand" href="/dashboard">Otter Quotes</a>

      <nav className="oqh-links" aria-label="Homeowner navigation">
        {HOMEOWNER_NAV_LINKS.map((link) => (
          <a
            key={link.id}
            href={link.href}
            className={'oqh-link' + (link.id === active ? ' is-active' : '')}
            aria-current={link.id === active ? 'page' : undefined}
          >
            {link.label}
          </a>
        ))}
      </nav>

      <div className="oqh-right">
        <span className="oqh-bell" aria-label={count + ' unread notifications'}>
          <span aria-hidden="true">🔔</span>
          {count > 0 && <span className="oqh-badge">{badge}</span>}
        </span>
        <button type="button" className="oqh-signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

const SPIN_CSS = `
  .oqh-gate { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .oqh-spin { width: 28px; height: 28px; border: 3px solid rgba(224,123,0,0.2); border-top-color: var(--amber, #E07B00); border-radius: 50%; animation: oqh-spin 0.8s linear infinite; }
  @keyframes oqh-spin { to { transform: rotate(360deg); } }
`;

const STYLES = `
  .oqh-nav { height: 64px; box-sizing: border-box; display: flex; align-items: center; gap: 1.5rem; padding: 0 1.5rem; background: var(--navy, #0B1929); border-bottom: 1px solid rgba(255,255,255,0.08); position: sticky; top: 0; z-index: 50; }
  .oqh-brand { font-weight: 800; font-size: 1.05rem; color: var(--white, #fff); text-decoration: none; letter-spacing: 0.2px; white-space: nowrap; }
  .oqh-links { display: flex; align-items: center; gap: 0.25rem; flex: 1; }
  .oqh-link { color: var(--slate, #94a3b8); text-decoration: none; font-size: 0.9rem; font-weight: 600; padding: 0.5rem 0.75rem; border-radius: 6px; transition: color 0.15s, background 0.15s; }
  .oqh-link:hover { color: var(--white, #fff); background: rgba(255,255,255,0.05); }
  .oqh-link.is-active { color: var(--amber, #E07B00); }
  .oqh-right { display: flex; align-items: center; gap: 1rem; margin-left: auto; }
  .oqh-bell { position: relative; font-size: 1.1rem; line-height: 1; display: inline-flex; align-items: center; }
  .oqh-badge { position: absolute; top: -8px; right: -10px; background: var(--amber, #E07B00); color: var(--navy, #0B1929); font-size: 0.65rem; font-weight: 800; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 9px; display: flex; align-items: center; justify-content: center; }
  .oqh-signout { background: transparent; color: var(--white, #fff); border: 1.5px solid rgba(255,255,255,0.2); border-radius: 8px; padding: 7px 14px; font-size: 0.85rem; font-weight: 700; cursor: pointer; font-family: inherit; transition: border-color 0.15s, background 0.15s; }
  .oqh-signout:hover { border-color: var(--amber, #E07B00); background: rgba(224,123,0,0.08); }
  .oqh-main { min-height: calc(100vh - 64px); }
  .oqh-footer { padding: 1.5rem; text-align: center; color: var(--gray, #64748b); font-size: 0.8rem; border-top: 1px solid rgba(255,255,255,0.06); }
  @media (max-width: 768px) {
    .oqh-nav { gap: 0.75rem; padding: 0 1rem; }
    .oqh-links { gap: 0; overflow-x: auto; }
    .oqh-link { padding: 0.5rem 0.5rem; font-size: 0.85rem; }
  }
`;
