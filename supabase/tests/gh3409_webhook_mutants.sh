#!/usr/bin/env bash
# gh-3409 (REVIEW 6669923343 B2): break each link of the webhook's fee-acceptance chain in a COPY of supabase/functions/stripe-webhook and require the Deno tests to fail.
# Usage: bash supabase/tests/gh3409_webhook_mutants.sh   (needs deno, python3; run from the repo root). The real files are never touched.
set -u
SRC=supabase/functions/stripe-webhook; W=$(mktemp -d); rc=0
cp -r supabase/functions "$W/functions"
( cd "$W/functions/stripe-webhook" && deno test -A >/dev/null 2>&1 ) || { echo "BASELINE FAILS: the unmodified copy does not pass"; exit 2; }
echo "baseline: passes"
python3 - "$W/functions/stripe-webhook" "$W/mut.list" <<'PY'
import sys,os
d=sys.argv[1]
M=[
 ("M1 dispute handler drops the picked row (feeAcceptance = null)","dispute-fee-evidence.ts","        feeAcceptance = picked.row;","        feeAcceptance = null;"),
 ("M2 payment-intent quote read drops fee_amount","index.ts",'.select("id, claim_id, contractor_id, payment_intent_id, fee_amount")','.select("id, claim_id, contractor_id, payment_intent_id")'),
 ("M3 the reason is not kept (task loses it)","dispute-fee-evidence.ts","        feeAcceptanceMissingReason = picked.reason;","        feeAcceptanceMissingReason = null;"),
 ("M4 the reason is not passed to buildEvidencePayload (Stripe draft loses it)","dispute-fee-evidence.ts","evidencePayload: buildEvidencePayload({ dispute, claim, feeAcceptance, feeAcceptanceMissingReason }),","evidencePayload: buildEvidencePayload({ dispute, claim, feeAcceptance }),"),
 ("M5 picker takes the oldest matching row for the bid","fee-acceptance-select.ts","  const row = own.find(","  const row = [...own].reverse().find("),
 ("M6 the read sorts oldest first","fee-acceptance-select.ts",'.order("created_at", { ascending: false })\n    // gh-3490: was 5,','.order("created_at", { ascending: true })\n    // gh-3490: was 5,'),
 ("M7 fee comparison widened from half a cent to a dollar","fee-acceptance-select.ts","Math.abs(rowFee - bidFee) < 0.005","Math.abs(rowFee - bidFee) < 1"),
 ("M8 rescinded rows allowed","fee-acceptance-select.ts",'    .is("rescinded_at", null)\n',''),
 ("M9 the read no longer filters on the selected bid_id",'fee-acceptance-select.ts','    .eq("bid_id", selectedBid.id)\n',''),
 ("M10 index.ts gives the task an empty fee block","index.ts","taskFeeInfo: feeEvidence.taskFeeInfo,","taskFeeInfo: \"\","),
 ("M11 index.ts marks the acceptance resolved when it is not","index.ts","feeAcceptanceResolved: feeAcceptance !== null,","feeAcceptanceResolved: true,"),
 ("M12 index.ts sends Stripe a payload that ignores the assembler","index.ts","const evidencePayload = feeEvidence.evidencePayload;","const evidencePayload: Record<string, string> = {};"),
 ("M13 Stripe text names the quarantine table","fee-acceptance-select.ts",'    : "Not found in database — manual lookup required.";','    : "Not found in database — manual lookup required (see fee_acceptance_quarantine).";'),
 ("M14 the dip row is accepted when the bid fee is missing (null compares as 0)","fee-acceptance-select.ts","Number.isFinite(rowFee) && Number.isFinite(bidFee) &&","Number.isFinite(rowFee) &&"),
]
with open(sys.argv[2],"w") as out:
    for i,(name,f,a,b) in enumerate(M):
        s=open(os.path.join(d,f)).read()
        assert s.count(a)==1,(name,s.count(a))
        open(os.path.join(d,f"{f}.m{i}"),"w").write(s.replace(a,b)); out.write(f"{i}\t{f}\t{name}\n")
PY
[ $? = 0 ] || { echo "mutant generation failed"; exit 3; }
killed=0; total=0
while IFS=$'\t' read -r i f name; do
  total=$((total+1)); cp "$W/functions/stripe-webhook/$f" "$W/orig.$f"; cp "$W/functions/stripe-webhook/$f.m$i" "$W/functions/stripe-webhook/$f"
  out=$( cd "$W/functions/stripe-webhook" && deno test -A 2>&1 ); n=$(printf '%s\n' "$out" | grep -c "FAILED\|error: Test failed")
  if [ "$n" -gt 0 ]; then killed=$((killed+1)); echo "KILLED  $name: $(printf '%s\n' "$out" | grep -m1 -o '[0-9]* failed')"; else echo "SURVIVED $name"; rc=1; fi
  cp "$W/orig.$f" "$W/functions/stripe-webhook/$f"
done < "$W/mut.list"
echo "WEBHOOK MUTANTS killed: $killed of $total"; rm -rf "$W"; exit $rc
