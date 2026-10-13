#!/usr/bin/env python3
"""gh-2559 / PR #2578: build the production proof of the bidder view's free-text handling, as ONE SQL statement.

The statement is a single DO block that ends in a deliberate RAISE EXCEPTION, so every write (the view
created from the two files, the contractor flipped to real, the claim and profile rows changed to the plants)
rolls back whatever the client does; the exception text is the report. Nothing is applied. The plants are the
synthetic lists of tools/gh2559-bidder-view-behaviour.py (one source of truth); no homeowner value is read
into the report: the report holds plant labels, ok / LEAK, and counts.

Usage:  python3 tools/gh2559-freetext-prod-proof-build.py OLD_VIEW.sql NEW_VIEW.sql > proof.sql
        then run proof.sql once through the SQL runner (SELECT-equivalent; rolls itself back).
"""
import importlib.util, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bv", os.path.join(here, "gh2559-bidder-view-behaviour.py"))
bv = importlib.util.module_from_spec(spec); spec.loader.exec_module(bv)

def q(x): 
    assert "$q$" not in x
    return "$q$" + x + "$q$"
def body(path):
    t = re.sub(r"^\s*(BEGIN|COMMIT);\s*$", "", open(path).read(), flags=re.M)
    assert "$vv$" not in t
    return "$vv$" + t + "$vv$"

plants = []   # (kind, label, owner name, address, prop_city, prop_zip, text, bad[], expected)
for lab, a, pc, pz, ec, ez in bv.ADDRESSES:
    plants.append(("addr", lab, bv.NAME, a, pc, pz, "", [], (ec, ez, lab in bv.KNOWN_LIMIT)))
for lab, text, bad in bv.NOTES:
    plants.append(("note", lab, bv.NAME, bv.STREET + ", Carmel, IN 46032", None, None, text, bad, None))
for lab, text, bad in bv.REVIEW_NOTES:
    plants.append(("note", lab, bv.R_NAME, bv.R_ADDR, None, None, text, bad, lab in bv.REVIEW_RESIDUALS))
for items, nm, ad in ((bv.NUMBERED + bv.NAMES + bv.EMAILS, bv.N_NAME, bv.N_ADDR), (bv.ACCENT, bv.A_NAME, bv.A_ADDR), (bv.SHORT, bv.S_NAME, bv.S_ADDR)):
    for lab, text, bad in items:
        plants.append(("note", lab, nm, ad, None, None, text, bad, False))
benign = []
DATE_LOSS = ("Insurance approved 2026-09-14; adjuster visit done", "Hail on 6-12-2026 about 1.75 inch")   # stated cost: a date reads as a phone number
for text in bv.REVIEW_BENIGN + bv.MORE_BENIGN + bv.N_BENIGN:
    benign.append(("benign", "benign: " + text[:40], bv.N_NAME, bv.N_ADDR, None, None, text, [], text in DATE_LOSS))

rows = []
for k, lab, nm, ad, pc, pz, text, bad, ex in plants + benign:
    if k == "addr": e = (q(ex[0]) if ex[0] else "NULL", q(ex[1]) if ex[1] else "NULL", "true" if ex[2] else "false")
    elif k == "note": e = ("NULL", "NULL", "true" if ex else "false")
    else: e = ("NULL", "NULL", "true" if ex else "false")
    rows.append("(%s,%s,%s,%s,%s,%s,%s,ARRAY[%s]::text[],%s,%s,%s)" % (q(k), q(lab), q(nm), q(ad) if ad else "NULL", q(pc) if pc else "NULL", q(pz) if pz else "NULL", q(text),
                ",".join(q(b) for b in bad) if bad else "", e[0], e[1], e[2]))
sql = open(os.path.join(here, "gh2559-freetext-prod-proof.tpl.sql")).read()
sql = sql.replace("@OLD@", body(sys.argv[1])).replace("@NEW@", body(sys.argv[2])).replace("@PLANTS@", ",\n    ".join(rows))
sys.stdout.write(sql)
