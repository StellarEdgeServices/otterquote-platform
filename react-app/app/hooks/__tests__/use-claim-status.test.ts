import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useClaimStatus } from '../use-claim-status';

// Mock Supabase
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

import { supabase } from '@/lib/supabase';

describe('useClaimStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns loading=true initially', () => {
    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: null,
          }),
        }),
      }),
    });
    (supabase.from as any).mockImplementation(mockFrom);

    const { result } = renderHook(() => useClaimStatus('claim-123'));

    expect(result.current.loading).toBe(true);
    expect(result.current.claim).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('returns data after successful fetch', async () => {
    const mockData = {
      id: 'claim-123',
      user_id: 'user-456',
      title: 'Test Claim',
      description: 'Test description',
      status: 'open' as const,
      created_at: '2026-05-06T00:00:00Z',
      updated_at: '2026-05-06T00:00:00Z',
      budget: 1000,
    };

    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: mockData,
            error: null,
          }),
        }),
      }),
    });
    (supabase.from as any).mockImplementation(mockFrom);

    const mockChannel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockResolvedValue({}),
    };
    (supabase.channel as any).mockReturnValue(mockChannel);

    const { result } = renderHook(() => useClaimStatus('claim-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.claim).toEqual(mockData);
    expect(result.current.error).toBeNull();
  });

  it('handles realtime INSERT/UPDATE event', async () => {
    const mockData = {
      id: 'claim-123',
      user_id: 'user-456',
      title: 'Test Claim',
      description: 'Test description',
      status: 'open' as const,
      created_at: '2026-05-06T00:00:00Z',
      updated_at: '2026-05-06T00:00:00Z',
      budget: 1000,
    };

    let subscribeCallback: any;

    const mockChannel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(function (callback) {
        subscribeCallback = callback;
        return this;
      }),
    };

    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: mockData,
            error: null,
          }),
        }),
      }),
    });

    (supabase.from as any).mockImplementation(mockFrom);
    (supabase.channel as any).mockReturnValue(mockChannel);

    const { result } = renderHook(() => useClaimStatus('claim-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Simulate realtime update
    const updatedData = { ...mockData, title: 'Updated Claim' };
    const payloadHandler = (mockChannel.on as any).mock.calls[0][1];
    payloadHandler({
      eventType: 'UPDATE',
      new: updatedData,
    });

    await waitFor(() => {
      expect(result.current.claim?.title).toBe('Updated Claim');
    });
  });

  it('cleans up subscription on unmount', async () => {
    const mockChannel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockResolvedValue({}),
    };

    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'claim-123' },
            error: null,
          }),
        }),
      }),
    });

    (supabase.from as any).mockImplementation(mockFrom);
    (supabase.channel as any).mockReturnValue(mockChannel);

    const { unmount } = renderHook(() => useClaimStatus('claim-123'));

    unmount();

    expect(supabase.removeChannel).toHaveBeenCalled();
  });
});
