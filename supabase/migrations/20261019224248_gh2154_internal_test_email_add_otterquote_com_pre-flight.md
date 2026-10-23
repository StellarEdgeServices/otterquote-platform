# Pre-flight: 20261019224248_gh2154_internal_test_email_add_otterquote_com (#2154)

Ruling: Ben, CEO RUN 111, comment 6274019475 on #2154, item 1: "RULED: add otterquote.com to the test-domain list. No is_test=false window."

Measured read-only on production (Supabase MCP SELECT, 2026-10-19, CTO RUN 72 worker):
- `public.is_internal_test_email` domain list today: stellaredgeservices.com, tryotterquote.com, stohlerroof.com, otterquote-internal.test (+ two gmail base addresses). `otterquote.com` is absent.
- Dependents of `is_internal_test_email` (pg_proc prosrc, pg_views, pg_indexes, pg_policies): only `public.referral_agents_flag_internal_test` (BEFORE INSERT trigger on referral_agents). No index or policy uses it, so redefining an IMMUTABLE function needs no reindex.
- referral_agents rows at @otterquote.com: 1, already is_test = true. No existing row changes (INSERT-only trigger, no backfill).
- `register_partner` derives its own is_test from `is_test_email()` (@otterquote-internal.test only); the BEFORE INSERT trigger then raises it to true for otterquote.com. The trigger never sets false.

Effect: the #2154 walk (sloane+walkN@otterquote.com, Ben item 2) is born is_test = true, so the admin alert carries the `[TEST] ` prefix and no re-1 attribution is polluted.

Not covered (by design, flagged on #2154): `profiles.is_test` for the walk user is not set by this trigger.

Apply: Dustin's word in Marty's chat (R-077/R-135), then this file, then `supabase/tests/gh2154_otterquote_com_test_domain_proof.sql`.
Rollback: `supabase/migrations_rollbacks/20261019224248_gh2154_internal_test_email_add_otterquote_com_rollback.sql`.
