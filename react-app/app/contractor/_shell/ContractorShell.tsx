'use client';

/**
 * Contractor-track shell — D-211 Phase 2.
 *
 * Wraps every authenticated contractor page with the two pieces that recur
 * verbatim across the static contractor pages (build ONCE, reuse — do NOT
 * re-implement per page):
 *
 *   1. Auth + contractor-role gate. Reuses the shared AuthProvider via
 *      useAuthReady() (F-007 race-free) — does NOT re-implement auth. Gates on
 *      `loading` before reading user/role, then renders page content only for an
 *      authenticated contractor. Unauthenticated or wrong-role users are sent to
 *      /contractor/login — the normalized auth-failure target (a real React
 *      route, not a token-stripping stub or 404 dead-end).
 *
 *   2. Contractor nav chrome (64px top bar) + footer. The nav mirrors the static
 *      js/nav.js contractor link set (Home / Opportunities / Profile / Settings)
 *      and a notifications indicator (reusing useNotificationCount). Links to
 *      not-yet-migrated pages point at the static stack (coexistence by design);
 *      flip each href to its React route as that page migrates.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { useNotificationCount } from '@/hooks/use-notification-count';

export type ContractorNavId = 'home' | 'opportunities' | 'profile' | 'settings';

// Normalized auth-failure target for the contractor track (a real React route).
export const CONTRACTOR_LOGIN_ROUTE = '/contractor/login';

// Contractor nav targets. `Home` is the migrated React route; the others still
// serve from the static stack until their own phase migrates (coexistence by
// design). Single source of truth — flip an href here once when its page lands.
export const CONTRACTOR_NAV_LINKS: { id: ContractorNavId; label: string; href: string }[] = [
  { id: 'home', label: 'Home', href: '/contractor/dashboard' },
  { id: 'opportunities', label: 'Opportunities', href: '/contractor/opportunities' },
  { id: 'profile', label: 'Profile', href: '/contractor/profile' },
  { id: 'settings', label: 'Settings', href: '/contractor/settings' },
];

interface ContractorShellProps {
  /** Which nav item to highlight as the current page. */
  active: ContractorNavId;
  children: React.ReactNode;
}

export function ContractorShell({ active, children }: ContractorShellProps) {
  const { user, role, loading, signOut } = useAuthReady();
  const router = useRouter();

  // Auth + contractor-role gate. Wait for `loading` to settle (F-007) so there is
  // no flash of content or premature redirect, then bounce anyone who is not an
  // authenticated contractor to /contractor/login.
  const blocked = !user || (!!role && role !== 'contractor');

  useEffect(() => {
    if (loading) return;
    if (blocked) router.replace(CONTRACTOR_LOGIN_ROUTE);
  }, [loading, blocked, router]);

  if (loading || blocked) {
    return (
      <div className="oqc-gate" role="status" aria-live="polite" aria-label="Loading">
        <div className="oqc-spin" />
        <style>{SPIN_CSS}</style>
      </div>
    );
  }

  return (
    <>
      <style>{STYLES}</style>
      <ContractorNav active={active} userId={user.id} onSignOut={signOut} />
      <main className="oqc-main">{children}</main>
      <footer className="oqc-footer">© {new Date().getFullYear()} Otter Quotes</footer>
    </>
  );
}

function ContractorNav({
  active,
  userId,
  onSignOut,
}: {
  active: ContractorNavId;
  userId: string;
  onSignOut: () => void;
}) {
  const { count } = useNotificationCount(userId);
  const badge = count > 99 ? '99+' : String(count);

  return (
    <header className="oqc-nav">
      <a className="oqc-brand" href="/contractor/dashboard">Otter Quotes</a>

      <nav className="oqc-links" aria-label="Contractor navigation">
        {CONTRACTOR_NAV_LINKS.map((link) => (
          <a
            key={link.id}
            href={link.href}
            className={'oqc-link' + (link.id === active ? ' is-active' : '')}
            aria-current={link.id === active ? 'page' : undefined}
          >
            {link.label}
          </a>
        ))}
      </nav>

      <div className="oqc-right">
        <span className="oqc-bell" aria-label={count + ' unread notifications'}>
          <span aria-hidden="true">🔔</span>
          {count > 0 && <span className="oqc-badge">{badge}</span>}
        </span>
        <button type="button" className="oqc-signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

const SPIN_CSS = `
  .oqc-gate { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .oqc-spin { width: 28px; height: 28px; border: 3px solid rgba(224,123,0,0.2); border-top-color: var(--amber, #E07B00); border-radius: 50%; animation: oqc-spin 0.8s linear infinite; }
  @keyframes oqc-spin { to { transform: rotate(360deg); } }
`;

const STYLES = `
  .oqc-nav { height: 64px; box-sizing: border-box; display: flex; align-items: center; gap: 1.5rem; padding: 0 1.5rem; background: var(--navy, #0B1929); border-bottom: 1px solid rgba(255,255,255,0.08); position: sticky; top: 0; z-index: 50; }
  .oqc-brand { font-weight: 800; font-size: 1.05rem; color: var(--white, #fff); text-decoration: none; letter-spacing: 0.2px; white-space: nowrap; }
  .oqc-links { display: flex; align-items: center; gap: 0.25rem; flex: 1; }
  .oqc-link { color: var(--slate, #94a3b8); text-decoration: none; font-size: 0.9rem; font-weight: 600; padding: 0.5rem 0.75rem; border-radius: 6px; transition: color 0.15s, background 0.15s; }
  .oqc-link:hover { color: var(--white, #fff); background: rgba(255,255,255,0.05); }
  .oqc-link.is-active { color: var(--amber, #E07B00); }
  .oqc-right { display: flex; align-items: center; gap: 1rem; margin-left: auto; }
  .oqc-bell { position: relative; font-size: 1.1rem; line-height: 1; display: inline-flex; align-items: center; }
  .oqc-badge { position: absolute; top: -8px; right: -10px; background: var(--amber, #E07B00); color: var(--navy, #0B1929); font-size: 0.65rem; font-weight: 800; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 9px; display: flex; align-items: center; justify-content: center; }
  .oqc-signout { background: transparent; color: var(--white, #fff); border: 1.5px solid rgba(255,255,255,0.2); border-radius: 8px; padding: 7px 14px; font-size: 0.85rem; font-weight: 700; cursor: pointer; font-family: inherit; transition: border-color 0.15s, background 0.15s; }
  .oqc-signout:hover { border-color: var(--amber, #E07B00); background: rgba(224,123,0,0.08); }
  .oqc-main { min-height: calc(100vh - 64px); }
  .oqc-footer { padding: 1.5rem; text-align: center; color: var(--gray, #64748b); font-size: 0.8rem; border-top: 1px solid rgba(255,255,255,0.06); }
  @media (max-width: 768px) {
    .oqc-nav { gap: 0.75rem; padding: 0 1rem; }
    .oqc-links { gap: 0; overflow-x: auto; }
    .oqc-link { padding: 0.5rem 0.5rem; font-size: 0.85rem; }
  }
`;
