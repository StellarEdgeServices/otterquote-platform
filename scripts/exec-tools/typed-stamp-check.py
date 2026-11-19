#!/usr/bin/env python3
"""typed-stamp-check.py -- TYPED-STAMP-V1.  GH #3250 / ERR-CEO138-D / R-140 / R-148.

Catches a timestamp that was TYPED into a GitHub comment instead of pasted from stamp.py.
For each comment it extracts every `YYYY-MM-DDTHH:MM(:SS)?Z` and bare `HH:MMZ` token and flags
a token as TYPED-STAMP-SUSPECT when it claims to be "now" but is off the comment's clock:
  RULE 1 (any comment)  a token within --horizon seconds (default 21600 = 6 h) of created_at
        but more than 120 s from BOTH created_at and updated_at, and not within 60 s of
        created_at+24h (an R-097 window) or created_at+2h (a TTL).  Tokens farther than the
        horizon are treated as quoted older stamps or deadlines and ignored.  Lines starting
        with `>` (quotes) are ignored.
  RULE 2 (R-177 SIGNED) the first full token on the `R-097 ... window` line must equal
        created_at+24h +/- 60 s.  A SIGNED comment with no such line is reported as a note.
Prints  TYPED-STAMP-SUSPECT <comment id> <token> <created_at>  per hit (reason on the next
line) and exits 1 on any hit.  Exit 0 = clean, 2 = usage/fetch error.  Read-only: it never writes
to GitHub.  The PAT is read by name inside gh-device.py and never printed.

USAGE
  typed-stamp-check.py --json comments.json        list of {id,created_at,updated_at,body}
  typed-stamp-check.py --comments <id> [<id>...]   fetch by id (repo via --repo)
  typed-stamp-check.py --claim <claim-id|stamp>    every comment in the repo created at/after the
                                                   stamp in the claim id (e.g. cto-2026-11-05T19:06:47Z),
                                                   optionally --until <stamp>
  typed-stamp-check.py --self-test                 fixtures: ORIGINAL (typed) must hit, EDITED must not
"""
import argparse, json, os, re, sys
from datetime import datetime, timedelta, timezone

REPO = "StellarEdgeServices/otterquote-platform"
FULL = re.compile(r"\b(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z\b")
BARE = re.compile(r"(?<![\d:T])\b([01]?\d|2[0-3]):([0-5]\d)Z\b")

def parse(s):
    for f in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%MZ"):
        try: return datetime.strptime(s, f).replace(tzinfo=timezone.utc)
        except ValueError: pass
    raise ValueError("bad timestamp %r" % s)

def tokens(line, ref):
    """(token text, datetime) for each stamp on the line; bare HH:MMZ resolved to the day nearest ref."""
    out, spans = [], []
    for m in FULL.finditer(line):
        if re.search(r"[A-Za-z][A-Za-z0-9]*-$", line[:m.start()]): continue   # claim id such as cto-2026-11-05T19:06:47Z
        d, hh, mm, ss = m.groups()
        out.append((m.group(0), parse("%sT%s:%s:%sZ" % (d, hh, mm, ss or "00")))); spans.append(m.span())
    for m in BARE.finditer(line):
        if any(a <= m.start() < b for a, b in spans): continue
        base = ref.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        best = min((base + timedelta(days=k) for k in (-1, 0, 1)), key=lambda x: abs((x - ref).total_seconds()))
        out.append((m.group(0), best))
    return out

def check(c, horizon=21600):
    cid, body = c["id"], c.get("body") or ""
    cr = parse(c["created_at"]); up = parse(c.get("updated_at") or c["created_at"])
    hits, notes = [], []
    signed = "R-177 SIGNED" in body
    for line in body.splitlines():
        if line.lstrip().startswith(">"): continue
        toks = tokens(line, cr)
        if signed and re.search(r"R-097", line) and re.search(r"window", line, re.I):
            full = [t for t in toks if FULL.fullmatch(t[0])]
            if not full: continue
            tok, dt = full[0]
            off = (dt - (cr + timedelta(hours=24))).total_seconds()
            if abs(off) > 60:
                hits.append((cid, tok, c["created_at"], "R-177 SIGNED window is %+.0f s from created_at+24h (limit 60 s)" % off))
            continue
        for tok, dt in toks:
            d_cr, d_up = abs((dt - cr).total_seconds()), abs((dt - up).total_seconds())
            if d_cr > horizon: continue
            if min(d_cr, d_up) <= 120: continue
            if any(abs((dt - (cr + timedelta(hours=h))).total_seconds()) <= 60 for h in (24, 2)): continue
            hits.append((cid, tok, c["created_at"], "present-tense stamp is %.0f s from created_at (limit 120 s)" % (dt - cr).total_seconds()))
    if signed and not any(re.search(r"R-097", l) and re.search(r"window", l, re.I) for l in body.splitlines()):
        notes.append("NOTE %s R-177 SIGNED comment has no 'R-097 ... window' line; rule 2 not applicable" % cid)
    return hits, notes

