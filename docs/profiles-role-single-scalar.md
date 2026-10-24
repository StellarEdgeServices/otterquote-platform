# profiles.role — Single-Scalar Role Constraint (Multi-Role Users)
# Authored: 2026-08-15 | run-work rw-e7c2-w16 | gh-909 (from #643 AC #6, #817)

---

## Why This Document Exists

`profiles.role` is a single scalar `text` column, but real accounts hold more than one
functional role at once (contractor + referral agent today; other combinations are
possible tomorrow). Issue #909 tracks the constraint; this document records what is
actually true — live data, every reader, every writer, the failure modes already paid
for — so the eventual design decision (extend the schema vs. formally accept
precedence-based disambiguation) is made against facts rather than code comments.

**This document deliberately does NOT choose a design.** That is an architecture
decision for the Bridge/Dustin (see Design Options at the end).

---

## The Constraint

1. `profiles.role` holds exactly one of `'homeowner'` / `'contractor'` / `NULL`.
   No other value has ever been written by any code path (see Writers below) — in
   particular, **no partner value is ever written to it**.
2. A user's functional roles actually live in three places:
   - `contractors.user_id` → the user is a contractor
   - `referral_agents.user_id` (+ `status='active'`, `agent_type`) → the user is a partner
   - `profiles.role` → homeowner/contractor scalar, best-effort, stamped by signup flows
3. The DB trigger `public.handle_new_user()` (live prod, verified 2026-08-15) inserts
   the `profiles` row **without a role** — every new profile starts `role = NULL` until
   a client-side flow stamps it. The partner registration path
   (`register_partner` / `claim_partner_account` RPCs) never touches `profiles` at all
   (verified against live function bodies, 2026-08-15).
4. A JWT shadow copy exists: magic-link requests set `user_metadata.role` (e.g.
   `partner-login.html` sends `role: 'partner'`), which `index.html`'s bounce reads.
   This is a *fourth* role surface, independent of `profiles.role`.

---

## Live Distribution (prod `yeszghaspzwwstvsrioa`, VERIFIED 2026-08-15T20:19Z)

`profiles` (38 rows total — no NULL and no non-homeowner/contractor values exist):

| profiles.role | contractors row | referral_agents row | n  | meaning |
|---------------|-----------------|---------------------|----|---------|
| homeowner     | no              | no                  | 19 | plain homeowner |
| contractor    | yes             | no                  |  9 | plain contractor |
| homeowner     | no              | yes                 |  5 | **partner-only, role says homeowner** |
| contractor    | **no**          | no                  |  3 | **orphan: role says contractor, no contractors row** |
| contractor    | yes             | yes                 |  2 | **dual-role (contractor + partner)** |

`referral_agents` (12 rows, all `status='active'`):

| linkage | profiles.role | also contractor | n |
|---------|---------------|-----------------|---|
| `user_id IS NULL` (never claimed — no auth user, no profile) | — (no profile exists) | no | 5 |
| linked | homeowner | no | 5 |
| linked | contractor | yes | 2 |

