import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBidUpdates } from '../use-bid-updates';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

import { supabase } from '@/lib/supabase';

describe('useBidUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns loading=true initially', () => {
    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      }),
    });
    (supabase.from as any).mockImplementation(mockFrom);

    const { result } = renderHook(() => useBidUpdates('claim-123'));

    expect(result.current.loading).toBe(true);
    expect(result.current.bids).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('returns data after successful fetch', async () => {
    const mockBids = [
      {
        id: 'bid-1',
        claim_id: 'claim-123',
        contractor_id: 'cont-1',
        amount: 500,
        message: 'Can do it',
        status: 'pending' as const,
        created_at: '2026-05-06T00:00:00Z',
        updated_at: '2026-05-06T00:00:00Z',
      },
    ];

    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: mockBids,
          error: null,
        }),
      }),
    });
    (supabase.from as any).mockImplementation(mockFrom);

    const mockChannel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockResolvedValue({}),
    };
    (supabase.channel as any).mockReturnValue(mockChannel);

    const { result } = renderHook(() => useBidUpdates('claim-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.bids).toEqual(mockBids);
    expect(result.current.error).toBeNull();
  });

  it('handles realtime INSERT event', async () => {
    const initialBid = {
      id: 'bid-1',
      claim_id: 'claim-123',
      contractor_id: 'cont-1',
      amount: 500,
      message: 'Can do it',
      status: 'pending' as const,
      created_at: '2026-05-06T00:00:00Z',
      updated_at: '2026-05-06T00:00:00Z',
    };

    const mockChannel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockResolvedValue({}),
    };

    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [initialBid],
          error: null,
        }),
      }),
    });

    (supabase.from as any).mockImplementation(mockFrom);
    (supabase.channel as any).mockReturnValue(mockChannel);

    const { result } = renderHook(() => useBidUpdates('claim-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Get the INSERT handler (second .on() call)
    const insertHandler = (mockChannel.on as any).mock.calls[0][1];
    const newBid = { ...initialBid, id: 'bid-2', amount: 600 };
    insertHandler({ eventType: 'INSERT', new: newBid });

    await waitFor(() => {
      expect(result.current.bids).toHaveLength(2);
    });
  });

  it('cleans up subscription on unmount', async () => {
    const mockChannel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockResolvedValue({}),
    };

    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      }),
    });

    (supabase.from as any).mockImplementation(mockFrom);
    (supabase.channel as any).mockReturnValue(mockChannel);

    const { unmount } = renderHook(() => useBidUpdates('claim-123'));

    unmount();

    expect(supabase.removeChannel).toHaveBeenCalled();
  });
});
