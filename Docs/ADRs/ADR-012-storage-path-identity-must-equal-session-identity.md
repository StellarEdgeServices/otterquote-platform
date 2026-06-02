# ADR-012 — Storage object path identity MUST equal the authenticating session identity

**Status:** Accepted
**Date:** 2026-06-01
**Context bug:** pfw-1780341475 (Stage 3 COI upload RLS 400). Related: ADR-011 (warm-reload session timing), D-212 (token-only cross-subdomain cookie SSO).

## Context

Supabase Storage buckets enforce per-user isolation with an RLS policy of the form
`auth.uid()::text = (storage.foldername(name))[1]` — i.e. the first segment of the object
path must equal the uploader's authenticated user id. The `contractor-documents` bucket uses
exactly this policy for INSERT/SELECT/UPDATE/DELETE.

On `contractor-pre-approval.html`, the COI upload built the object path from `currentUser.id`,
where `currentUser` was captured at page-init from `window.Auth.getSession()`. After D-212,
`Auth.getSession()` gained a **fast-path** that decodes the `sb-otterquote-at` cookie locally
and returns it without a network call or refresh. Because that cookie is written at
`Domain=.otterquote.com` (domain-wide, ~7-day Max-Age), a browser that already held another
OtterQuote session (e.g. an operator/admin account, or the PFW harness sharing the operator's
domain cookies) would have the fast-path return that **stale identity**. Meanwhile the actual
`sb.storage.upload()` call authenticates with the **live `sb` client session**.

When the init-time identity and the live session identity differ, the upload writes to path
`{staleUid}/...` under a JWT whose `auth.uid()` is `{liveUid}` — the RLS WITH CHECK fails and
Postgres returns HTTP 400 `new row violates row-level security policy`. In pfw-1780341475 the
path carried `3ea4d929` (operator account) while the live session was `514faa50` (the fresh
pfw-contractor). The failure is silent in the sense that nothing distinguishes it from a genuine
permission problem; the storage RLS policy and the bucket were entirely correct and unchanged.

## Decision

Any storage object path whose first segment is an identity MUST derive that identity from the
**same session object used to authenticate the request** — never from a cached, init-time, or
fast-path user object that may have drifted from the live client session.

Concretely, on `contractor-pre-approval.html`:
- The COI path uid is sourced from `sb.auth.getSession()` (the live client session that the
  `.upload()` call itself uses), not from `currentUser`.
- If there is no live session at upload time, throw a clear, user-facing error rather than
  attempting an upload that will 400.
- If the init-time `currentUser.id` differs from the live session uid, log a loud
  `console.warn` (identity-mismatch signal) and reconcile `currentUser` to the live session
  before proceeding. This converts the previously-silent class of failure into a visible,
  self-correcting condition.

The general invariant: **path[1] === auth.uid()** must hold by construction at the call site,
not by assuming an earlier-read identity is still current.

## Consequences

- Returning/shared-device users (and the PFW harness) no longer fail COI upload due to a stale
  domain-wide cookie identity.
- The mismatch `console.warn` gives us a runtime breadcrumb if any other auth path lets a stale
  identity reach a storage call.
- Follow-up: a full cross-account E2E reproducer (seed two accounts, plant a domain-wide cookie
  for account A, authenticate as account B, assert the COI path uses B and the upload succeeds)
  is tracked separately as the deterministic regression lock for this invariant.

## Scope note

This ADR is specifically about identity-keyed storage paths. The broader hardening of
`Auth.getSession()`'s fast-path (so it reconciles against the live client rather than trusting a
domain-wide cookie) is a separate, larger change tracked in the follow-up; this ADR fixes the
upload call site, which is the load-bearing invariant for data isolation.
