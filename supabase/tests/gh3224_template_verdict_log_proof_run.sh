#!/usr/bin/env bash
# gh-3224: run the template verdict log proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3224_template_verdict_log_proof_run.sh [--mutations] [outdir]
# The connecting role must be a superuser (the scratch setup creates roles and sets service_role BYPASSRLS).
# Phases in one fresh database (scratch setup mirrors production's default ACLs and service_role BYPASSRLS):
#   0-SNAPSHOT (catalog before forward) -> 1-AFTER (forward applied: PROOF-OK) -> 2-IDEMPOTENT (forward re-applied: PROOF-OK)
#   -> 3-ROLLBACK (rollback applied: catalog identical to 0-SNAPSHOT) -> 4-REAPPLIED (forward again: PROOF-OK).
# --mutations: each mutant below is the forward file with one deliberate defect, applied to its own fresh
# database; every mutant must apply cleanly and then FAIL the proof (PROOF-FAIL). A surviving mutant fails the run.
set -uo pipefail
cd "$(dirname "$0")/../.."
MUT=0
if [ "${1:-}" = "--mutations" ]; then MUT=1; shift; fi
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
FWD="$D/gh3224_template_verdict_log.sql"; RBK="$D/gh3224_template_verdict_log_rollback.sql"
SETUP="$T/gh3224_template_verdict_log_scratch_setup.sql"; PROOF="$T/gh3224_template_verdict_log_proof.sql"
DB=gh3224_proof; rc=0
NCHECKS=45   # rows the proof records; anything else (fewer rows, or a batch that errored) is not a pass
fail() { echo "EXPECT FAIL: $*"; rc=1; }

fresh() {  # fresh <db>
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null || exit 2
}
proof() {  # proof <db> <label>  -> writes $OUT/<label>.txt ; the report arrives as the forced exception text.
  # --single-transaction: the forced RAISE at the end rolls back the fixtures, so every phase starts clean.
  psql -q -At -1 -d "$1" -f "$PROOF" > "$OUT/$2.txt" 2>&1
  echo "== $2"; grep -E 'PROOF-(OK|FAIL)|^FAIL ' "$OUT/$2.txt" | sed 's/^psql:[^ ]* //'
}
passed() { grep -q "PROOF-OK all $NCHECKS checks passed" "$1"; }
snapshot() {  # catalog fingerprint of everything this set could touch
  psql -q -At -d "$1" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'rel|' || c.relname || '|' || c.relkind::text || '|' || coalesce(c.relacl::text, '') || '|' || c.relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY 1;
SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, '')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1;
SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || md5(pg_get_triggerdef(oid)) FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1;
SELECT 'pol|' || tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') FROM pg_policies ORDER BY 1;
SELECT 'row|' || id || '|' || status FROM public.contractor_templates ORDER BY 1;
SQL
}

fresh "$DB"
snapshot "$DB" > "$OUT/0-SNAPSHOT.txt" || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null || fail "forward failed"
proof "$DB" 1-AFTER
passed "$OUT/1-AFTER.txt" || fail "AFTER must be PROOF-OK"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null || fail "forward not idempotent"
proof "$DB" 2-IDEMPOTENT
passed "$OUT/2-IDEMPOTENT.txt" || fail "re-applied forward must be PROOF-OK (no duplicate backfill rows)"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RBK" >/dev/null || fail "rollback failed"
snapshot "$DB" > "$OUT/3-ROLLBACK.txt" || fail "snapshot after rollback failed"
if diff "$OUT/0-SNAPSHOT.txt" "$OUT/3-ROLLBACK.txt" > "$OUT/3-ROLLBACK.diff"; then
  echo "== 3-ROLLBACK catalog identical to 0-SNAPSHOT ($(wc -l < "$OUT/0-SNAPSHOT.txt") lines)"
else
  cat "$OUT/3-ROLLBACK.diff"; fail "ROLLBACK catalog differs from the pre-forward snapshot"
fi
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null || fail "forward after rollback failed"
proof "$DB" 4-REAPPLIED
passed "$OUT/4-REAPPLIED.txt" || fail "REAPPLIED must be PROOF-OK"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null

