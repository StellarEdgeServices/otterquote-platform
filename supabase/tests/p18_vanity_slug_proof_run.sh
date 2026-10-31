#!/usr/bin/env bash
# P18 (#3218): run the vanity-slug proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/p18_vanity_slug_proof_run.sh [outdir]
# Pass 1 TODAY (no migration: negative control), pass 2 AFTER (+ forward), pass 3 ROLLBACK (+ rollback; must equal pass 1).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; DB=p18_slug_proof; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/p18_vanity_slug_throwaway_schema.sql" >/dev/null
run() { # $1 label, $2 migration file or empty
  python3 - "$T/p18_vanity_slug_proof.sql" "${2:-}" > "$OUT/$1.sql" <<'PY'
import sys,re
proof=open(sys.argv[1]).read(); mig=open(sys.argv[2]).read() if sys.argv[2] else ""
mig=re.sub(r'(?m)^(BEGIN|COMMIT);\s*$','',mig)
print("BEGIN;"); print(proof.replace("-- @@MIGRATION@@",mig))
PY
  psql -q -At -d "$DB" -f "$OUT/$1.sql" > "$OUT/$1.txt" 2>&1 || true
  echo "== $1"; sed -n '/P18 PROOF/,$p;/ERROR/p' "$OUT/$1.txt" | head -80
}
run 1-TODAY ""
run 2-AFTER "$D/p18_vanity_slug_data.sql"
# rollback pass: apply forward for real, roll back for real, then run the proof alone
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/p18_vanity_slug_data.sql" >/dev/null
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/p18_vanity_slug_data_rollback.sql" >/dev/null
run 3-ROLLBACK ""
rc=0
# rollback gate: with a slug present the rollback must RAISE and change nothing; with the export flag it must run
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/p18_vanity_slug_data.sql" >/dev/null
psql -q -d "$DB" -c "SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',false); UPDATE referral_agents SET vanity_slug='gate-check' WHERE unique_code='JFY5GZOD'" >/dev/null
if psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/p18_vanity_slug_data_rollback.sql" >"$OUT/gate-refused.txt" 2>&1; then echo "EXPECT FAIL: rollback ran with a slug present and no export flag"; rc=1; else grep -q 'rollback refused' "$OUT/gate-refused.txt" && echo "ROLLBACK GATE refuses while a slug exists (nothing dropped)" || { echo "EXPECT FAIL: gate message"; rc=1; }; fi
[ "$(psql -At -d "$DB" -c "SELECT count(*) FROM referral_agents WHERE vanity_slug='gate-check'")" = 1 ] || { echo "EXPECT FAIL: gate dropped data"; rc=1; }
printf "SET oq.p18_rollback_confirm_export = 'export-taken';\n" | cat - "$D/p18_vanity_slug_data_rollback.sql" | psql -q -d "$DB" -v ON_ERROR_STOP=1 >/dev/null && echo "ROLLBACK GATE passes with the export flag" || { echo "EXPECT FAIL: rollback with flag"; rc=1; }
# forward re-runnable: apply twice
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/p18_vanity_slug_data.sql" >/dev/null && psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/p18_vanity_slug_data.sql" >/dev/null && echo "FORWARD re-runnable (applied twice)" || { echo "EXPECT FAIL: forward not re-runnable"; rc=1; }
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/p18_vanity_slug_data_rollback.sql" >/dev/null && echo "ROLLBACK runs clean after re-run" || { echo "EXPECT FAIL: rollback after rerun"; rc=1; }
for k in 'P1 A set_partner_slug.*OK' 'N1 admin.*REFUSED 22023' 'N2 partners.*REFUSED 22023' 'N3 Partners.*REFUSED 22023' 'N4 existing.*REFUSED 22023' 'N5 ab.*REFUSED 22023' 'N6 a--b.*REFUSED 22023' 'N7 direct UPDATE.*REFUSED 42501' 'N7b.*REFUSED 42501' 'N13 30 chars.*OK' 'N21.*REFUSED 42501' 'H2 B takes.*REFUSED 22023' 'B1.*REFUSED 23514' 'B2.*REFUSED 23505' 'R1 .*REFUSED 22023' 'R2 .*REFUSED 22023' 'R3 .*REFUSED 22023' 'R4 .*REFUSED 22023' 'R5 .*REFUSED 22023' 'R6 .*REFUSED 22023' \
  'R7 .*REFUSED 22023 [^|]*\| REFUSED 22023 [^|]*\| REFUSED 22023' 'R8 .*=> svc-set-2' \
  'W1a .*REFUSED 22023' 'W1 retired 91 days.*=> OK' 'W2 retired 10 days ago by A: B refused.*REFUSED 22023' 'W2 retired 10 days ago by A: A reclaims.*=> OK' \
  'W3 history rows.*=> 2 A,B' 'W3 newest row.*=> B' 'W3 A refused.*REFUSED 22023' 'W4 setting absent.*REFUSED 22023' 'W4 setting 30.*=> OK' \
  'W4 setting non-numeric.*REFUSED 22023' 'W4 setting 0.*REFUSED 22023' 'H3 history of A.*=> jane-doe,jane-d' 'S3 .*=> false,false' 'S4 .*=> 0'; do
  grep -Eq "$k" "$OUT/2-AFTER.txt" || { echo "EXPECT FAIL (after): $k"; rc=1; }; done
grep -q 'F0 vanity_slug column => absent' "$OUT/1-TODAY.txt" && grep -q 'NC negative control' "$OUT/1-TODAY.txt" || { echo "EXPECT FAIL: column must be absent today"; rc=1; }
diff <(grep ' => ' "$OUT/1-TODAY.txt") <(grep ' => ' "$OUT/3-ROLLBACK.txt") >/dev/null && echo "ROLLBACK matches TODAY" || { echo "ROLLBACK differs from TODAY"; rc=1; }
echo "EXIT=$rc"; exit $rc