**Refinement of the #643 close-out claim** (#643 comment 5304013369: "5 of 10
partner-only accounts have NULL profiles.role"): re-verified live 2026-08-15. The 5
"NULL" partner accounts are `referral_agents` rows with `user_id IS NULL` — they have
**no profiles row at all** (registered via `register_partner`, never claimed via
`claim_partner_account`). A LEFT JOIN from `referral_agents` reads their role as NULL,
but no linked profile carries a NULL `role` column value today (0 of 38). The 08-14
`js/auth.js` code comment ("every real partner-only account carries
`profile_role='homeowner'`") is true only of the 5 *linked* partner-only accounts.

---

## Readers of profiles.role (3 of 3 direct read sites, local repo grep 2026-08-15)

GitHub code search is broken org-wide (#690); this enumeration is from local grep of
`main` (`from('profiles')` + role selects). `template_review_role` (a `contractors`
column) and `messages.sender_role` are different columns and are excluded.

| # | Site | Precedence | NULL behavior | Multi-role behavior |
|---|------|-----------|---------------|---------------------|
| 1 | `js/auth.js` `getRole()` (fallback via `getProfile()`) | `contractors` → active `referral_agents.agent_type` → `profiles.role` → `null` | returns `null`; `requireAuth()` exact-match gates then redirect per page | dual contractor+partner resolves `'contractor'`; partner surfaces are protected by surface-awareness (`_isPartnerSurfaceFile()` stay-put in `redirectToDashboard()` / `requireAuth()`), **not** by the role value |
| 2 | `react-app/app/providers/auth-provider.tsx` `resolveRole()` | `contractors` → `profiles.role` → `null` — **no referral_agents branch** | HomeownerShell is permissive-on-null (D-211); settles authenticated with best-effort null role | a partner-only user in the React app resolves `'homeowner'` (their stamped scalar) or `null`; acceptable today because the React app has no partner surface — **a future partner page in react-app reopens the #643 class** |
| 3 | `react-app/app/auth-callback/page.tsx` | `contractors` → `profiles.role` → `null` | NULL + no contractor intent → homeowner path (dashboard/trade-selector) | partner is never a routing candidate here; static `auth-callback.html` (via `getRole()`, site 1) is what routes partners |

Indirect consumers inherit site 1's precedence: `auth-callback.html:192`, `js/nav.js`
`_renderAuthSlot()`, `requireAuth()` role-mismatch logic. Zero Edge Functions read
`profiles.role` (local grep of `supabase/functions/`, 2026-08-15).

Adjacent (not `profiles.role`, same defect class): `index.html` bounce reads JWT
`user_metadata.role` + `localStorage cs_auth_role` (see
`tests/auth-index-bounce-routing.mjs` for the precedence it must keep).

---

## Writers of profiles.role (5 of 5 code paths, local repo grep 2026-08-15)

| # | Site | Writes | When |
|---|------|--------|------|
| 1 | `js/auth.js` `handleAuthCallback()` → `updateProfile({ role: data.role \|\| 'homeowner' })` | `'homeowner'` (from `cs_signup`, stamped by `get-started.html`) | homeowner magic-link signup |
| 2 | `js/auth.js` `handleAuthCallback()` contractor branch (`.update({ role: 'contractor' })`) | `'contractor'` | contractor signup (`cs_contractor_signup`) |
| 3 | `dashboard.html` fallback profile create | `'homeowner'` | dashboard visited with signup data but no profile fields |
| 4 | `react-app/app/trade-selector/page.tsx` profiles upsert | `'homeowner'` | React trade-selector entry |
| 5 | `tests/e2e/seed/seed.mjs` | `'homeowner'` / `'contractor'` | test world only |

Not writers: `handle_new_user()` trigger (no role column), `register_partner`,
`claim_partner_account` (never touch `profiles`). Consequences: (a) a profile whose
user never completes a homeowner/contractor flow keeps `role = NULL`; (b) the scalar
records *first-stamped signup lane*, not current functional role; (c) the 3 live
"contractor role, no contractors row" orphans are stamped intent that never became a
contractor record (site 2 stamps the profile before the contractors INSERT, which is
deliberately non-blocking).

---

## Known Failure Modes (the #643 regression class)

1. **Partner-only misroute (paid for, fixed).** Pre-#842, `getRole()` had no
   `referral_agents` branch: partner-only accounts fell through to
   `profiles.role='homeowner'` and were deposited on the homeowner dashboard (#632
   item 4 → #643/#817). Fixed by PR #842 (`3350188`) + surface-aware routing
   (#783/#807/#854) + stale `cs_redirect` discard. Guarded by
   `tests/auth-partner-role-resolution.mjs` and `tests/auth-partner-surface-single-source.mjs`.
2. **Dual-role disambiguation is positional, not represented.** A contractor+partner
   user resolves `'contractor'` from every single-value getter; only *which page they
   are already on* routes them to partner surfaces. Any new caller that trusts the
   single value re-derives the wrong answer.
3. **Every direct `profiles.role` read is a latent instance.** Reader site 2
   (auth-provider) already omits the `referral_agents` branch — harmless only while
   the React app has no partner surface. A third functional role (e.g. contractor who
   is also a homeowner-claimant) reopens the class from a new angle with no code
   change at all.
4. **The scalar can contradict the fact tables** (3 live orphan rows; 5 partner rows
   with no profile). Queries or dashboards that group users by `profiles.role`
   silently miscount.

---

## Design Options (decision NOT made here — Bridge/Dustin call)

| Option | Shape | Pros | Cons |
|--------|-------|------|------|
| A. Junction table | `user_roles(user_id, role)` rows; `profiles.role` deprecated or kept as display default | Represents N roles honestly; RLS-able per role; matches #909's own suggestion | Migration (D-182 Tier 3) + every reader/writer changes; precedence still needed for single-value contexts (routing) |
| B. Role array | `profiles.roles text[]` | Small migration; single-row read | Arrays are awkward in RLS/indexes; still needs precedence; scalar/array coexistence risk |
| C. Derived-role view | View/RPC computing roles from `contractors`/`referral_agents`/`claims` — fact tables stay the only truth | No new writable state; cannot drift; `getRole()` becomes one query | Read cost per resolution; still returns a set → precedence still needed; NULL-linkage partners remain invisible until claimed |
| D. Status quo, formalized | Keep scalar + precedence (`contractors` → active `referral_agents` → `profiles.role`) + surface-awareness as the *documented permanent design* | Zero migration; already shipped and device-verified | The constraint this document describes persists; every future direct reader is a footgun; #909 AC then requires recording this as the accepted design |

Whichever way it goes: the decision belongs on #909, cross-referenced to #643 AC #6
and #817. Until then, **no new code should read `profiles.role` directly** — go
through `js/auth.js getRole()` (or replicate its full precedence including
`referral_agents`), and treat `profiles.role` as signup-lane metadata, not identity.