def run(comments, horizon=21600, out=print):
    allhits = []
    for c in comments:
        h, n = check(c, horizon)
        for line in n: out(line)
        for cid, tok, cr, why in h:
            out("TYPED-STAMP-SUSPECT %s %s %s" % (cid, tok, cr)); out("  reason: " + why)
        allhits += h
    return 1 if allhits else 0

# ---- fixtures -------------------------------------------------------------------------------
# EDITED is the live text of comment 6524352144 (PR #3235), read by REST on 2026-11-05.
# ORIGINAL: GitHub keeps no edit history through REST, so the first-posted text is NOT
# recoverable.  It is RECONSTRUCTED from the issue's description (same body, the R-097 window
# carrying a typed time instead of the stamp.py value).  The typed value 2026-10-31T14:00:00Z is
# INVENTED to stand for it; the real one is unknown.
_TAIL = ("R-097: window ends %s / 09:47 ET Sat Oct 31 (EDT, UTC-4 by arithmetic) (stamp.py), "
         "or earlier on Dustin's GO.")
_HEAD = ("R-177 SIGNED: pr=3235 sha=72ed450e257088eeafe145505641f3b01457d0e7 — Ben, CEO\n\n"
         "Based on REVIEW: PASS 6524345225 and LEGAL-READ: PASS 6524345634.\n\n"
         "Merge and apply order for Marty (binding):\n1. #3223 applied and merged.\n2. #3230 merged.\n"
         "3. This PR: apply p18_resolve_partner_slug.sql, then merge.\n\n")
FIX_EDITED = {"id": 6524352144, "created_at": "2026-10-30T13:47:04Z", "updated_at": "2026-10-30T13:47:19Z",
              "body": _HEAD + _TAIL % "2026-10-31T13:47:11Z"}
FIX_ORIGINAL = {"id": 6524352144, "created_at": "2026-10-30T13:47:04Z", "updated_at": "2026-10-30T13:47:04Z",
                "body": _HEAD + _TAIL % "2026-10-31T14:00:00Z"}

def self_test():
    buf = []
    rc_o = run([FIX_ORIGINAL], out=buf.append); rc_e = run([FIX_EDITED], out=buf.append)
    # negative controls: a quoted old stamp and a +24h value in an unsigned comment must NOT hit
    q = {"id": 1, "created_at": "2026-11-05T20:00:00Z", "body": "> was 2026-11-05T17:00:00Z\nwindow 2026-11-06T20:00:30Z\nclaim 2026-10-01T10:00:00Z"}
    rc_q = run([q], out=buf.append)
    cl = {"id": 3, "created_at": "2026-11-05T20:00:00Z", "body": "claim cto-2026-11-05T19:06:47Z"}
    rc_cl = run([cl], out=buf.append)
    t = {"id": 2, "created_at": "2026-11-05T20:00:00Z", "body": "Done at 20:30Z today."}
    rc_t = run([t], out=buf.append)
    ok = (rc_o, rc_e, rc_q, rc_t, rc_cl) == (1, 0, 0, 1, 0)
    print("\n".join(buf)); print("self-test: original=%d(want 1) edited=%d(want 0) quoted/+24h=%d(want 0) typed-bare=%d(want 1) -> %s"
                               % (rc_o, rc_e, rc_q, rc_t, "PASS" if ok else "FAIL"))
    return 0 if ok else 1

def _gh(path):
    here = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, here)
    import importlib.util
    spec = importlib.util.spec_from_file_location("ghd", os.path.join(here, "gh-device.py"))
    g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
    st, txt = g.call(g.secret("GITHUB_DEPLOY_PAT"), "GET", path)
    if st != 200: raise RuntimeError("GET %s -> HTTP %s" % (path, st))
    return json.loads(txt)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json"); ap.add_argument("--comments", nargs="+"); ap.add_argument("--claim")
    ap.add_argument("--until"); ap.add_argument("--repo", default=REPO)
    ap.add_argument("--horizon", type=int, default=21600); ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test: return self_test()
    try:
        if a.json: cs = json.load(open(a.json, encoding="utf-8"))
        elif a.comments: cs = [_gh("/repos/%s/issues/comments/%s" % (a.repo, i)) for i in a.comments]
        elif a.claim:
            m = FULL.search(a.claim)
            if not m: print("cannot find a stamp in --claim %r" % a.claim); return 2
            since, cs, page = m.group(0), [], 1
            while page <= 10:
                chunk = _gh("/repos/%s/issues/comments?since=%s&per_page=100&page=%d" % (a.repo, since, page))
                cs += [c for c in chunk if c["created_at"] >= since and (not a.until or c["created_at"] <= a.until)]
                if len(chunk) < 100: break
                page += 1
        else: ap.print_usage(); return 2
    except Exception as e:
        print("typed-stamp-check: cannot read comments (%s)" % e); return 2
    print("typed-stamp-check: %d comment(s) scanned" % len(cs))
    return run(cs, a.horizon)

if __name__ == "__main__":
    sys.exit(main())
