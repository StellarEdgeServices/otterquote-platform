export interface AdminNavLink {
  key: string;
  label: string;
  href: string;
  /** True = render via next/link (React route); false = plain <a href> (static stack). */
  isReactRoute: boolean;
}

/** Canonical admin nav link list — single source of truth. Flip isReactRoute here when a page migrates. */
export const ADMIN_NAV_LINKS: AdminNavLink[] = [
  { key: 'contractors', label: 'Contractors', href: '/admin/contractors', isReactRoute: true },
  { key: 'referrals', label: 'Referrals', href: 'https://otterquote.com/admin-referrals.html', isReactRoute: false },
  { key: 'payouts', label: 'Payouts', href: 'https://otterquote.com/admin-payouts.html', isReactRoute: false },
  { key: 'template-review', label: 'Template Review', href: '/admin/template-review', isReactRoute: true },
  { key: 'cert-verifications', label: 'Cert Verifications', href: '/admin/cert-verifications', isReactRoute: true },
];
