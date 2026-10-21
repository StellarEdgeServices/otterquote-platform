'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface UseNotificationCountResult {
  count: number;
  loading: boolean;
  error: Error | null;
  markRead?: (notificationId: string) => Promise<void>;
}

/**
 * useNotificationCount: Subscribe to real-time unread notification count for the current user.
 *
 * Returns the unread count and loading/error state.
 * Provides markRead callback for optimistic updates.
 * Automatically cleans up subscription on unmount.
 */
export function useNotificationCount(userId: string | null): UseNotificationCountResult {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    let isMounted = true;
    let subscription: any = null;

    const subscribe = async () => {
      try {
        // Initial count
        const { count: unreadCount, error: countError } = await supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .is('read_at', null);

        if (!isMounted) return;

        if (countError) {
          setError(countError);
          setLoading(false);
          return;
        }

        setCount(unreadCount || 0);
        setError(null);
        setLoading(false);

        // Subscribe to real-time updates
        const channel = supabase
          .channel(`notifications-${userId}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'notifications',
              filter: `user_id=eq.${userId}`,
            },
            (payload) => {
              if (isMounted && !(payload.new as any).read_at) {
                setCount((prev) => prev + 1);
              }
            }
          )
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'notifications',
              filter: `user_id=eq.${userId}`,
            },
            (payload) => {
              if (isMounted) {
                const wasRead = !!(payload.old as any).read_at;
                const isRead = !!(payload.new as any).read_at;
                // If transition from unread to read, decrement
                if (!wasRead && isRead) {
                  setCount((prev) => Math.max(0, prev - 1));
                }
                // If transition from read to unread, increment
                if (wasRead && !isRead) {
                  setCount((prev) => prev + 1);
                }
              }
            }
          )
          .on(
            'postgres_changes',
            {
              event: 'DELETE',
              schema: 'public',
              table: 'notifications',
              filter: `user_id=eq.${userId}`,
            },
            (payload) => {
              if (isMounted && !(payload.old as any).read_at) {
                setCount((prev) => Math.max(0, prev - 1));
              }
            }
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              if (process.env.NODE_ENV === 'development') {
                console.log(`[useNotificationCount] Subscribed for user ${userId}`);
              }
            }
          });

        subscription = channel;
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      }
    };

    subscribe();

    return () => {
      isMounted = false;
      if (subscription) {
        supabase.removeChannel(subscription);
      }
    };
  }, [userId]);

  const markRead = async (notificationId: string) => {
    try {
      // update-no-select-ok: gh-2105 decision b -- read receipt for the bell; a zero-row match (notification already read, deleted, or not visible to this user) only leaves the unread badge stale until the next load; no money, consent or legal state hangs on read_at.
      await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', notificationId);
      // Optimistic decrement
      setCount((prev) => Math.max(0, prev - 1));
    } catch (err) {
      console.error('[useNotificationCount] Failed to mark as read:', err);
      throw err;
    }
  };

  return { count, loading, error, markRead };
}
