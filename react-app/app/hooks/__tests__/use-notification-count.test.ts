import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useNotificationCount } from '../use-notification-count';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

import { supabase } from '@/lib/supabase';

describe('useNotificationCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns loading=true initially', () => {
    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            count: 0,
            error: null,
          }),
        }),
      }),
    });
    (supabase.from as any).mockImplementation(mockFrom);

    const { result } = renderHook(() => useNotificationCount('user-123'));

    expect(result.current.loading).toBe(true);
    expect(result.current.count).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('returns count after successful fetch', async () => {
    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            count: 5,
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

    const { result } = renderHook(() => useNotificationCount('user-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.count).toBe(5);
    expect(result.current.error).toBeNull();
  });

  it('handles realtime INSERT event (unread notification)', async () => {
    const mockChannel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockResolvedValue({}),
    };

    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            count: 3,
            error: null,
          }),
        }),
      }),
    });

    (supabase.from as any).mockImplementation(mockFrom);
    (supabase.channel as any).mockReturnValue(mockChannel);

    const { result } = renderHook(() => useNotificationCount('user-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Get the INSERT handler
    const insertHandler = (mockChannel.on as any).mock.calls[0][1];
    insertHandler({
      eventType: 'INSERT',
      new: { id: 'notif-1', read: false },
    });

    await waitFor(() => {
      expect(result.current.count).toBe(4);
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
          eq: vi.fn().mockResolvedValue({
            count: 0,
            error: null,
          }),
        }),
      }),
    });

    (supabase.from as any).mockImplementation(mockFrom);
    (supabase.channel as any).mockReturnValue(mockChannel);

    const { unmount } = renderHook(() => useNotificationCount('user-123'));

    unmount();

    expect(supabase.removeChannel).toHaveBeenCalled();
  });
});
