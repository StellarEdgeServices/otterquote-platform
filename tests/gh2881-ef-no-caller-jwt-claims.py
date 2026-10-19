#!/usr/bin/env python3
"""gh-2881 static guard. After supabase/migrations_drafts/gh2881_claims_private_text_column_grants.sql, a Supabase client that runs with the CALLER's JWT is the
`authenticated` role and cannot read the three private claims columns or `*`. Clients built with the service-role key keep full access.

This scans EVERY non-test .ts file under supabase/functions (index.ts files and helpers) for createClient(...) calls and classifies each one:
  caller client  = an Authorization header (any case) in its options whose value is not a service-role secret, OR a key argument that does not resolve to a
                   service-role env/secret (an anon key, a token variable, an unresolvable parameter: anything unknown counts as caller, the conservative side);
  service client = the key resolves to SUPABASE_SERVICE_ROLE_KEY / getServiceRoleKey() / a variable defined from one, with no caller Authorization header.
A caller client may be used for `.auth` only. The variable may have ANY name; aliases (`x = client`) are followed; a client passed as an argument to a function
defined in the scanned tree is followed up to 3 levels into that function's matching parameter; passing it to anything unresolvable, returning it, or
calling anything other than `.auth` on it fails. Mutation fixtures (below) must FAIL the scanner, so a green run is not a tautology.
Run: python3 tests/gh2881-ef-no-caller-jwt-claims.py"""
import os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "supabase", "functions")
SERVICE = re.compile(r"SERVICE_ROLE|service_?role|getServiceRoleKey|serviceKey", re.I)


def match_close(t, i):
    """index of the bracket closing t[i] (one of ( { [), skipping strings and template literals"""
    pairs = {"(": ")", "{": "}", "[": "]"}
    stack = [pairs[t[i]]]; k = i + 1
    while k < len(t) and stack:
        c = t[k]
        if c in "'\"`":
            q = c; k += 1
            while k < len(t) and t[k] != q:
                if t[k] == "\\": k += 1
                elif q == "`" and t[k] == "$" and k + 1 < len(t) and t[k + 1] == "{":
                    k = match_close(t, k + 1)
                k += 1
        elif c in pairs: stack.append(pairs[c])
        elif c == stack[-1]: stack.pop()
        k += 1
    return k - 1


def split_args(a):
    """top-level comma split of the text between the parens of a call"""
    out = []; cur = ""; k = 0
    while k < len(a):
        c = a[k]
        if c in "'\"`":
            q = c; j = k + 1
            while j < len(a) and a[j] != q:
                j += 2 if a[j] == "\\" else 1
            cur += a[k:j + 1]; k = j + 1; continue
        if c in "({[":
            j = match_close(a, k); cur += a[k:j + 1]; k = j + 1; continue
        if c == ",": out.append(cur.strip()); cur = ""; k += 1; continue
        cur += c; k += 1
    if cur.strip(): out.append(cur.strip())
    return out


def resolve_service(expr, text, depth=0):
    if SERVICE.search(expr): return True
    m = re.fullmatch(r"[A-Za-z_$][\w$]*", expr.strip())
    if m and depth < 3:
        d = re.search(r"(?:const|let|var)\s+" + re.escape(expr.strip()) + r"\s*(?::[^=]+)?=\s*([^;\n]+)", text)
        if d: return resolve_service(d.group(1), text, depth + 1)
    return False


def classify(args_text, text):
    args = split_args(args_text)
    opts = args[2] if len(args) > 2 else ""
    key = args[1] if len(args) > 1 else ""
    hdr = re.search(r"authorization['\"]?\s*:\s*([^,}\n]+)", opts, re.I)
    if hdr and not SERVICE.search(hdr.group(1)): return "caller"
    if not key: return "caller"
    if hdr: return "service" if SERVICE.search(hdr.group(1)) else "caller"
    # key: `a || b` or ternary: every alternative must be service-role for the client to count as service
    alts = [x for x in re.split(r"\|\||\?\?|\?|:", key) if x.strip() and not re.fullmatch(r"\s*(\"\"|''|``)\s*", x)]
    return "service" if alts and all(resolve_service(x, text) for x in alts) else "caller"


