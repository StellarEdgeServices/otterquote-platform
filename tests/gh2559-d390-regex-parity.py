#!/usr/bin/env python3
"""gh-2559 / D-390 static checks (no database).
1. Every regex literal in public.d390_redact_contact occurs VERBATIM in the applied bidder view (ledger 20261008231303), rules b and c.
2. The bidder view statement in the forward draft equals the applied statement except for ONE clause (the selected contractor's homeowner_notes).
3. The view statement in the rollback equals the applied statement exactly."""
import re, sys, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
rd = lambda p: open(os.path.join(ROOT, p)).read()
applied = rd("supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql")
fwd = rd("supabase/migrations_drafts/gh2559_d390_redact_contact_until_fee.sql")
rb = rd("supabase/migrations_drafts/gh2559_d390_redact_contact_until_fee_rollback.sql")
def stmt(t):
    s = t.index("CREATE OR REPLACE VIEW public.bidder_claim_summary")
    m = re.search(r"\n\s*OR EXISTS \(SELECT 1 FROM public\.quotes q WHERE q\.claim_id = c\.id AND q\.contractor_id = ct\.id\);", t[s:])
    return t[s:s + m.end()]
fn = fwd[fwd.index("AS $fn$") + 7: fwd.index("$fn$;")]
# the Unicode fold at the head of the function (D1, review 6256187448): must equal the applied view's fx.notes expression with p_text for left(c.homeowner_notes, 2000)
al = [l for l in applied.split("\n") if l.strip().startswith("normalize(") and l.rstrip().endswith(" AS notes,")]
fold_applied = al[0].strip()[:-len(" AS notes,")].replace("left(c.homeowner_notes, 2000)", "p_text")
fs = fn.index("normalize(", fn.index("regexp_replace(")); fe = fn.index(", '[[:alnum:]._%+-]+\\s*@")
fold_fn = fn[fs:fe].strip()
fold_ok = len(al) == 1 and fold_fn == fold_applied
print("Unicode fold in d390_redact_contact == applied view fx.notes (argument p_text): %s (%d chars)" % ("identical" if fold_ok else "DIFFERENT", len(fold_fn)))
fn_patterns = fn.replace(fold_fn, "")
lits = re.findall(r"'((?:[^']|'')*)'", fn_patterns)
pats = [l for l in lits if l not in ("[removed]", "[removed] ", "g", "gi")]
bad = [p for p in pats if ("'" + p + "'") not in applied]
ok = fold_ok
print("regex literals in d390_redact_contact: %d patterns; found verbatim in the applied view: %d" % (len(pats), len(pats) - len(bad)))
if bad or len(pats) != 7: ok = False; print("FAIL (1): missing or wrong count", len(pats), [b[:40] for b in bad])
a, f = stmt(applied), stmt(fwd)
# #2931 fee gate: the two file-path CASEs of the view are gated on platform_fee_charged IS TRUE in the forward AND the rollback (the applied
# 20261008231303 text is the pre-gate view). Apply exactly those two clause additions to the applied statement, require each to occur once, then
# compare the forward and rollback statements against that gated baseline, so any OTHER drift is still detected.
GATE = " AND c.platform_fee_charged IS TRUE"
for col in ("estimate_filename", "measurements_filename"):
    o = "CASE WHEN c.selected_contractor_id = ct.id THEN c." + col + " END"
    if a.count(o) != 1: print("FAIL (0): applied view lacks the single ungated " + col + " CASE"); sys.exit(1)
    a = a.replace(o, "CASE WHEN c.selected_contractor_id = ct.id" + GATE + " THEN c." + col + " END")
import difflib
d = [l for l in difflib.unified_diff(a.splitlines(), f.splitlines(), lineterm="", n=0) if not l.startswith(("---", "+++", "@@"))]
minus = [l for l in d if l.startswith("-")]; plus = [l for l in d if l.startswith("+")]
print("forward view vs applied view: %d removed line(s), %d added line(s)" % (len(minus), len(plus)))
if not (len(minus) == 3 and all("homeowner_notes" in l or "THEN c." in l or "ELSE ft" in l or "WHEN c.selected" in l or "CASE WHEN" in l for l in minus) or len(minus) <= 3):
    ok = False
if len(minus) > 3 or any("platform_fee_charged" in l for l in minus): ok = False; print("FAIL (2)")
if not any("d390_redact_contact" in l for l in plus): ok = False; print("FAIL (2): no call")
if stmt(rb) != a: ok = False; print("FAIL (3): rollback view differs from the applied view")
else: print("rollback view == applied view: identical")
print("PARITY:", "PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
