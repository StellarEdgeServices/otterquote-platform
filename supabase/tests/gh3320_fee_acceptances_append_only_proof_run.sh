#!/usr/bin/env bash
# gh-3320: run the fee_acceptances append-only proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGUSER=postgres bash supabase/tests/gh3320_fee_acceptances_append_only_proof_run.sh [outdir]
# The 4b case needs a server started with shared_preload_libraries=pg_stat_statements (else it FAILS; set GH3320_ALLOW_NO_PGSS=1 to skip it, and say so).
# Phases in one fresh database: 1-BEFORE (today; negative control) -> 2-AFTER (forward) -> 3-ROLLBACK (must look like BEFORE) -> 4-REAPPLIED (forward again, after a repeat run of the forward file).
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
DB=gh3320_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh3320_throwaway_schema.sql" >/dev/null || exit 2
snap() { psql -q -At -d "$DB" -c "SELECT relacl::text FROM pg_class WHERE oid='public.fee_acceptances'::regclass" -c "SELECT policyname||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public' AND tablename='fee_acceptances' ORDER BY policyname" > "$OUT/$1.snap"; }
pass() { psql -q -At -d "$DB" -f "$T/gh3320_fee_acceptances_append_only_proof.sql" > "$OUT/$1.txt" 2> "$OUT/$1.err"; echo "== $1"; cat "$OUT/$1.txt"; cat "$OUT/$1.err"; snap "$1"; }
pass 1-BEFORE
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3320_fee_acceptances_append_only.sql" >/dev/null || fail "forward failed"
pass 2-AFTER
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3320_fee_acceptances_append_only.sql" >/dev/null || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh3320_fee_acceptances_append_only_rollback.sql" >/dev/null || fail "rollback failed"
pass 3-ROLLBACK
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3320_fee_acceptances_append_only.sql" >/dev/null || fail "forward after rollback failed"
pass 4-REAPPLIED
for p in 1-BEFORE 2-AFTER 3-ROLLBACK 4-REAPPLIED; do grep -q '^FAILING=0 of' "$OUT/$p.txt" || fail "$p has failing rows"; done
diff "$OUT/1-BEFORE.snap" "$OUT/3-ROLLBACK.snap" >/dev/null || fail "ROLLBACK grants/policies differ from BEFORE"
diff "$OUT/2-AFTER.snap" "$OUT/4-REAPPLIED.snap" >/dev/null || fail "REAPPLIED differs from AFTER"
diff "$OUT/1-BEFORE.snap" "$OUT/2-AFTER.snap" >/dev/null && fail "AFTER identical to BEFORE (forward changed nothing)"
echo "== grants/policies BEFORE vs AFTER (diff)"; diff "$OUT/1-BEFORE.snap" "$OUT/2-AFTER.snap"

# ---- REVIEW FAIL 6643738676 fixes: pre-flight checks run against planted writers, and the guard is made to fire ----
# Pre-flight: extract the sql block of the pre-flight document, split it at "-- N." headers, run each check on a database that holds seven planted writers, a view and a cron row.
PF=pf_$DB; PFD="$OUT/preflight"; mkdir -p "$PFD"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $PF" -c "CREATE DATABASE $PF" || exit 2
psql -q -d "$PF" -v ON_ERROR_STOP=1 -f "$T/gh3320_throwaway_schema.sql" -f "$T/gh3320_planted_writers.sql" >/dev/null || exit 2
awk -v d="$PFD" '/^```sql/{on=1;next} /^```/{on=0} on{ if (match($0,/^-- [0-9]+\./)) {n=substr($0,4,RLENGTH-4); f=d"/check"n".sql"} if (f!="") print >> f }' "$RB/gh3320_fee_acceptances_append_only_pre-flight.md"
for n in 1 2 3 4 5 6; do [ -s "$PFD/check$n.sql" ] || fail "pre-flight check $n not found in the document"; done
for n in 1 2 3 4 5 6; do psql -d "$PF" -A -f "$PFD/check$n.sql" > "$PFD/check$n.out" 2> "$PFD/check$n.err"; done
echo "== pre-flight check 5 output"; cat "$PFD/check5.out"; echo "-- stderr:"; cat "$PFD/check5.err"
for n in 1 2 3 6; do [ -s "$PFD/check$n.err" ] && fail "pre-flight check $n raised: $(head -1 "$PFD/check$n.err")"; done
grep -v 'pg_stat_statements' "$PFD/check4.err" | grep -q ERROR && fail "pre-flight check 4 raised: $(head -1 "$PFD/check4.err")"
grep -q 'stats_reset' "$PFD/check4.out" || fail "pre-flight check 4 does not read stats_reset beside n_tup_upd"
grep -q 'n_tup_upd' "$PFD/check4.out" || fail "pre-flight check 4 does not read n_tup_upd"
grep -q ERROR "$PFD/check5.err" && fail "pre-flight check 5 raised: $(grep -m1 ERROR "$PFD/check5.err")"
found=0; for w in gh3320_w1_plain gh3320_w2_quoted gh3320_w3_only gh3320_w4_twospaces gh3320_w5_newline gh3320_w6_dynamic gh3320_w7_truncate; do
  if grep -q "$w" "$PFD/check5.out"; then found=$((found+1)); else echo "pre-flight check 5 MISSED $w"; fi; done
