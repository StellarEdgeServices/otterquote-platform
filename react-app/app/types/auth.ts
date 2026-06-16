/**
 * Auth types for OtterQuote React app — D-211
 * Mirrors F-007 pattern from js/auth.js
 */

export type OtterRole =
  | 'homeowner'
  | 'contractor'
  | 're_agent'
  | 'insurance_agent'
  | 'home_inspector'
  | null;

export interface AuthUser {
  id: string;
  email: string;
  [key: string]: unknown;
}

export interface AuthState {
  /** null = unauthenticated or still loading */
  user: AuthUser | null;
  /** contractor-table-first role check (F-007) */
  role: OtterRole;
  /** True if user is in the admin allow-list (D-211) */
  isAdmin: boolean;
  /** True while INITIAL_SESSION has not yet fired */
  loading: boolean;
  /**
   * True once auth has been DEFINITIVELY resolved (a real session decision was
   * made via INITIAL_SESSION / SIGNED_IN / getSession(), or SIGNED_OUT). Distinct
   * from `loading`: the 1.5s blank-screen fallback flips `loading` to false
   * WITHOUT setting `settled`, so a gate (e.g. ContractorShell) can wait for a
   * definitive answer instead of bouncing an authenticated user mid-hydration
   * (D-211; postmortem 2026-06-16).
   */
  settled: boolean;
}

export interface AuthContextValue extends AuthState {
  /** Imperatively sign out the current user */
  signOut: () => Promise<void>;
}
