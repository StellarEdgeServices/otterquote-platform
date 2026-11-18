#!/usr/bin/env bash
# gh-2988 proof runner. LOCAL throwaway Postgres 16 in a temp dir. Never touches production; no network.
# usage: supabase/tests/gh2988_mask_proof_run.sh   (needs PG16 binaries, default /usr/lib/postgresql/16/bin, and a user that may run initdb, default postgres)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); SQL=$(cd "$HERE/.." && pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; AS=${PGRUN_AS:-postgres}; PORT=${PGPORT_LOCAL:-54988}
FWD="$SQL/migrations_drafts/gh2988_bidder_summary_mask_unparsed_figures.sql"
RB="$SQL/migrations_drafts/gh2988_bidder_summary_mask_unparsed_figures_rollback.sql"
SRC="$SQL/migrations/20261020162602_gh2559_d390_redact_contact_until_fee.sql"   # holds the live function and view text (md5 2e2eef13fe2bce2f68b0970c5e7f7c67)
D=$(mktemp -d /tmp/gh2988pg.XXXXXX); chown "$AS" "$D"; chmod 755 "$D"
TMP=$(mktemp -d /tmp/gh2988src.XXXXXX); chmod 755 "$TMP"
as() { runuser -u "$AS" -- "$@"; }
as "$PGBIN/initdb" -D "$D/data" -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
as "$PGBIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" -w start >/dev/null
trap 'as "$PGBIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$D" "$TMP"' EXIT
P="$PGBIN/psql -X -q -v ON_ERROR_STOP=1 -h $D -p $PORT -U $AS -d postgres"
# current function and view text, cut from the filed migration by marker lines (function: CREATE OR REPLACE FUNCTION public.d390_redact_contact ... $fn$;  view: CREATE OR REPLACE VIEW public.bidder_claim_summary ... ct.id);)
awk '/^CREATE OR REPLACE FUNCTION public.d390_redact_contact/{f=1} f{print} /^\$fn\$;/{if(f){exit}}' "$SRC" > "$TMP/fn.sql"
awk '/^CREATE OR REPLACE VIEW public.bidder_claim_summary/{v=1} v{print} v&&/q.contractor_id = ct.id\);$/{exit}' "$SRC" > "$TMP/view.sql"
chmod 644 "$TMP"/*.sql
$P -f "$HERE/gh2988_mask_proof_scratch_schema.sql"
$P -f "$TMP/fn.sql"; $P -f "$TMP/view.sql"
$P -c "GRANT SELECT ON public.bidder_claim_summary TO authenticated; COMMENT ON VIEW public.bidder_claim_summary IS 'scratch comment'"
ORIG=$($P -At -c "select md5(pg_get_viewdef('public.bidder_claim_summary'::regclass,true))||' '||length(pg_get_viewdef('public.bidder_claim_summary'::regclass,true))")
echo "== scratch view before: md5/length = $ORIG (production 2026-11-15: 2e2eef13fe2bce2f68b0970c5e7f7c67 18861)"
echo "== main proof"
$P -v fwd="$FWD" -v rb="$RB" -f "$HERE/gh2988_mask_proof.sql" 2>&1 | grep -v -E '^(BEGIN|COMMIT|SET|DO|CREATE TABLE|CREATE FUNCTION|DROP TABLE|SELECT [0-9]+|INSERT [0-9]+ [0-9]+|UPDATE [0-9]+|GRANT|CREATE VIEW)$|^psql:.*NOTICE' || true
# refusal tests (the scratch view is back at the ORIGINAL after the rollback)
echo "== drift guards"
chk() { # name expect-file-and-code
  local name=$1 file=$2 out; out=$($P -f "$file" 2>&1 || true)
  if echo "$out" | grep -q 'P0A88\|is not the expected definition'; then echo "PASS  $name | refused: $(echo "$out" | grep -o 'is not the expected definition[^;]*' | head -1)"; else echo "FAIL  $name | did not refuse: $out"; fi
}
chk "G2 rollback file refuses on the original (un-masked) view" "$RB"
$P -f "$FWD" >/dev/null 2>&1 && echo "PASS  G3 forward file applies to the original view (second run)" || echo "FAIL  G3 forward file did not apply"
chk "G4 forward file refuses when run twice (view already masked)" "$FWD"
echo "== done"