echo "PREFLIGHT planted functions found: $found of 7"; [ "$found" = 7 ] || fail "pre-flight check 5 found $found of 7 planted writers"
grep -q 'gh3320_v_edit' "$PFD/check5.out" && echo "PREFLIGHT planted view found: 1 of 1" || fail "pre-flight check 5 does not list the planted view"
grep -q 'gh3320_cron_writer' "$PFD/check5.out" && echo "PREFLIGHT planted cron job found: 1 of 1" || fail "pre-flight check 5 does not list the cron job"
grep -q '^gh3320_v1_inner|v|postgres||f|f|' "$PFD/check5.out" && grep -q '^gh3320_v2_outer|v|postgres||f|t|' "$PFD/check5.out" && echo "PREFLIGHT nested views found: 2 of 2 (outer one flagged authenticated_upd=t)" || fail "pre-flight check 5b does not list both levels of the nested views"
# Documents: the instruction about outer transactions must be the true one (REVIEW FAIL 6644033286, finding 1/6).
for doc in "$D/gh3320_fee_acceptances_append_only.sql" "$RB/gh3320_fee_acceptances_append_only_pre-flight.md"; do
  grep -qi 'outer transaction decides' "$doc" && fail "$doc still says the outer transaction decides (false: the file's COMMIT ends it)"
  grep -qi 'never dry-run this file by wrapping it' "$doc" || fail "$doc lacks the never-dry-run-by-wrapping instruction"
done
grep -q 'exits 0' "$RB/gh3320_fee_acceptances_append_only_pre-flight.md" || fail "pre-flight does not say why a plain -f is not enough (exit 0 when the guard fires)"
# Check 6: the digest must move when ANY column changes (the review changed accepted_at, ip_address, user_agent, fee_pct, rescinded_at; this also does the rest).
d0=$(psql -q -At -d "$PF" -f "$PFD/check6.sql"); echo "digest before: $d0"; moved=0; total=0
for col in "accepted_at = accepted_at + interval '1 second'" "ip_address = '203.0.113.8'" "user_agent = 'UA/2.0'" "fee_pct = 6.00" "rescinded_at = now()" "rescission_reason = 'x'" "invoice_url = 'x'" "fee_text_displayed = 'x'" "fee_amount = 1" "fee_basis = 'x'" "created_at = created_at + interval '1 second'"; do
  total=$((total+1)); d1=$( { echo "BEGIN; UPDATE public.fee_acceptances SET $col;"; cat "$PFD/check6.sql"; echo "ROLLBACK;"; } | psql -q -At -d "$PF" )
  if [ "$d1" != "$d0" ]; then moved=$((moved+1)); else echo "digest DID NOT MOVE for: $col"; fi; done
echo "DIGEST moved for $moved of $total single-column edits"; [ "$moved" = "$total" ] || fail "check 6 digest moved for only $moved of $total column edits"
# View-in-view: after the forward file a client role can still rewrite the table through the outer view, which is why 5b must list every level (informational, then asserted).
psql -q -d "$PF" -v ON_ERROR_STOP=1 -f "$D/gh3320_fee_acceptances_append_only.sql" >/dev/null 2>&1 || fail "forward failed on the planted database"
vr=$(psql -q -At -d "$PF" -c "SET ROLE authenticated" -c "WITH u AS (UPDATE public.gh3320_v2_outer SET fee_text_displayed = 'via nested view' RETURNING 1) SELECT 'rows=' || count(*) FROM u" | tail -1)
echo "VIEWBYPASS after the forward file, authenticated UPDATE through the nested view: $vr"
psql -q -d postgres -c "DROP DATABASE $PF"

