import { useAuth } from './auth-provider';

/**
 * Hook that returns true when auth is ready (INITIAL_SESSION fired).
 * Prevents flash of unauthenticated content by gating page renders.
 */
export function useAuthReady(): boolean {
  const { ready } = useAuth();
  return ready;
}
