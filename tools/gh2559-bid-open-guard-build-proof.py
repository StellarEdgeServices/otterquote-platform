#!/usr/bin/env python3
"""Regenerates supabase/tests/gh2559_claims_bid_open_guard_proof.sql from the forward and rollback drafts (embeds their bodies
byte-for-byte between $fwd$ / $rb$ markers). Run after any change to either draft; tests/gh2559-bid-open-guard.mjs checks the embed."""
import os, re
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
D = os.path.join(R, "supabase", "migrations_drafts")
fwd = open(os.path.join(D, "gh2559_claims_bid_open_guard.sql")).read()
rb = open(os.path.join(D, "gh2559_claims_bid_open_guard_rollback.sql")).read()
def body(t, start):
    i = t.index(start); j = t.rindex("COMMIT;")
    b = t[i:j]
    b = re.sub(r"COMMENT ON FUNCTION public\.claims_guard_bid_open\(\) IS\n  '[^;]*;\n\n", "", b)
    return b.strip("\n") + "\n"
FWD = body(fwd, "-- Schema: parse status column")
RB = body(rb, "DROP TRIGGER IF EXISTS claims_guard_bid_open")
tpl = open(os.path.join(R, "tools", "gh2559-bid-open-guard-proof.tpl.sql")).read()
out = tpl.replace("@@FWD@@", FWD).replace("@@RB@@", RB)
open(os.path.join(R, "supabase", "tests", "gh2559_claims_bid_open_guard_proof.sql"), "w").write(out)
print("wrote proof", len(out))
