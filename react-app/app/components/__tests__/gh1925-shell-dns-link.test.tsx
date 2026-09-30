/**
 * gh-1925 (Ben ruling 5896607701 on PR #2359): every page that loads an ad tag carries the CPRA opt-out link. The React
 * shells' copyright-only footers get the one link, reusing Dustin's ruled string (ruling 5881048326) verbatim. The React app
 * lives on app.otterquote.com while privacy.html is served from otterquote.com, so the href is absolute (same pattern as
 * HOMEOWNER_GET_STARTED_URL / app/get-started/page.tsx's privacy link).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: vi.fn(() => ({ count: 0, loading: false, error: null })),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { ContractorShell } from '../../contractor/_shell/ContractorShell';
import { HomeownerShell } from '../../(homeowner)/_shell/HomeownerShell';

const LINK_TEXT = 'Do Not Sell or Share My Personal Information';
const HREF = 'https://otterquote.com/privacy.html#do-not-sell-or-share';
const mockAuth = (role: string) =>
  (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    user: { id: 'u1' }, role, isAdmin: false, loading: false, settled: true, signOut: vi.fn(),
  });

beforeEach(() => { vi.clearAllMocks(); });

describe('gh-1925: shell footers carry the Do Not Sell or Share link', () => {
  it('HomeownerShell footer: exact string, exact absolute href, exactly once', () => {
    mockAuth('homeowner');
    const { container } = render(<HomeownerShell active="dashboard"><div>page</div></HomeownerShell>);
    const footer = container.querySelector('footer.oqh-footer');
    expect(footer).not.toBeNull();
    const links = footer!.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe(LINK_TEXT);
    expect(links[0].getAttribute('href')).toBe(HREF);
    expect(footer!.textContent).toContain('Otter Quotes');
  });

  it('ContractorShell footer: exact string, exact absolute href, exactly once', () => {
    mockAuth('contractor');
    const { container } = render(<ContractorShell active="home"><div>page</div></ContractorShell>);
    const footer = container.querySelector('footer.oqc-footer');
    expect(footer).not.toBeNull();
    const links = footer!.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe(LINK_TEXT);
    expect(links[0].getAttribute('href')).toBe(HREF);
  });
});
