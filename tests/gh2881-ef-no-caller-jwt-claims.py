#!/usr/bin/env python3
"""gh-2881 static check: after supabase/migrations_drafts/gh2881_claims_private_text_column_grants.sql, a client built with the CALLER's Authorization header runs
as `authenticated` and cannot read the three private claims columns or `*`. This lists every supabase/functions/**/index.ts createClient(...) whose arguments carry an
Authorization header and fails if the client it creates is used for anything but `.auth` (the session check). Clients built with the service-role key keep full access.
Run: python3 tests/gh2881-ef-no-caller-jwt-claims.py"""
import os, re, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "supabase", "functions")
def match_paren(t, i):
    d = 0
    for k in range(i, len(t)):
        if t[k] == "(": d += 1
        elif t[k] == ")":
            d -= 1
            if d == 0: return k
    return len(t) - 1
n = 0; bad = []
for dp, dn, fn in os.walk(ROOT):
    if "index.ts" not in fn: continue
    f = os.path.join(dp, "index.ts"); t = open(f, errors="ignore").read(); rel = os.path.relpath(f, ROOT)
    for m in re.finditer(r"createClient\(", t):
        i = m.end() - 1; a = t[i:match_paren(t, i) + 1]
        if "Authorization" not in a: continue
        n += 1
        v = re.search(r"(\w+)\s*=\s*(?:await\s+)?$", t[max(0, m.start() - 60):m.start()])
        if not v: bad.append((rel, "inline caller-JWT client")); continue
        methods = sorted(set(re.findall(re.escape(v.group(1)) + r"\s*\.\s*(\w+)", t)))
        print("%-40s %-10s used for: %s" % (rel, v.group(1), methods))
        if methods != ["auth"]: bad.append((rel, methods))
print("caller-JWT clients:", n)
for b in bad: print("FAIL:", b)
print("EF_CALLER_JWT_CLAIMS:", "FAIL" if bad else "PASS (every caller-JWT client is used for .auth only)")
sys.exit(1 if bad else 0)
