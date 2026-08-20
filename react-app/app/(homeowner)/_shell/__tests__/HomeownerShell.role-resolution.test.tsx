/**
 * INTEGRATION test (jsdom) for the D-211 HomeownerShell role-resolution race
 * (ClickUp 86e1zve9n). Renders the REAL AuthProvider so the ASYNC role transition
 * is exercised end-to-end — NOT the synchronously-pre-resolved useAuthReady mock the
 * unit-level page tests use (that mock can never reproduce the race).
 *
 * ROOT CAUSE (verified against committed code, 847ac72): the provider AWAITS role
 * resolution before it flips `settled` true, so for a contractor whose role lookup
 * completes within ROLE_RESOLVE_TIMEOUT_MS there is NO wrong-role render window — the
 * shell shows the spinner, then redirects. The ONE real wrong-role render is the
 * fail-open path: when the contractor/profile lookup exceeds the 4s timeout, the
 * provider settles a best-effort null role (D-212, so a stalled DB can't hang the
 * gate) and PRE-FIX discarded the authoritative role when it finally arrived —
 * stranding the contractor on the homeowner page PERMANENTLY.
 *
 * FIX (self-heal only, D-212-safe): the provider keeps a handle on the authoritative
 * lookup and, when a timed-out role lands, upgrades `role` for the same settled user.
 * The HomeownerShell gate already depends on `role`, so the late 'contractor' value
 * fires the contractor-dashboard redirect. The >4s fail-open render is a transient,
 * documented consequence of D-212 (not eliminated — that was the declined "full gate"
 * option); permanent wrong-role render is.
 *
 * Mirrors HomeownerShell.cold-start.test.tsx (which covers the #343 session-recovery
 * race) — this file covers the role-resolution race on top of it.
 *
 * gh-909 (D-182 v113, 2026-08-19) update: resolveRole() used to make TWO queries
 * (contractors, then — only if that came back empty — an immediate profiles
 * fallback), so the old mock deferred only the first query and resolved the second
 * synchronously. It now makes ONE query (`resolved_user_role`), which already
 * encodes the full contractor -> partner -> claims -> profiles.role precedence
 * server-side (branch-tested — see supabase/migrations/v113_derived_role_view.sql).
 * The mock below reflects that: a single deferred `roleDeferred` stands in for the
 * one query, resolved per test with `{ data: { derived_role: <value> }, error }` —
 * the exact shape resolveRole() now reads. The timing races under test (in-flight
 * vs. >4s-timeout vs. immediate) are unchanged; only the number of queries being
 * raced changed from two to one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: vi.fn(() => ({ count: 0, loading: false, error: null })),
}));

// Capture the onAuthStateChange callback so the test drives INITIAL_SESSION by hand.
// getSession() hangs so the only route to a settled state is the event we fire.
// The `resolved_user_role` query is a deferred the test resolves on demand, so role
// resolution can be made to outrun the 4s timeout deterministically.
let authCb: ((event: string, session: unknown) => void | Promise<void>) | null = null;
let roleDeferred: {
  promise: Promise<{ data: unknown; error: unknown }>;
  resolve: (v: { data: unknown; error: unknown }) => void;
};

function makeDeferred() {
  let resolve!: (v: { data: unknown; error: unknown }) => void;
  const promise = new Promise<{ data: unknown; error: unknown }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        authCb = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      getSession: vi.fn(() => new Promise(() => {})),
      signOut: vi.fn(),
    },
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          single: () =>
            table === 'resolved_user_role'
              ? roleDeferred.promise
              : Promise.resolve({ data: null, error: { message: 'no rows' } }),
        }),
      }),
    })),
  },
}));

import { AuthProvider } from '@/providers/auth-provider';
import { HomeownerShell } from '../HomeownerShell';

function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeSession(email: string) {
  const NOW = Math.floor(Date.now() / 1000);
  const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u1', email, exp: NOW + 3600 })}.sig`;
  return { user: { id: 'u1', email }, access_token: token };
}

const PAST_TIMEOUT_MS = 4200; // > ROLE_RESOLVE_TIMEOUT_MS (4000)

let originalLocation: Location;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  authCb = null;
  roleDeferred = makeDeferred();
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: '' },
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.useRealTimers();
});

function renderShell() {
  return render(
    <AuthProvider>
      <HomeownerShell active="dashboard"><div>DASH_BODY</div></HomeownerShell>
    </AuthProvider>,
  );
}

describe('HomeownerShell × AuthProvider — role-resolution race (D-211 86e1zve9n)', () => {
  it('a contractor whose role resolves WITHIN the timeout never sees homeowner content — spinner, then contractor-dashboard redirect', async () => {
    renderShell();
    // Fire the auth event WITHOUT awaiting; role lookup is in flight (deferred unresolved).
    await act(async () => {
      void authCb!('INITIAL_SESSION', makeSession('pro@roofco.com'));
      await vi.advanceTimersByTimeAsync(100);
    });
    // In-flight: spinner only, no premature render or redirect.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('DASH_BODY')).not.toBeInTheDocument();
    expect(window.location.href).toBe('');

    // Role resolves to contractor, still well under the 4s timeout.
    await act(async () => {
      roleDeferred.resolve({ data: { derived_role: 'contractor' }, error: null });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(window.location.href).toBe('https://otterquote.com/contractor-dashboard.html');
    expect(window.location.href).not.toContain('get-started.html');
    expect(screen.queryByText('DASH_BODY')).not.toBeInTheDocument();
  });

  it('SELF-HEAL: a contractor whose role lookup exceeds the 4s timeout is still redirected once the authoritative role lands (no PERMANENT wrong-role render)', async () => {
    renderShell();
    await act(async () => {
      void authCb!('INITIAL_SESSION', makeSession('pro@roofco.com'));
      await vi.advanceTimersByTimeAsync(100);
    });
    // Cross the 4s fail-open timeout with the role lookup still hung.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);
    });
    // D-212 fail-open: gate settled with a best-effort null role, so the homeowner
    // body renders TRANSIENTLY rather than hanging. No redirect yet, and crucially
    // NEVER a get-started bounce for this authenticated user.
    expect(window.location.href).not.toContain('get-started.html');

    // The authoritative contractor role finally lands — self-heal must upgrade it
    // and the gate must now redirect, ending the wrong-role render.
    await act(async () => {
      roleDeferred.resolve({ data: { derived_role: 'contractor' }, error: null });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(window.location.href).toBe('https://otterquote.com/contractor-dashboard.html');
    expect(window.location.href).not.toContain('get-started.html');
    expect(screen.queryByText('DASH_BODY')).not.toBeInTheDocument();
  });

  it('SELF-HEAL homeowner: a slow (>4s) homeowner role lands → keeps rendering, never redirects', async () => {
    renderShell();
    await act(async () => {
      void authCb!('INITIAL_SESSION', makeSession('jane@example.com'));
      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);
    });
    // Fail-open render of the homeowner body; no redirect of any kind.
    expect(window.location.href).toBe('');

    // resolved_user_role lookup finally lands as 'homeowner' (view precedence:
    // no contractor row, no active partner, no claim -> profiles.role fallback).
    await act(async () => {
      roleDeferred.resolve({ data: { derived_role: 'homeowner' }, error: null });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText('DASH_BODY')).toBeInTheDocument();
    expect(window.location.href).toBe(''); // still no redirect
  });

  it('homeowner happy path (role resolves WITHIN timeout) renders and never redirects', async () => {
    renderShell();
    await act(async () => {
      void authCb!('INITIAL_SESSION', makeSession('jane@example.com'));
      roleDeferred.resolve({ data: { derived_role: 'homeowner' }, error: null });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText('DASH_BODY')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('unauthenticated INITIAL_SESSION (no user, no cookie) still bounces to get-started.html — gate not weakened', async () => {
    renderShell();
    await act(async () => {
      void authCb!('INITIAL_SESSION', null);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(window.location.href).toBe('https://otterquote.com/get-started.html');
    expect(window.location.href).not.toContain('sign-in.html');
    expect(screen.queryByText('DASH_BODY')).not.toBeInTheDocument();
  });
});
