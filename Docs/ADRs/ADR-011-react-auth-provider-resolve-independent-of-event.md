# ADR-011 — React AuthProvider must resolve `loading` independent of `onAuthStateChange` event timing

**Status:** Accepted
**Date:** 2026-06-01
**Context bug:** 86e1mrwrx (get-started blank on warm reload). Continues ADR-009 (React data contracts) and the F-007 auth pattern.

## Context

`react-app/app/providers/auth-provider.tsx` originally initialized `loading: true` and only flipped it to `false` inside the `supabase.auth.onAuthStateChange` callback (on `INITIAL_SESSION` / `SIGNED_IN` / `SIGNED_OUT`).

This works on a **cold load**: the Supabase client has no cached session, so resolving the session involves a network round-trip, which delays `INITIAL_SESSION` emission until after React's `useEffect` has attached the listener.

It **fails on a warm reload**: the Supabase client reads a cached session from `localStorage` and emits `INITIAL_SESSION` *synchronously during client init* — before the `useEffect` runs and attaches the listener. The event is missed, no handler runs, `loading` stays `true` forever, and the page renders a blank dark screen with a spinner indefinitely.

Impact: a returning homeowner who refreshes or revisits `app.otterquote.com/get-started` (the funnel entry) sees nothing. Critical, and silent — no console error is thrown.

This is a different lifecycle from the classic `js/auth.js` (F-007) pages, where the event-only pattern is appropriate. The React provider's mount-vs-emit ordering is the new failure surface.

## Decision

A React auth context MUST resolve its `loading` state independent of whether an `onAuthStateChange` event reaches the listener. Concretely:

1. **Proactive fetch on mount.** Call `supabase.auth.getSession()` in the mount `useEffect` and resolve auth state from its result, via a shared `resolveSession()` helper guarded by a `resolved` ref so the first resolver wins and a late real event cannot double-resolve or flash an authenticated user out.
2. **Fallback timer (defense-in-depth).** A `setTimeout` (≤1.5s) that, if still `loading`, lifts the loading screen to the unauthenticated view using a functional `setState` that flips `loading` only and does NOT set `resolved` — so a late real session can still correct the state.
3. **Keep the event listener.** `onAuthStateChange` remains the source of truth for `SIGNED_IN` / `SIGNED_OUT` / `TOKEN_REFRESHED` after mount.

## Verification requirement

Changes to the React auth provider must be verified with a **warm-reload** probe (navigate, then reload) for an unauthenticated user — a cold load alone does not exercise the missed-event path and produced a false-negative in the original 86e1f6nud investigation.

## Consequences

- Eliminates the warm-reload blank-page hang.
- Adds at most a 1.5s worst-case delay before the unauthenticated view appears if both `getSession()` and the event fail to resolve — strictly better than an indefinite blank.
- Added as a HIGH item in `Deploy_Review_Checklist.md` (Auth Pattern).
- Runtime regression test tracked in ClickUp (warm-reload assertion in the homeowner E2E flow + optional AuthProvider unit test) — to land once the E2E suite is green.
