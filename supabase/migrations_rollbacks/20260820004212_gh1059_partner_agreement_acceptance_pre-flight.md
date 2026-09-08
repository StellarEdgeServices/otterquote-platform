# Pre-Flight: gh1059_partner_agreement_acceptance

**Migration**: 20260820004212_gh1059_partner_agreement_acceptance.sql
**Date**: 2026-08-20
**Author**: Claude Code (run-work rw-f22-20260820T003631-k7p2)
**D-numbers**: D-182 (Tier 3), D-221 (Path A)
**Tracking**: gh-1059 (P1 BLOCKER, filed by Bridge `bridge-overdrive-20260819T1944Z` out of the P1 legal-instrument inventory)

## Change Summary

`partner-agreement.html` has an "I agree to Partner Terms" checkbox on every
partner signup page. The acceptance was written nowhere — no version, no
timestamp, no IP. This migration:

1. Adds four columns to `referral_agents`: `partner_agreement_version` (text),
   `partner_agreement_accepted_at` (timestamptz), `partner_agreement_attestation`
   (jsonb, default `{}`), `needs_partner_reacceptance` (boolean, default false).
   Mirrors `contractors.cpa_version` / `cpa_accepted_at` / `ic_24511_attestation`
   / `needs_cpa_reattestation` — same shape, not a second convention.
2. Modifies `register_partner()` (SECURITY DEFINER, anon-callable, called from
   every partner signup page) to stamp all three at INSERT time, reading
   IP/UA from PostgREST's `request.headers` GUC — same technique
   `record_cpa_ip()` uses for the contractor path. **Signature and every
   existing parameter/behavior are unchanged**; the diff is three new INSERT
   targets and their values.
3. Adds `record_partner_agreement_reacceptance(uuid, text)` — a minimal,
   ownership-checked SECURITY DEFINER RPC satisfying AC4's Section 17
   re-acknowledgment requirement. Not yet called from any UI — wiring a
   partner-dashboard re-acceptance surface is follow-up scope for whichever
   PR ships the next Section 4 amendment (the D-301 rename, #1075/#1054),
   since that is the first time this mechanism actually needs exercising.

## Tier Determination

**3A, autonomous.** Confirmed from the actual diff, not assumed from the
issue's own suggestion:
- No `DROP`, `ALTER ... TYPE`, or destructive statement.
- Four new columns, all nullable or safely defaulted — no `NOT NULL` without
  a default, no backfill of existing rows (see AC5 below).
- `register_partner()`'s parameter list, validation, rate-limit gate,
  error handling, and return shape are byte-identical to the live function
  except for the three new INSERT targets. No existing caller's behavior
  changes.
- Does not touch Stripe, email/SMS send, or an auth boundary — it stamps
  metadata onto a row already being created by an existing, already-anon-
  callable path.
- New RPC (`record_partner_agreement_reacceptance`) is `GRANT`ed to
  `authenticated` only, ownership-checked (`user_id = auth.uid()`), same
  authorization shape as `record_cpa_ip`.

## AC5 — existing 13 rows

Left with all four new columns at their column default (`version`/
`accepted_at` NULL, `attestation` `{}`, `needs_reacceptance` false). **Not
backfilled** — a fabricated `accepted_at` for a row that never went through a
persisted acceptance flow would misrepresent history. NULL is the accurate
statement: no record of acceptance exists for these rows. Board Q10's
"FLAG." ruling (originally about the same 13 rows in a different issue, #950)
is honored the same way here: nothing is deleted, nothing is invented.

**Live-query finding, worth flagging explicitly:** the issue and lane note
describe these as "all 13 test accounts." A live query
(`SELECT count(*) FILTER (WHERE NOT is_test) FROM referral_agents`) found
**6 of 13 are NOT flagged `is_test`** — they are Dustin's own signup
walkthroughs (`dustinstohler1@gmail.com` and two `+` variants) plus one
external contact (`stacymortonfitfan@gmail.com`, `agent_type='re_agent'`,
row not test-flagged). None are Shane Wilson or Miriam (the named D-297
family-send recipients), so the "zero real partner sends yet" premise this
issue's urgency rests on is still true — but the "13 test accounts" framing
is imprecise, and the untest-flagged `stacymortonfitfan` row is exactly the
kind of pre-existing, non-persisted acceptance this migration cannot
retroactively fix. Reported on the issue rather than acted on — flagging
`is_test` correctly for that cohort is #950's domain, not this one's.

## Verification (AC3)

Post-apply, sign up a test partner through any `partner-*.html` form and
confirm the resulting row has `partner_agreement_version`,
`partner_agreement_accepted_at`, and a non-empty `partner_agreement_attestation`
populated — query posted to gh-1059 as closing evidence (`closes-on: query`).

## Rollback

`supabase/migrations_rollbacks/gh1059_partner_agreement_acceptance_rollback.sql`.
Restores `register_partner()` byte-identical to its pre-gh1059 (gh973) form,
drops the new RPC, drops the four columns. **Data-loss warning inline in the
rollback file**: if any partner has registered since this migration applied,
their acceptance record is destroyed by the column drop, not just schema —
the rollback file includes a live-row-count guard query to run first.
