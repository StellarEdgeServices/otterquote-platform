/**
 * gh-3018 / gh-1411 / D-317 cl. 5-6: the homeowner dashboard page RENDERS the
 * "detailed measurements" badge for a Shape B (measurement_shape = 'full')
 * claim and renders nothing for any other claim (negative control).
 *
 * FAIL-FIRST: on main, page.tsx has the render commented out, so the Shape B
 * test fails there (badge text absent) and passes once the component is wired.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: { id: 'u1', email: 'jane@example.com' }, role: 'homeowner', loading: false, settled: true }),
}));
vi.mock('@/hooks/use-claim-status', () => ({ useClaimStatus: vi.fn() }));
vi.mock('../../_shell/HomeownerShell', () => ({
  HomeownerShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../use-dashboard-data', () => ({
  useLatestClaim: () => ({ claimId: 'c1', loading: false }),
  useHomeownerProfile: () => ({ profile: { full_name: 'Jane Doe' } }),
  useBlockedStates: () => ({ blockedStates: [], loading: false }),
  useClaimAux: () => ({
    bidCount: 0,
    warrantyUrl: null,
    installStartDate: null,
    hasHomeProfile: true,
    rebateOrder: null,
    refetch: vi.fn(),
  }),
}));
// Isolate the badge: stub every sibling card so only the badge's own text can match.
vi.mock('../components/StateGateCard', () => ({ StateGateCard: () => null }));
vi.mock('../components/StatusBanner', () => ({ StatusBanner: () => null }));
vi.mock('../components/RebateCard', () => ({ RebateCard: () => null }));
vi.mock('../components/Checklist', () => ({ Checklist: () => null }));
vi.mock('../components/HomeProfilePrompt', () => ({ HomeProfilePrompt: () => null }));
vi.mock('../components/MessagesPanel', () => ({ MessagesPanel: () => null }));

import { useClaimStatus } from '@/hooks/use-claim-status';
import DashboardPage from '../page';

const HEADER = 'Detailed roof measurements added';
const BODY = 'Your roof measurement report now includes detailed measurements, at no charge.';

const withClaim = (over: Record<string, unknown>) =>
  (useClaimStatus as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    claim: { id: 'c1', user_id: 'u1', status: 'active', property_state: 'IN', ready_for_bids: true, ...over },
    loading: false,
  });

describe('gh-3018 dashboard renders the Shape B badge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the approved header and body on a Shape B (full) claim', () => {
    withClaim({ measurement_shape: 'full' });
    render(<DashboardPage />);
    expect(screen.getByText(HEADER)).toBeInTheDocument();
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it('NEGATIVE CONTROL: shows nothing on a basic, null or absent shape', () => {
    for (const over of [{ measurement_shape: 'basic' }, { measurement_shape: null }, {}]) {
      withClaim(over);
      const { unmount } = render(<DashboardPage />);
      expect(screen.queryByText(HEADER)).not.toBeInTheDocument();
      expect(screen.queryByText(BODY)).not.toBeInTheDocument();
      unmount();
    }
  });
});
