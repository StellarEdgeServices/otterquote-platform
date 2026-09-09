# Pre-Flight: gh1075_partner_agreement_v2_version_bump

**Migration**: 20260820195608_gh1075_partner_agreement_v2_version_bump.sql
**Date**: 2026-08-20
**Author**: Claude Code (run-work rw-f22-20260820T193003-a9c2)
**D-numbers**: D-301 (commission -> referral fee rename), D-311 (AAA -> JAMS), D-182 (Tier 3), D-221 (Path A)
**Tracking**: gh-1075 (P1, "edit in place" — Dustin's verbatim ruling, R-135)

## Change Summary

`partner-agreement.html` Section 15 (arbitration administrator) and Section 4
(referral-fee prose) were amended in the same PR as this migration. Amending
Section 4's substantive terms is exactly the scenario
`20260820004212_gh1059_partner_agreement_acceptance.sql`'s own header comment
anticipated: *"Bump this string (and add the companion migration) whenever
partner-agreement.html's substantive terms change; #1075 (gated on this
issue) is the first such bump."* This migration does exactly that and
nothing else: `register_partner()`'s `v_agreement_version` constant moves
from `'v1-2026-08'` to `'v2-2026-08'`.

## Tier Determination

**3A, autonomous.** Confirmed from the actual diff:
- Single `CREATE OR REPLACE FUNCTION`, no `DROP`/`ALTER ... TYPE`, no schema
  change, no new columns or tables.
- The diff against the live function is exactly one literal
  (`'v1-2026-08'` -> `'v2-2026-08'`) — signature, parameters, validation,
  rate-limit gate, IP/UA capture, INSERT column list, error handling, and
  return shape are byte-identical.
- Does not touch Stripe, email/SMS send, or an auth boundary. Does not
  change what data is collected or how consent is gated — the client-side
  "I agree to Partner Terms" checkbox requirement is unchanged; this only
  changes which version string a NEW acceptance is stamped with.
- Explicitly pre-approved: gh-1075's title and body quote Dustin's ruling
  verbatim ("Edit in place") per R-135, and AC2 on that issue names this
  exact version-bump as required closure evidence.

## Gate re-verified live (matches gh-1075's own stated gate)

gh-1075 requires #1059 to have landed first — "a version bump needs
somewhere to be recorded." Confirmed live, this session:
- `#1059` is `state: closed`, `state_reason: completed`, closed via merged
  PR #1076 (`pull_request_read` / `issue_read`).
- `20260820004212_gh1059_partner_agreement_acceptance.sql` exists on `main`
  and is the migration that added the four `referral_agents` columns and
  the `v_agreement_version` constant this migration modifies.

## Live exposure re-verified (why no notice is owed under Section 17)

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE partner_agreement_accepted_at IS NOT NULL) AS accepted
FROM public.referral_agents;
-- {"total":13,"accepted":0}
```
Zero persisted acceptances exist under any version, `v1-2026-08` or
otherwise. Section 17's 30-day-notice-plus-re-acknowledgment obligation runs
to parties; there are none yet. (Note, carried forward from gh-1059's own
pre-flight, not re-litigated here: 6 of the 13 rows are not `is_test` —
Dustin's own signup walkthroughs plus one external contact. None are the
named D-297 family-send recipients, so "zero real sends yet" still holds.
That flagging is #950's domain, not this migration's.)

## Verification (gh-1075 AC2)

Post-apply, sign up a test partner through any `partner-*.html` form and
confirm the resulting row's `partner_agreement_version = 'v2-2026-08'` —
query posted to gh-1075 as closing evidence.

## Rollback

`supabase/migrations_rollbacks/gh1075_partner_agreement_v2_version_bump_rollback.sql`.
Restores `register_partner()`'s constant to `'v1-2026-08'`, byte-identical
otherwise. Pure code revert — does not rewrite any row that already
recorded `v2-2026-08` as what a partner accepted; that record is real
history and rolling back the function does not erase it. No data-loss
warning needed (contrast gh-1059's rollback, which drops columns).