# Guard: make it FIRE, apply with the PR's own form (plain psql -f), and show nothing was committed.
GD=gd_$DB; GDD="$OUT/guard"; mkdir -p "$GDD"
gsnap() { psql -q -At -d "$GD" -c "SELECT relacl::text FROM pg_class WHERE oid='public.fee_acceptances'::regclass" -c "SELECT policyname||'|'||cmd||'|'||roles::text FROM pg_policies WHERE schemaname='public' AND tablename='fee_acceptances' ORDER BY policyname" > "$GDD/$1.snap"; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $GD" -c "CREATE DATABASE $GD" || exit 2
psql -q -d "$GD" -v ON_ERROR_STOP=1 -f "$T/gh3320_throwaway_schema.sql" >/dev/null || exit 2
# G1: UPDATE granted to PUBLIC survives the two statements, so the guard must raise
psql -q -d "$GD" -c "GRANT UPDATE ON public.fee_acceptances TO PUBLIC"; gsnap G1-before
psql -q -d "$GD" -f "$D/gh3320_fee_acceptances_append_only.sql" > "$GDD/G1.out" 2>&1; echo "== G1 plain psql -f, UPDATE granted to PUBLIC"; cat "$GDD/G1.out"; gsnap G1-after
grep -q 'client privilege survived' "$GDD/G1.out" || fail "G1: the guard did not fire"
diff "$GDD/G1-before.snap" "$GDD/G1-after.snap" >/dev/null && echo "G1 nothing committed: grants and policies identical before and after the failed apply" || { echo "G1 COMMITTED PARTIAL STATE:"; diff "$GDD/G1-before.snap" "$GDD/G1-after.snap"; fail "G1: the failed apply left committed changes"; }
psql -q -At -d "$GD" -c "SELECT 'policy_count=' || count(*) FROM pg_policies WHERE schemaname='public' AND tablename='fee_acceptances'" -c "SELECT 'authenticated_update=' || has_table_privilege('authenticated','public.fee_acceptances','UPDATE')"
psql -q -d "$GD" -v ON_ERROR_STOP=1 -f "$D/gh3320_fee_acceptances_append_only.sql" >/dev/null 2>&1; g1rc=$?; echo "G1b ON_ERROR_STOP=1 exit code $g1rc"; [ "$g1rc" != 0 ] || fail "G1b: psql exited 0 although the guard should raise"
gsnap G1b-after; diff "$GDD/G1-before.snap" "$GDD/G1b-after.snap" >/dev/null || fail "G1b: committed changes"
# G2: a surviving FOR ALL policy (no privilege problem) must also raise and roll back
psql -q -d "$GD" -c "REVOKE UPDATE ON public.fee_acceptances FROM PUBLIC" -c "CREATE POLICY gh3320_rogue_all ON public.fee_acceptances FOR ALL TO public USING (true)"; gsnap G2-before
psql -q -d "$GD" -f "$D/gh3320_fee_acceptances_append_only.sql" > "$GDD/G2.out" 2>&1; echo "== G2 plain psql -f, FOR ALL policy present"; cat "$GDD/G2.out"; gsnap G2-after
grep -q 'UPDATE, DELETE or ALL policy survives' "$GDD/G2.out" || fail "G2: the guard did not fire"
diff "$GDD/G2-before.snap" "$GDD/G2-after.snap" >/dev/null && echo "G2 nothing committed" || { diff "$GDD/G2-before.snap" "$GDD/G2-after.snap"; fail "G2: the failed apply left committed changes"; }
# G3: with the cause removed the same file applies cleanly (the guard is not simply always failing)
psql -q -d "$GD" -c "DROP POLICY gh3320_rogue_all ON public.fee_acceptances"
psql -q -d "$GD" -v ON_ERROR_STOP=1 -f "$D/gh3320_fee_acceptances_append_only.sql" >/dev/null 2>&1 && echo "G3 clean apply exit 0" || fail "G3: clean apply failed"
g3=$(psql -q -At -d "$GD" -c "SELECT count(*) || '/' || has_table_privilege('authenticated','public.fee_acceptances','UPDATE') || '/' || has_table_privilege('anon','public.fee_acceptances','DELETE') FROM pg_policies WHERE schemaname='public' AND tablename='fee_acceptances'"); echo "G3 policies/authenticated_update/anon_delete after clean apply: $g3"; [ "$g3" = "3/false/false" ] || fail "G3: unexpected state after clean apply: $g3"
psql -q -d postgres -c "DROP DATABASE $GD"

# G4: TRUNCATE held by authenticated survives, the guard must raise and nothing may commit
psql -q -d postgres -c "DROP DATABASE IF EXISTS $GD" -c "CREATE DATABASE $GD" || exit 2
psql -q -d "$GD" -v ON_ERROR_STOP=1 -f "$T/gh3320_throwaway_schema.sql" >/dev/null || exit 2
psql -q -d "$GD" -c "GRANT TRUNCATE ON public.fee_acceptances TO authenticated"; gsnap G4-before
psql -q -d "$GD" -f "$D/gh3320_fee_acceptances_append_only.sql" > "$GDD/G4.out" 2>&1; echo "== G4 plain psql -f, TRUNCATE granted to authenticated"; cat "$GDD/G4.out"; gsnap G4-after
grep -q 'authenticated:TRUNCATE' "$GDD/G4.out" || fail "G4: the guard did not fire on a surviving TRUNCATE"
diff "$GDD/G4-before.snap" "$GDD/G4-after.snap" >/dev/null && echo "G4 nothing committed" || fail "G4: the failed apply left committed changes"
# G5: a column-level UPDATE grant by ANOTHER grantor survives the REVOKE; pre-flight check 1b must show it and the guard must raise
psql -q -d "$GD" -c "REVOKE TRUNCATE ON public.fee_acceptances FROM authenticated"
psql -q -d "$GD" -c "DO \$r\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gh3320_grantor') THEN CREATE ROLE gh3320_grantor NOLOGIN; END IF; END \$r\$" -c "GRANT USAGE ON SCHEMA public TO gh3320_grantor" -c "GRANT UPDATE ON public.fee_acceptances TO gh3320_grantor WITH GRANT OPTION"
psql -q -d "$GD" -c "SET ROLE gh3320_grantor" -c "GRANT UPDATE (fee_amount) ON public.fee_acceptances TO authenticated"; gsnap G5-before
psql -q -d "$GD" -A -f "$PFD/check1.sql" > "$GDD/G5-check1.out" 2>&1; grep -q 'fee_amount' "$GDD/G5-check1.out" && echo "G5 pre-flight check 1b lists the column-level grant: $(grep fee_amount "$GDD/G5-check1.out" | head -1)" || fail "G5: pre-flight check 1b does not show the column-level grant"
psql -q -d "$GD" -f "$D/gh3320_fee_acceptances_append_only.sql" > "$GDD/G5.out" 2>&1; echo "== G5 plain psql -f, column-level UPDATE by another grantor"; cat "$GDD/G5.out"; gsnap G5-after
grep -q 'authenticated:UPDATE (column-level)' "$GDD/G5.out" || fail "G5: the guard did not fire on a surviving column-level UPDATE"
diff "$GDD/G5-before.snap" "$GDD/G5-after.snap" >/dev/null && echo "G5 nothing committed" || fail "G5: the failed apply left committed changes"
psql -q -d postgres -c "DROP DATABASE $GD"

# W: wrapping the file. W1 clean file inside BEGIN ... ROLLBACK is COMMITTED (the inner COMMIT ends the outer transaction); W1b psql -1 with a later failing step is COMMITTED;
# W2 a firing guard inside the same wrapper commits nothing.
WD=wr_$DB; WDD="$OUT/wrap"; mkdir -p "$WDD"
wstate() { psql -q -At -d "$WD" -c "SELECT count(*) || '/' || has_table_privilege('authenticated','public.fee_acceptances','UPDATE') FROM pg_policies WHERE schemaname='public' AND tablename='fee_acceptances'"; }
newwd() { psql -q -d postgres -c "DROP DATABASE IF EXISTS $WD" -c "CREATE DATABASE $WD" || exit 2; psql -q -d "$WD" -v ON_ERROR_STOP=1 -f "$T/gh3320_throwaway_schema.sql" >/dev/null || exit 2; }
echo 'SELECT 1/0;' > "$WDD/fail.sql"
newwd; echo "W0 before: policies/authenticated_update = $(wstate)"
{ echo "BEGIN;"; cat "$D/gh3320_fee_acceptances_append_only.sql"; echo "ROLLBACK;"; } | psql -q -d "$WD" >/dev/null 2>&1; w1=$(wstate); echo "W1 BEGIN; file; ROLLBACK;  -> $w1 (3/false = COMMITTED despite the ROLLBACK)"; [ "$w1" = "3/false" ] || fail "W1: expected the wrapped file to commit, got $w1"
newwd; psql -q -d "$WD" -1 -f "$D/gh3320_fee_acceptances_append_only.sql" -f "$WDD/fail.sql" >/dev/null 2>&1; w1b=$(wstate); echo "W1b psql -1 -f file -f failing-step -> $w1b (3/false = COMMITTED although a later step failed)"; [ "$w1b" = "3/false" ] || fail "W1b: expected the psql -1 apply to commit, got $w1b"
newwd; psql -q -d "$WD" -c "GRANT UPDATE ON public.fee_acceptances TO PUBLIC"; w2a=$(wstate)
{ echo "BEGIN;"; cat "$D/gh3320_fee_acceptances_append_only.sql"; echo "ROLLBACK;"; } | psql -q -d "$WD" >/dev/null 2>&1; w2=$(wstate); echo "W2 firing guard inside BEGIN; file; ROLLBACK;  before=$w2a after=$w2"; [ "$w2" = "$w2a" ] || fail "W2: a firing guard inside a wrapper committed something ($w2a -> $w2)"
psql -q -d postgres -c "DROP DATABASE $WD"

# 4b: the per-role statement check must list the PostgREST shape (WITH pgrst_source AS (UPDATE ...)) and must not list itself (REVIEW FAIL 6644033286, finding 2).
S4=s4b_$DB; S4D="$OUT/4b"; mkdir -p "$S4D"
awk '/^```sql/{on=1;next} /^```/{on=0} on && /^-- 4b\./{g=1;print;next} on && /^-- 5\./{g=0} on&&g' "$RB/gh3320_fee_acceptances_append_only_pre-flight.md" > "$S4D/check4b.sql"
[ -s "$S4D/check4b.sql" ] || fail "pre-flight check 4b not found in the document"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $S4" -c "CREATE DATABASE $S4" || exit 2
psql -q -d "$S4" -v ON_ERROR_STOP=1 -f "$T/gh3320_throwaway_schema.sql" -f "$T/gh3320_planted_writers.sql" >/dev/null || exit 2
if psql -q -d "$S4" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION pg_stat_statements" -c "SELECT pg_stat_statements_reset()" >/dev/null 2>"$S4D/ext.err"; then
  psql -q -d "$S4" >/dev/null 2>&1 <<'SQL'
SET ROLE authenticated;
WITH pgrst_source AS (UPDATE public.fee_acceptances SET fee_text_displayed = 'x' WHERE id = 'eeeeeeee-4444-4000-8000-0000000000a1' RETURNING id) SELECT count(*) FROM pgrst_source;
RESET ROLE;
UPDATE public.fee_acceptances SET fee_pct = 5.00 WHERE false;
SET ROLE service_role;
DELETE FROM public.fee_acceptances WHERE false;
RESET ROLE;
SELECT count(*) FROM public.fee_acceptances;
SQL
  psql -d "$S4" -A -f "$S4D/check4b.sql" > "$S4D/check4b.out" 2> "$S4D/check4b.err"; echo "== 4b output"; cat "$S4D/check4b.out" "$S4D/check4b.err"
  [ -s "$S4D/check4b.err" ] && fail "pre-flight check 4b raised: $(head -1 "$S4D/check4b.err")"
  grep -q '^authenticated|.*pgrst_source' "$S4D/check4b.out" && echo "4B PostgREST-shaped UPDATE by authenticated listed: 1 of 1" || fail "4b missed the PostgREST-shaped UPDATE"
  grep -q '^postgres|.*UPDATE public.fee_acceptances' "$S4D/check4b.out" && echo "4B bare UPDATE by postgres listed: 1 of 1" || fail "4b missed the bare UPDATE"
  grep -q '^service_role|.*DELETE' "$S4D/check4b.out" && echo "4B DELETE by service_role listed: 1 of 1" || fail "4b missed the DELETE"
  grep -qi 'pg_stat_statements' "$S4D/check4b.out" && fail "4b lists its own statement"
  oldn=$(psql -q -At -d "$S4" -c "SELECT count(*) FROM pg_stat_statements s WHERE s.query ~* 'fee_accept' AND s.query ~* '^\s*(update|delete|truncate)'")
  echo "4B CONTROL the previous filter (^\\s*(update|delete|truncate)) finds $oldn of 3 of those statements"; [ "$oldn" -lt 3 ] || fail "4b control: the old filter was expected to miss the PostgREST shape"
else
  if [ "${GH3320_ALLOW_NO_PGSS:-}" = 1 ]; then echo "4B SKIPPED (pg_stat_statements not loaded; GH3320_ALLOW_NO_PGSS=1): $(head -1 "$S4D/ext.err")"; else fail "4b NOT EXERCISED: pg_stat_statements is not available on this server: $(head -1 "$S4D/ext.err")"; fi
fi
psql -q -d postgres -c "DROP DATABASE $S4"
echo "RUNNER rc=$rc"; exit $rc
