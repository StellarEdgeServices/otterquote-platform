'use client';

/**
 * Shared admin detail drawer — D-211 Phase 9 (A6).
 *
 * Presentational + fully controlled: the parent owns open/close state and the
 * body content. Renders a fixed right-side slide-out panel + a full-screen
 * backdrop. Clicking the backdrop or the × closes (both call onClose). Reused
 * by later admin phases — keep it generic (no template-review specifics).
 *
 * Ported from the .drawer / .drawer-backdrop / .drawer-header / .drawer-body
 * CSS in admin-template-review.html. Renders null when !open.
 *
 * §6.1 XSS: title + children render as JSX (React-escaped). No innerHTML.
 */

import type { ReactNode } from 'react';

export function DetailDrawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element | null {
  if (!open) {
    return null;
  }

  return (
    <>
      <div
        className="drawer-backdrop open"
        data-testid="drawer-backdrop"
        onClick={onClose}
      />
      <aside className="drawer open" role="dialog" aria-label={title}>
        <div className="drawer-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="drawer-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
      <style>{DRAWER_STYLES}</style>
    </>
  );
}

const DRAWER_STYLES = `
  .drawer-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; }
  .drawer { display: none; position: fixed; top: 0; right: 0; height: 100vh; width: min(640px, 100vw); background: var(--white,#FFFFFF); z-index: 101; box-shadow: -4px 0 24px rgba(0,0,0,0.2); overflow-y: auto; }
  .drawer.open { display: block; }
  .drawer-backdrop.open { display: block; }
  .drawer-header { padding: 1.5rem; border-bottom: 1px solid var(--light,#E2E8F0); display: flex; justify-content: space-between; align-items: center; }
  .drawer-header h2 { margin: 0; font-size: 1.25rem; color: var(--navy,#0D1B2E); }
  .drawer-close { background: none; border: none; font-size: 1.5rem; color: var(--slate,#94A3B8); cursor: pointer; line-height: 1; }
  .drawer-body { padding: 1.5rem; }
`;