def func_defs(text):
    """name -> (param list, body text) for `function f(a, b) {..}` and `const f = (a, b) => {..}` / `async` variants"""
    defs = {}
    for m in re.finditer(r"(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", text):
        i = m.end() - 1; j = match_close(text, i)
        b = text.find("{", j); defs[m.group(1)] = (split_args(text[i + 1:j]), text[b:match_close(text, b) + 1] if b != -1 else "")
    for m in re.finditer(r"(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(", text):
        i = m.end() - 1; j = match_close(text, i)
        b = text.find("=>", j)
        if b == -1: continue
        s = text.find("{", b)
        defs[m.group(1)] = (split_args(text[i + 1:j]), text[s:match_close(text, s) + 1] if s != -1 else "")
    return defs


def check_uses(var, scope, defs, depth, where):
    """problems for a caller client held in `var`, looking at `scope` text"""
    probs = []
    names = {var}
    for a in re.finditer(r"([A-Za-z_$][\w$]*)\s*=\s*" + re.escape(var) + r"\b(?!\s*[.(\w])", scope): names.add(a.group(1))
    for n in names:
        for m in re.finditer(r"(?<![\w$.])" + re.escape(n) + r"\b(\s*\.\s*(\w+)|)", scope):
            if m.group(2):
                if m.group(2) != "auth": probs.append("%s: %s.%s" % (where, n, m.group(2)))
                continue
            before = scope[max(0, m.start() - 30):m.start()]
            after = scope[m.end():m.end() + 3]
            if re.search(r"(?:const|let|var)\s*$", before) or re.match(r"\s*=[^=]", after):  # its own declaration / assignment
                continue
            # passed as an argument?
            call = re.search(r"([A-Za-z_$][\w$]*)\s*\(([^()]*)$", scope[max(0, m.start() - 200):m.end()])
            if call and call.group(1) in defs and depth < 3:
                params, body = defs[call.group(1)]
                args = split_args(call.group(2) + scope[m.end():m.end()])
                idx = next((k for k, x in enumerate(args) if re.fullmatch(re.escape(n) + r"\s*", x.strip()) or x.strip() == n), None)
                if idx is None: idx = len(args) - 1
                if idx < len(params):
                    p = re.match(r"[A-Za-z_$][\w$]*", params[idx].lstrip("{ ") or "")
                    if p:
                        probs += check_uses(p.group(0), body, defs, depth + 1, where + " -> " + call.group(1) + "()")
                        continue
            probs.append("%s: %s passed to something this check cannot follow, returned, or stored" % (where, n))
    return probs


def scan_text(text, label, extra_defs=None):
    """returns (caller client count, problems)"""
    defs = func_defs(text)
    if extra_defs: defs = {**extra_defs, **defs}
    n = 0; probs = []
    for m in re.finditer(r"createClient\(", text):
        pre = text[max(0, m.start() - 12):m.start()]
        if re.search(r"(import|function|typeof)\s*$", pre) or text[max(0, m.start() - 1):m.start()] in ("{", ","):
            continue
        i = m.end() - 1; j = match_close(text, i)
        if classify(text[i + 1:j], text) != "caller": continue
        n += 1
        line = text.count("\n", 0, m.start()) + 1
        stmt = text[:m.start()]; stmt = stmt[stmt.rfind(";") + 1:]
        v = re.search(r"(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=(?!=)[^;]*$", stmt)
        if not v:
            tail = text[j + 1:j + 12]
            if re.match(r"\s*\.\s*auth\b", tail): continue
            probs.append("%s:%d: caller client with no variable (returned or chained): cannot be shown to be auth-only" % (label, line)); continue
        probs += check_uses(v.group(1), text[j + 1:], defs, 0, "%s:%d %s" % (label, line, v.group(1)))
    return n, probs


