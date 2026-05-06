export type UserRole = 'homeowner' | 'contractor' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  contractorId?: string; // populated if role === 'contractor'
}

export interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  ready: boolean; // true after INITIAL_SESSION fires
}
