'use client';
import { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-provider';
import { useAuthReady } from '@/lib/use-auth-ready';
import { UserRole } from '@/lib/auth-types';

interface ProtectedRouteProps {
  children: ReactNode;
  allowedRoles: UserRole[];
}

/**
 * Wrapper component that enforces authentication and role-based access.
 * - Waits for auth to be ready (INITIAL_SESSION)
 * - Redirects to /login if not authenticated
 * - Redirects to / if authenticated but wrong role
 */
export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const router = useRouter();
  const { user } = useAuth();
  const ready = useAuthReady();

  // Still loading auth state
  if (!ready) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  // Not authenticated
  if (!user) {
    router.push('/login');
    return null;
  }

  // Authenticated but wrong role
  if (!allowedRoles.includes(user.role)) {
    router.push('/');
    return null;
  }

  // Authenticated with correct role
  return <>{children}</>;
}