if [ "$MUT" = 1 ]; then
  # name|python expression on s (the forward file) that returns the mutated text; every needle must occur.
  MUTANTS=(
    "no-slot-branch|need(s, 'ON v.contractor_id = t.contractor_id AND v.trade = t.trade AND v.funding_type = t.funding_type', 'ON false')"
    "no-row-id-branch|need(s, 'WHERE v.template_id = p_template_id', 'WHERE false')"
    "asc-ordering|need(s, 'ORDER BY v.recorded_at DESC, v.id DESC LIMIT 1', 'ORDER BY v.recorded_at ASC, v.id ASC LIMIT 1')"
    "reader-granted-to-authenticated|need(s, 'template_admin_verdict_blocks_auto_validation(uuid) TO service_role;', 'template_admin_verdict_blocks_auto_validation(uuid) TO service_role, authenticated;')"
    "log-granted-to-authenticated|need(s, 'GRANT SELECT ON public.contractor_template_verdicts TO service_role;', 'GRANT SELECT ON public.contractor_template_verdicts TO service_role, authenticated;')"
    "no-backfill|need(s, \"WHERE t.status IN ('rejected', 'admin_validated')\", 'WHERE false')"
    "service-role-keeps-default-grants|need(s, 'FROM PUBLIC, anon, authenticated, service_role;', 'FROM PUBLIC, anon, authenticated;')"
    "no-append-only-trigger|need(s, 'CREATE TRIGGER trg_ctv_append_only\n  BEFORE UPDATE OR DELETE ON public.contractor_template_verdicts\n  FOR EACH ROW EXECUTE FUNCTION public.contractor_template_verdicts_append_only();', '')"
    "no-truncate-trigger|need(s, 'CREATE TRIGGER trg_ctv_no_truncate\n  BEFORE TRUNCATE ON public.contractor_template_verdicts\n  FOR EACH STATEMENT EXECUTE FUNCTION public.contractor_template_verdicts_append_only();', '')"
    "log-trigger-update-only|need(s, 'AFTER INSERT OR UPDATE OF status ON public.contractor_templates', 'AFTER UPDATE OF status ON public.contractor_templates')"
    "append-only-fn-execute-left-open|need(s, 'REVOKE ALL ON FUNCTION public.contractor_template_verdicts_append_only() FROM PUBLIC, anon, authenticated;', '')"
    "writer-not-security-definer|need(s, 'RETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER', 'RETURNS trigger\nLANGUAGE plpgsql\nSECURITY INVOKER')"
  )
  killed=0; total=0
  for m in "${MUTANTS[@]}"; do
    name="${m%%|*}"; expr="${m#*|}"; total=$((total + 1))
    mf="$OUT/mutant-$name.sql"
    python3 -I -c "
import sys
def need(s, old, new):
    if old not in s: sys.exit('needle not found: ' + old)
    return s.replace(old, new)
s = open(sys.argv[1]).read()
open(sys.argv[2], 'w').write($expr)
" "$FWD" "$mf" || { fail "mutant $name: did not apply to the forward file"; continue; }
    MDB="gh3224_mut_$(echo "$name" | tr '-' '_')"
    fresh "$MDB"
    if ! psql -q -d "$MDB" -v ON_ERROR_STOP=1 -f "$mf" > "$OUT/mutant-$name.apply" 2>&1; then
      fail "mutant $name: the mutated forward file did not apply (a mutant must be a valid migration)"; continue
    fi
    psql -q -At -1 -d "$MDB" -f "$PROOF" > "$OUT/mutant-$name.txt" 2>&1
    if grep -q 'PROOF-FAIL' "$OUT/mutant-$name.txt"; then
      killed=$((killed + 1)); echo "== mutant $name: KILLED ($(grep -c '^FAIL ' "$OUT/mutant-$name.txt") check(s) failed: $(grep '^FAIL ' "$OUT/mutant-$name.txt" | cut -c6- | cut -d' ' -f1 | sort -u | tr '\n' ' '))"
    elif ! passed "$OUT/mutant-$name.txt"; then
      # the proof batch itself errored (e.g. an admin's verdict write was refused), so no report was produced
      killed=$((killed + 1)); echo "== mutant $name: KILLED (proof errored: $(grep -m1 'ERROR:' "$OUT/mutant-$name.txt" | sed 's/^psql:[^ ]* //'))"
    else
      fail "mutant $name SURVIVED the proof"
    fi
    psql -q -d postgres -c "DROP DATABASE IF EXISTS $MDB" >/dev/null
  done
  echo "MUTANTS killed=$killed of $total"
  [ "$killed" = "$total" ] || fail "not every mutant was killed"
fi
echo "RUNNER rc=$rc (outputs in $OUT)"; exit $rc
