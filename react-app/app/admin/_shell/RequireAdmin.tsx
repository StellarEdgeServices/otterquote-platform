'use client';

import { useAuth } from '@/providers/auth-provider';
import { isSuperAdminEmail } from '@/lib/admin-allowlist';

type Tier = 'super' | 'reviewer';

interface RequireAdminProps {
  tier: Tier;
  children: React.ReactNode;
}

/**
 * Admin gate — D-211 Phase 8.
 *
 * Gates on `settled` (F-007 / postmortem 2026-06-16 pattern) so there is no
 * Unauthorized flash during auth hydration. The edge middleware (middleware.ts)
 * already redirects non-admins before render; this component handles the
 * in-React layer for two tiers:
 *
 *   super    — user email must be in the ADMIN_EMAILS allow-list.
 *   reviewer — user must pass the provider's isAdmin check
 *              (allow-list OR contractors.template_review_role==='admin').
 *
 * No redirect is issued here — the static page shows an inline Unauthorized
 * panel (matching showUnauthorized() in admin-contractors.html) and the edge
 * gate handles the redirect for true non-admins.
 */
export function RequireAdmin({ tier, children }: RequireAdminProps) {
  const { user, isAdmin, settled } = useAuth();

  if (!settled) {
    return null;
  }

  const authorized =
    tier === 'super'
      ? !!user && isSuperAdminEmail(user.email)
      : !!user && isAdmin;

  if (!authorized) {
    return (
      <div className="oqa-unauth">
        <div className="oqa-unauth-box">
          <div className="oqa-unauth-title">Unauthorized</div>
          <div className="oqa-unauth-text">
            This page is restricted to administrators only.
          </div>
        </div>
        <style>{UNAUTH_STYLES}</style>
      </div>
    );
  }

  return <>{children}</>;
}

const UNAUTH_STYLES = `
  .oqa-unauth { display: flex; align-items: center; justify-content: center; min-height: 60vh; }
  .oqa-unauth-box { background: var(--white, #fff); padding: 3rem; border-radius: 1rem; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
  .oqa-unauth-title { font-size: 1.5rem; font-weight: 700; color: var(--navy, #0B1929); margin-bottom: 0.75rem; }
  .oqa-unauth-text { color: var(--gray, #64748b); font-size: 0.95rem; }
`;
