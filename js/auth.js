/**
 * ClaimShield v2 — Auth Helpers
 * Magic link authentication via Supabase Auth
 */

const Auth = {
  /** Get current session */
  async getSession() {
    if (!sb) return null;
    const { data: { session } } = await sb.auth.getSession();
    return session;
  },

  /** Get current user */
  async getUser() {
    const session = await this.getSession();
    return session?.user || null;
  },

  /** Send magic link email */
  async sendMagicLink(email) {
    if (!sb) throw new Error('Supabase not initialized');
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${CONFIG.SITE_URL}/dashboard.html`,
      }
    });
    if (error) throw error;
    return true;
  },

  /** Sign out */
  async signOut() {
    if (!sb) return;
    await sb.auth.signOut();
    window.location.href = '/index.html';
  },

  /** Check if user is authenticated, redirect to login if not */
  async requireAuth() {
    const user = await this.getUser();
    if (!user) {
      sessionStorage.setItem('cs_redirect', window.location.pathname);
      window.location.href = '/get-started.html';
      return null;
    }
    return user;
  },

  /** Listen for auth state changes */
  onAuthChange(callback) {
    if (!sb) return;
    sb.auth.onAuthStateChange((event, session) => {
      callback(event, session);
    });
  },

  /** Get user profile from profiles table */
  async getProfile() {
    const user = await this.getUser();
    if (!user) return null;
    const { data, error } = await sb
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    if (error) return null;
    return data;
  },

  /** Update user profile */
  async updateProfile(updates) {
    const user = await this.getUser();
    if (!user) throw new Error('Not authenticated');
    const { data, error } = await sb
      .from('profiles')
      .upsert({ id: user.id, ...updates, updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
};
