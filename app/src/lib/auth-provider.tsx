'use client';
import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { createClient } from '@supabase/supabase-js';
import { AuthState, AuthUser, UserRole } from './auth-types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type AuthContextType = AuthState & {
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    loading: true,
    ready: false,
  });

  const _initFired = useRef(false);

  useEffect(() => {
    // Watch for auth state changes
    const { data } = supabase.auth.onAuthStateChange(async (event, session) => {
      // Only process INITIAL_SESSION and SIGNED_IN events once via _initFired guard
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && !_initFired.current) {
        _initFired.current = true;

        if (session) {
          // User is authenticated — resolve their role
          const user = session.user;
          let role: UserRole = 'homeowner';
          let contractorId: string | undefined;

          // 1. Check contractors table first
          const { data: contractorData } = await supabase
            .from('contractors')
            .select('id')
            .eq('user_id', user.id)
            .single();

          if (contractorData) {
            role = 'contractor';
            contractorId = contractorData.id;
          } else {
            // 2. Check profiles table
            const { data: profileData } = await supabase
              .from('profiles')
              .select('id')
              .eq('user_id', user.id)
              .single();

            if (profileData) {
              role = 'homeowner';
            } else {
              // 3. Check admin allowlist
              const adminAllowlist = ['dustinstohler1@gmail.com'];
              if (adminAllowlist.includes(user.email || '')) {
                role = 'admin';
              } else {
                // 4. Safe default
                role = 'homeowner';
              }
            }
          }

          const authUser: AuthUser = {
            id: user.id,
            email: user.email || '',
            role,
            contractorId,
          };

          setAuthState({
            user: authUser,
            loading: false,
            ready: true,
          });
        } else {
          // No session — user is signed out
          setAuthState({
            user: null,
            loading: false,
            ready: true,
          });
        }
      }

      // Handle SIGNED_OUT event
      if (event === 'SIGNED_OUT') {
        setAuthState({
          user: null,
          loading: false,
          ready: true,
        });
      }
    });

    return () => {
      data?.subscription?.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ ...authState, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