# ---- mutation fixtures: each of these MUST be reported as a problem, and the clean ones must not ----
ANON = 'const URL = "x";\n'
MUT = {
    "caller token as key, any name, reads claims": ANON + 'const sbCaller = createClient(URL, callerToken);\nawait sbCaller.from("claims").select("*");',
    "lower-case authorization header, reads claims": ANON + 'const db = createClient(URL, ANON_KEY, { global: { headers: { authorization: h } } });\nawait db.from("claims").select("id");',
    "mixed-case Authorization via anon key, reads a table": ANON + 'const weird_name9 = createClient(URL, Deno.env.get("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: authHeader } } });\nawait weird_name9.rpc("x");',
    "client passed to a helper that reads claims": 'const c = createClient(URL, tok);\nawait loadClaim(c);\nasync function loadClaim(db) { return await db.from("claims").select("*"); }',
    "client passed to an arrow helper that reads claims": 'const c = createClient(URL, tok);\nawait go(1, c);\nconst go = async (n, db) => { return db.from("claims").select("*"); };',
    "client passed through a second helper": 'const c = createClient(URL, tok);\nawait a(c);\nasync function a(x) { return b(x); }\nasync function b(y) { return y.from("claims").select("*"); }',
    "client aliased then read": 'const c = createClient(URL, tok);\nconst d = c;\nawait d.from("claims").select("*");',
    "client returned from a factory": 'function mk(tok) { return createClient(URL, tok); }',
    "client passed to an unknown function": 'const c = createClient(URL, tok);\nawait somethingElse(c);',
    "anon key with service fallback is still a caller client when a header is set": 'const u = createClient(URL, anon || serviceRoleKey, { global: { headers: { Authorization: authHeader } } });\nawait u.from("claims").select("*");',
}
CLEAN = {
    "service client reads claims": 'const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");\nconst sb = createClient(URL, supabaseKey);\nawait sb.from("claims").select("*");',
    "caller client used for auth only": 'const sbCaller = createClient(URL, callerToken);\nconst { data } = await sbCaller.auth.getUser();',
    "caller client passed to an auth-only helper": 'const c = createClient(URL, tok, { global: { headers: { authorization: h } } });\nawait who(c);\nasync function who(db) { return db.auth.getUser(); }',
    "service key via getServiceRoleKey()": 'const k = getServiceRoleKey();\nconst sb = createClient(URL, k);\nawait sb.from("claims").select("*");',
}
fails = 0
for name, src in MUT.items():
    n, p = scan_text(src, "fixture")
    ok = bool(p)
    print(("PASS: " if ok else "FAIL: ") + "mutation must be flagged: " + name); fails += (not ok)
for name, src in CLEAN.items():
    n, p = scan_text(src, "fixture")
    ok = not p
    print(("PASS: " if ok else "FAIL: ") + "must not be flagged: " + name + ("" if ok else "  " + str(p))); fails += (not ok)

# ---- the tree: every non-test .ts under supabase/functions ----
files = []
for dp, dn, fn in os.walk(ROOT):
    for f in fn:
        if f.endswith(".ts") and not re.search(r"\.(test|spec)\.ts$", f): files.append(os.path.join(dp, f))
files.sort()
texts = {f: open(f, errors="ignore").read() for f in files}
all_defs = {}
for f, t in texts.items(): all_defs.update(func_defs(t))
total = 0; problems = []
for f in files:
    n, p = scan_text(texts[f], os.path.relpath(f, ROOT), all_defs)
    if n:
        names = sorted(set(re.findall(r"([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?createClient\(", texts[f])))
        print("  caller client(s) in %-45s x%d" % (os.path.relpath(f, ROOT), n))
    total += n; problems += p
print("scanned %d non-test .ts files; caller-JWT clients: %d" % (len(files), total))
for p in problems: print("PROBLEM:", p)
ok = fails == 0 and not problems
print("EF_CALLER_JWT_CLAIMS:", "PASS (every caller-JWT client is used for .auth only)" if ok else "FAIL")
sys.exit(0 if ok else 1)
