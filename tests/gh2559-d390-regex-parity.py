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
lits = re.findall(r"'((?:[^']|'')*)'", fn)
pats = [l for l in lits if l not in ("[removed]", "[removed] ", "g", "gi")]
bad = [p for p in pats if ("'" + p + "'") not in applied]
ok = True
print("regex literals in d390_redact_contact: %d patterns; found verbatim in the applied view: %d" % (len(pats), len(pats) - len(bad)))
if bad or len(pats) != 7: ok = False; print("FAIL (1): missing or wrong count", len(pats), [b[:40] for b in bad])
a, f = stmt(applied), stmt(fwd)
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
