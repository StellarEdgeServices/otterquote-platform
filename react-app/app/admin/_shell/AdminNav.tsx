'use client';

import Link from 'next/link';
import { ADMIN_NAV_LINKS } from './admin-nav-links';

interface AdminNavProps {
  active: string;
}

export function AdminNav({ active }: AdminNavProps) {
  return (
    <div className="oqa-nav-bar">
      {ADMIN_NAV_LINKS.map((link) => {
        const isActive = link.key === active;
        const cls = 'oqa-nav-link' + (isActive ? ' is-active' : '');
        const ariaCurrent = isActive ? ('page' as const) : undefined;

        if (link.isReactRoute) {
          return (
            <Link key={link.key} href={link.href} className={cls} aria-current={ariaCurrent}>
              {link.label}
            </Link>
          );
        }
        return (
          <a key={link.key} href={link.href} className={cls} aria-current={ariaCurrent}>
            {link.label}
          </a>
        );
      })}
      <style>{STYLES}</style>
    </div>
  );
}

const STYLES = `
  .oqa-nav-bar { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .oqa-nav-link { color: var(--slate, #94A3B8); text-decoration: none; font-weight: 500; font-size: 0.875rem; padding: 0.5rem 1rem; border-radius: 0.5rem; }
  .oqa-nav-link.is-active { color: var(--white, #fff); font-weight: 600; background: rgba(255,255,255,0.12); }
`;
