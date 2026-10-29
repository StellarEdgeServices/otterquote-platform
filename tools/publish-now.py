#!/usr/bin/env python3
"""publish-now.py -- ship-today path: merge an approved PR, publish production, re-lock, verify every URL.

gh-3162 (P04). Dustin's design ruling (chat with Ben, 2026-10-29 10:58 ET): "A.   Your call." = KEEP the
2026-09-30 publish lock. This is the "publish now" path for something that must go out today; it does NOT
replace the twice-daily netlify-publish-batch.yml. Same API sequence as that workflow
(unlock old -> restore new -> lock live), run for one merge commit.

Usage:
  publish-now.py <pr-number> [--check-only] [--paths a.html,b/ ...]

Env (never printed): GITHUB_TOKEN, NETLIFY_TOKEN. Python 3 stdlib only.

RESUMABLE: every invocation is bounded to ~165 s (a device shell call dies at 180 s). Each step is idempotent,
so on exit 3 ("PENDING") just run the same command again:
  1. PR still open. FAIL-CLOSED review gate: trusted (non-bot) comment bodies are normalized (NFKC, Cf/Cc dropped);
     a comment is review-ish when its first line, reduced to ASCII letters, starts with REVIEW (or has it in its first
     40 letters); LEGAL-READ likewise. The NEWEST review-ish comment (ordered by max(created_at, updated_at), then id)
     must be a clean PASS: line 1 exactly `REVIEW: PASS`, first `head:` line exactly `head: <full 40-hex current head>`,
     no other 7+-hex run in the body that is not a prefix of the head. ACCEPTED TRADE: any later review-ish comment on
     ANY head (e.g. a FAIL on an older head posted after the PASS) blocks until a fresh clean PASS is posted; the
     refusal prints the blocking comment id. A CHANGES_REQUESTED formal review newer than the PASS also refuses. For
     label r177:legal-read (or [R-120]/[R-177] in the title) the same gate applies to `LEGAL-READ:` plus
     `R-177 SIGNED:` naming the full head sha. Re-run a stale failed
     "R-177 pair gate" job once the pair is present. Require the required checks green and no red check-run.
     Enqueue on the merge queue (GraphQL; main is queue-only, REST merge returns 405). Poll for the merge.
  2. Merged: pick the site(s) from the changed files (react-app/** -> app.otterquote.com; anything served from
     the root tree -> otterquote.com), read Netlify credits (< 300 -> stop, exit 4), wait for the READY main
     deploy whose commit_ref is the merge sha, publish it (unlock old, restore new, lock live) and verify
     published_deploy == new and locked == true.
  3. Check: for each changed public URL curl it with ?oq_internal=1 (expect 200), confirm presence in the live
     sitemap.xml when the page is listed in the repo sitemap at the merge sha, plus a negative control (a random
     non-existent path in the same directory must return 404). Prints `PASS|FAIL <url> <status> sitemap=<..>`
     per URL and `RESULT: PASS|FAIL`.
  --check-only skips steps 1-2 (no merge, no publish) and only runs step 3. With --paths the PR number may be
  given as 0 (or `-`).

Exit codes: 0 PASS | 1 FAIL | 2 refused (gate not met / error) | 3 PENDING, re-run | 4 Netlify credits < 300.
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid

REPO = "StellarEdgeServices/otterquote-platform"
GH = "https://api.github.com"
NL = "https://api.netlify.com/api/v1"
SITES = {
    "jade": {"id": "6748a414-1baa-4309-a5f9-f3a7f45e3d94", "host": "https://otterquote.com"},
    "app": {"id": "26316673-212a-4f20-a95e-902ece8387c4", "host": "https://app.otterquote.com"},
}
NETLIFY_ACCOUNT = "dustin-otlykss"
CREDIT_FLOOR = 300
REQUIRED_CHECKS = ("Null-Byte & Size Sanity Check", "5-Page Revenue-Path Smoke Check")
# retired / advisory checks that may be red without blocking (same list as pr-merge-serial-device.py)
TOLERATED_RED = {"REVIEW PASS gate", "R-120 path gate", "Run E2E Tests", "R-120 signed review"}
R177_JOB = "R-177 pair gate"
BUDGET_S = 165  # one invocation must fit a 180 s device-shell call

# Top-level entries netlify.toml does NOT copy into _site (lower-cased); keep in sync with netlify.toml [build].
NOT_SERVED_TOP = {
    "_site", "netlify", "react-app", "supabase", "scripts", "sql", "tests", "handoffs", "docs", "archive",
    "runbooks", "skills-for-code", "democracy", "deploy-checks", "forge-config", "otterquote-deploy",
    "tools", "node_modules", "netlify.toml", "tools-e2e-test.txt", "package.json", "package-lock.json",
}
NOT_SERVED_EXT = (".md", ".py", ".sh", ".toml", ".ts", ".tsx")
# _redirects is copied into _site but is config, not a public URL.
NOT_A_URL = {"_redirects", "_headers"}
# Root config files that change the jade site (headers/redirects/edge gate) but are not public URLs themselves.
ROOT_CONFIG = {"netlify.toml", "_redirects", "_headers"}

_T0 = time.time()
_SECRETS = []


# ---------------------------------------------------------------- pure functions (unit-tested, no network)

def is_served(path):
    """True if this repo path ends up in the published _site tree (mirrors the netlify.toml build command)."""
    p = path.strip().lstrip("/")
    if not p:
        return False
    top = p.split("/", 1)[0]
    if p.startswith(".") and top != ".well-known":  # .well-known/ is copied by the build; other dot paths are not
        return False
    if top.lower() in NOT_SERVED_TOP:
        return False
    if p.lower().endswith(NOT_SERVED_EXT):
        return False
    if any(seg in ("node_modules", ".git", ".DS_Store") for seg in p.split("/")):
        return False
    return True


def sites_for_files(files):
    """Which Netlify sites a change set touches: react-app/** -> 'app'; served root-tree files -> 'jade'.
    react-app/app/lib/attribution-core.ts is bundled into the jade edge function, so it also builds jade."""
    out = set()
    for f in files:
        p = f.strip().lstrip("/")
        if p in ROOT_CONFIG:
            out.add("jade")  # netlify.toml / _headers / _redirects build and ship the root site
        elif p.startswith("react-app/"):
            out.add("app")
            if p == "react-app/app/lib/attribution-core.ts":
                out.add("jade")
        elif is_served(p) or p.startswith("netlify/"):
            # netlify/ (edge functions) is not copied to _site but is bundled into the jade deploy
            out.add("jade")
    return out


def url_for_path(path, host=SITES["jade"]["host"]):
    """Public URL for a served repo path, or None when the path is not a public URL."""
    p = path.strip().lstrip("/")
    if not is_served(p) or p in NOT_A_URL:
        return None
    base = p.rsplit("/", 1)[-1]
    if base in NOT_A_URL:
        return None
    if p == "index.html":
        return host + "/"
    if p.endswith("/index.html"):
        return host + "/" + p[: -len("index.html")]
    return host + "/" + urllib.parse.quote(p, safe="/-_.~")


def expand_paths(spec, tree_files):
    """--paths entries: a file, or a directory ('b/') expanded against the known tree listing."""
    out = []
    for item in [s.strip() for s in spec.split(",") if s.strip()]:
        item = item.lstrip("/")
        if item.endswith("/"):
            out += [f for f in tree_files if f.startswith(item)]
        else:
            out.append(item)
    return out


def empty_dirs(spec, tree_files):
    """--paths directory entries ('b/') that expand to zero files (unreadable tree or a wrong prefix)."""
    out = []
    for item in [s.strip() for s in spec.split(",") if s.strip()]:
        item = item.lstrip("/")
        if item.endswith("/") and not any(f.startswith(item) for f in tree_files):
            out.append(item)
    return out


def split_pr_files(entries):
    """entries: [{filename, status, previous_filename}] -> (all_paths, check_paths).
    all_paths (site selection) = new paths + removed paths + old rename paths.
    check_paths (URL checks) = added/modified/renamed NEW paths only; deleted files and old rename paths are not checked."""
    allp, chk = [], []
    for e in entries:
        f = e["filename"]
        allp.append(f)
        if e.get("previous_filename"):
            allp.append(e["previous_filename"])
        if e.get("status") != "removed":
            chk.append(f)
    return allp, chk


def check_urls(paths, sites=()):
    """Public URLs to verify for these repo paths. Root config changes (netlify.toml, _headers, _redirects) add no
    URL of their own, only the site root."""
    urls = []
    for f in paths:
        u = url_for_path(f)
        if u and u not in urls:
            urls.append(u)
    root = SITES["jade"]["host"] + "/"
    if any(f.strip().lstrip("/") in ROOT_CONFIG for f in paths) and root not in urls:
        urls.append(root)
    if "app" in sites:
        urls.append(SITES["app"]["host"] + "/")
    return urls


def sitemap_locs(xml_text):
    return set(re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml_text or ""))


def listed_in_sitemap(url, locs):
    return url in locs or (url.endswith("/index.html") and url[: -len("index.html")] in locs)


def format_line(ok, url, status, sitemap):
    """`PASS|FAIL <url> <status> sitemap=<yes|no|n/a>`"""
    return "%s %s %s sitemap=%s" % ("PASS" if ok else "FAIL", url, status, sitemap)


def judge_url(status, sitemap_needed, in_live_sitemap):
    """-> (ok, sitemap_label). 200 is required; if the page is listed in the repo sitemap it must also be live."""
    if not sitemap_needed:
        return status == 200, "n/a"
    return (status == 200 and bool(in_live_sitemap)), ("yes" if in_live_sitemap else "no")


_CONFUSABLES = dict(zip(
    "\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0406\u0405\u0408\u0430\u0435\u043e\u0440\u0441\u0445\u0456\u0455\u0458"
    "\u0391\u0392\u0395\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a7\u03a5\u0396\u03b1\u03b5\u03b9\u03bf\u03c1\u03bd",
    "ABEKMHOPCTXISJaeopcxisj" "ABEIKMNOPTXYZaeiopv"))
_CTRL_ASCII = re.compile("[\x00-\x09\x0b-\x1f\x7f]")


def normalize(s):
    """NFKC (folds fullwidth colon, NBSP, ...), then drop every Cf (zero-width, BOM, LRM) and Cc (except \\n) char."""
    s = s or ""
    if s.isascii():
        return _CTRL_ASCII.sub("", s)
    return "".join(ch for ch in unicodedata.normalize("NFKC", s)
                   if ch == "\n" or unicodedata.category(ch) not in ("Cf", "Cc"))


def _letters(line):
    """ASCII letters only, uppercased. Known Cyrillic/Greek look-alikes map to their Latin twin; any other non-ASCII
    letter becomes `?` (a wildcard when matching), so a homoglyph can never hide a review-ish comment."""
    out = []
    for ch in line:
        ch = _CONFUSABLES.get(ch, ch)
        if "A" <= ch.upper() <= "Z" and ch.isascii():
            out.append(ch.upper())
        elif not ch.isascii() and ch.isalpha():
            out.append("?")
    return "".join(out)


def _wild(word):
    return "".join("[%s?]" % c for c in word)


def first_line(body):
    """First line that carries a verdict: skips blank lines, lines with no letters (---, emoji), HTML comments and
    lines that are only @mentions (round-4 review: those let a FAIL hide on line 2)."""
    for l in normalize(body).split("\n"):
        t = re.sub(r"<!--.*?-->", "", l).strip()
        t2 = re.sub(r"@[\w-]+", "", t).strip(" ,:")
        if not t2 or not re.search(r"[A-Za-z]", t2) and not any(ch.isalpha() for ch in t2):
            continue
        return t2
    return ""


def review_ish(body, prefix):
    """FAIL-CLOSED detector, deliberately over-inclusive and blind to shas: True when the first non-empty line, reduced
    to ASCII letters, STARTS WITH the prefix word(s) (REVIEW | LEGALREAD) or has them anywhere in its first 40 letters."""
    word = re.sub(r"[^A-Z]", "", prefix.upper())
    letters = _letters(first_line(body))
    pat = _wild(word)
    return bool(re.match(pat, letters) or re.search(pat, letters[:40]))


def _item(x, i):
    if isinstance(x, str):  # tests/harnesses: bare bodies, oldest first
        return {"id": i, "created_at": "%08d" % i, "updated_at": "%08d" % i, "body": x}
    return x


def _order(c, sha=None, prefix=None):
    """Ordering key. A non-PASS review-ish comment sorts by max(created_at, updated_at) (editing an old comment into a
    FAIL makes it newer). A clean PASS sorts by created_at ONLY (round-4 review 6505483986: an edit to a PASS after a
    later FAIL must not let the PASS overtake the FAIL)."""
    if sha is not None and clean_pass(c.get("body", ""), sha, prefix):
        t = c.get("created_at") or ""
    else:
        t = max(c.get("created_at") or "", c.get("updated_at") or "")
    return (t, c.get("id") or 0)


def clean_pass(body, sha, prefix):
    """True only for: raw line 1 exactly `<prefix>: PASS`; the first `head:` line exactly `head: <full 40-hex sha>` equal
    to `sha`. Raw text is used, so a zero-width char or homoglyph in either line is NOT clean. Other shas cited in the
    body are allowed (the gate's safety comes from fail-closed ordering, not from the body)."""
    sha = sha.lower()
    raw = (body or "").replace("\r\n", "\n").lstrip().split("\n")
    if raw[0].strip() != prefix + ": PASS":
        return False
    heads = [l.strip() for l in raw[1:] if re.match(r"head:", l.strip(), re.I)]
    head = heads[0] if heads else ""
    if re.fullmatch(r"head: ([0-9a-fA-F]{40})", head) is None or head[6:].lower() != sha:
        return False
    if any(h.lower() != head.lower() for h in heads):  # a PASS naming two different heads is ambiguous: not clean
        return False
    # Round-4 review 6505483986: no body-wide foreign-sha scan. The gate is sha-agnostic (any later review-ish comment
    # blocks), so scanning the body added no safety and rejected every real PASS that cites another commit.
    return True


def gate(comments, sha, prefix):
    """FAIL-CLOSED gate (gh-3162, CTO Tier A). `comments` are TRUSTED (non-bot) comment dicts (id, created_at,
    updated_at, body), any order; bare strings are taken oldest-first. Returns (ok, blocker_id, ts):
    ok is True only when the NEWEST review-ish comment (ordering max(created_at, updated_at), tie by id; so an edit made
    after the PASS counts as newer) is a clean PASS. Review-ish is decided from the first line alone, after
    normalization, and never looks at shas. Accepted consequence: ANY later review-ish comment on ANY head (a FAIL on an
    older head posted after the PASS, a QUESTION, a malformed FAIL) blocks until a fresh clean PASS is posted. blocker_id
    is the comment that blocked (None when there is no review-ish comment at all); ts is the PASS ordering time."""
    items = [_item(x, i) for i, x in enumerate(comments)]
    ish = sorted([c for c in items if review_ish(c.get("body", ""), prefix)], key=lambda c: _order(c, sha, prefix))
    if not ish:
        return False, None, ""
    last = ish[-1]
    if clean_pass(last.get("body", ""), sha, prefix):
        return True, last.get("id"), _order(last, sha, prefix)[0]
    return False, last.get("id"), ""


def reviews_block(reviews, pass_ts):
    """id of a formal PR review in state CHANGES_REQUESTED submitted after the clean PASS (any author), else None."""
    for r in reviews or []:
        if r.get("state") == "CHANGES_REQUESTED" and (r.get("submitted_at") or "9") > pass_ts:
            return r.get("id")
    return None


def review_ok(comments, sha):
    """True only if the newest review-ish `REVIEW` comment is a clean PASS on exactly this head."""
    return gate(comments, sha, "REVIEW")[0]


def r177_pair(comments, n, sha):
    """(legal_read_pass, signed). LEGAL-READ: the newest review-ish LEGAL-READ comment must be a clean PASS (same
    fail-closed gate). SIGNED must name the FULL head sha."""
    read_ok = gate(comments, sha, "LEGAL-READ")[0]
    bodies = [x if isinstance(x, str) else x.get("body", "") for x in comments]
    boundary = r"(?![0-9a-f])"
    signed = any(re.match(re.escape("R-177 SIGNED: pr=%s sha=%s" % (n, sha)) + boundary, x.lstrip()) for x in bodies)
    if not signed:
        for x in bodies:
            ls = x.lstrip().splitlines()
            if ls and ls[0].startswith("R-177 SIGNED:") and any(
                    re.match(re.escape("Head: " + sha) + boundary, l.strip()) for l in ls[1:6]):
                signed = True
                break
    return read_ok, signed


def needs_r177(title, labels):
    return bool(re.search(r"\[R-1(20|77)\]", title or "")) or "r177:legal-read" in set(labels or [])


def trusted_human(c):
    u = c.get("user") or {}
    trusted = c.get("author_association") in ("OWNER", "MEMBER", "COLLABORATOR") or u.get("login") == "dustinstohler1-dotcom"
    return bool(trusted) and u.get("type") != "Bot" and not str(u.get("login") or "").endswith("[bot]")


def pick_deploy(deploys, merge_sha, branch="main"):
    """Ready production deploy built from the merge commit."""
    for d in deploys:
        if (d.get("state") == "ready" and d.get("branch") == branch and d.get("context", "production") == "production"
                and str(d.get("commit_ref") or "") == merge_sha):
            return d
    return None


# ---------------------------------------------------------------- plumbing

def left():
    return BUDGET_S - (time.time() - _T0)


def say(*a):
    print(*a, flush=True)


def scrub(s):
    s = str(s)
    for sec in _SECRETS:
        if sec:
            s = s.replace(sec, "***")
    return s


class _SameOriginAuthRedirect(urllib.request.HTTPRedirectHandler):
    """Same approach as In Flight/bin/gh-device.py (MARKER-GHDEVICE-NO-XHOST-AUTH): urllib copies Authorization onto
    a redirect target; follow the redirect but drop Authorization when scheme, host or port change."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        a, b = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(new.full_url)
        if (a.scheme, a.hostname, a.port) != (b.scheme, b.hostname, b.port):
            for store in (new.headers, new.unredirected_hdrs):
                for k in [k for k in store if k.lower() == "authorization"]:
                    del store[k]
        return new


_OPENER = urllib.request.build_opener(_SameOriginAuthRedirect)


def http(method, url, headers=None, body=None, timeout=30):
    data = None
    h = {"User-Agent": "publish-now"}
    h.update(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method, headers=h, data=data)
    try:
        with _OPENER.open(req, timeout=max(5, min(timeout, left()))) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # network error
        return 0, "ERR %s" % scrub(e)


def jload(s):
    try:
        return json.loads(s)
    except Exception:
        return None


class Ctx:
    def __init__(self):
        self.gh_tok = os.environ.get("GITHUB_TOKEN", "")
        self.nl_tok = os.environ.get("NETLIFY_TOKEN", "")
        _SECRETS.extend([self.gh_tok, self.nl_tok])

    def gh(self, method, path, body=None):
        h = {"Accept": "application/vnd.github+json"}
        if self.gh_tok:
            h["Authorization"] = "Bearer " + self.gh_tok
        s, b = http(method, GH + path, h, body)
        return s, jload(b) if b else None, b

    def gql(self, query, variables=None):
        s, b = http("POST", GH + "/graphql", {"Authorization": "Bearer " + self.gh_tok}, {"query": query, "variables": variables or {}})
        return s, jload(b)

    def nl(self, method, path, timeout=60):
        s, b = http(method, NL + path, {"Authorization": "Bearer " + self.nl_tok}, {} if method == "POST" else None, timeout=timeout)
        return s, jload(b) if b else None


def pr_files(ctx, n):
    entries, page = [], 1
    while True:
        s, d, _ = ctx.gh("GET", "/repos/%s/pulls/%s/files?per_page=100&page=%d" % (REPO, n, page))
        if s != 200 or not isinstance(d, list):
            raise RuntimeError("cannot list PR files: HTTP %s" % s)
        for f in d:
            entries.append({"filename": f["filename"], "status": f.get("status"), "previous_filename": f.get("previous_filename")})
        if len(d) < 100:
            return entries
        page += 1


# ---------------------------------------------------------------- step 1: gates + enqueue + merge

def step_merge(ctx, n):
    """Returns merge sha (str) when merged; exits 2/3 otherwise."""
    s, p, _ = ctx.gh("GET", "/repos/%s/pulls/%s" % (REPO, n))
    if s != 200:
        say("REFUSED: cannot read PR #%s (HTTP %s)" % (n, s)); sys.exit(2)
    if p.get("merged"):
        say("PR #%s already merged: %s" % (n, p["merge_commit_sha"][:10])); return p["merge_commit_sha"]
    if p.get("state") != "open":
        say("REFUSED: PR #%s is %s and not merged" % (n, p.get("state"))); sys.exit(2)
    sha = p["head"]["sha"]
    labels = [l["name"] for l in p.get("labels", [])]
    say("PR #%s head=%s labels=%s" % (n, sha[:10], ",".join(labels) or "-"))
    cs, page = [], 1
    while True:  # page through ALL comments: a newer FAIL on a later page must be seen
        s, d, _ = ctx.gh("GET", "/repos/%s/issues/%s/comments?per_page=100&page=%d" % (REPO, n, page))
        if s != 200 or not isinstance(d, list):
            say("REFUSED: cannot read comments (HTTP %s, page %d)" % (s, page)); sys.exit(2)
        if not d:
            break
        cs.extend(d)
        page += 1
        if page > 100:
            say("REFUSED: more than 100 pages of comments"); sys.exit(2)
    # Round-4 review: a FAIL posted as a formal review body (any state) or as an inline diff comment must also count.
    extra = []
    for path in ("/repos/%s/pulls/%s/reviews" % (REPO, n), "/repos/%s/pulls/%s/comments" % (REPO, n)):
        page = 1
        while True:
            s, d, _ = ctx.gh("GET", "%s?per_page=100&page=%d" % (path, page))
            if s != 200 or not isinstance(d, list):
                say("REFUSED: cannot read %s (HTTP %s, page %d)" % (path, s, page)); sys.exit(2)
            if not d:
                break
            for r in d:
                if r.get("body") and r.get("state") != "DISMISSED":
                    t = r.get("submitted_at") or r.get("created_at") or ""
                    extra.append({"id": r.get("id"), "user": r.get("user"), "body": r.get("body"),
                                  "created_at": t, "updated_at": r.get("updated_at") or t})
            page += 1
            if page > 100:
                say("REFUSED: more than 100 pages at %s" % path); sys.exit(2)
    trusted = [c for c in cs + extra if trusted_human(c)]
    ok, blocker, pass_ts = gate(trusted, sha, "REVIEW")
    if not ok:
        say("REFUSED: newest review-ish `REVIEW` comment (id %s) is not a clean PASS on current head %s (fail-closed: any later review-ish comment on any head blocks until a fresh clean PASS)" % (blocker, sha[:10])); sys.exit(2)
    rv, page = [], 1
    while True:
        s, d, _ = ctx.gh("GET", "/repos/%s/pulls/%s/reviews?per_page=100&page=%d" % (REPO, n, page))
        if s != 200 or not isinstance(d, list):
            say("REFUSED: cannot read PR reviews (HTTP %s, page %d)" % (s, page)); sys.exit(2)
        if not d:
            break
        rv.extend(d)
        page += 1
        if page > 100:
            say("REFUSED: more than 100 pages of reviews"); sys.exit(2)
    rb = reviews_block(rv, pass_ts)
    if rb is not None:
        say("REFUSED: CHANGES_REQUESTED PR review %s is newer than the clean PASS (comment %s)" % (rb, blocker)); sys.exit(2)
    say("gate ok: newest review-ish comment %s is a clean PASS on %s" % (blocker, sha[:10]))
    bodies = trusted  # R-177 pair reads the same trusted comments
    flagged = needs_r177(p.get("title"), labels)
    pair_ok = True
    if flagged:
        ro, so = r177_pair(bodies, n, sha)
        if not (ro and so):
            say("REFUSED: R-177 flagged; LEGAL-READ: PASS over %s=%s, R-177 SIGNED over %s=%s" % (sha[:10], ro, sha[:10], so)); sys.exit(2)
        say("gate ok: R-177 pair present over %s" % sha[:10])
    # check-runs on the head
    s, d, _ = ctx.gh("GET", "/repos/%s/commits/%s/check-runs?per_page=100" % (REPO, sha))
    runs = (d or {}).get("check_runs", []) if s == 200 else []
    if s != 200:
        say("REFUSED: cannot read check-runs (HTTP %s)" % s); sys.exit(2)
    if flagged:
        gate = sorted([r for r in runs if r["name"] == R177_JOB], key=lambda r: r.get("started_at") or "")
        if gate and gate[-1].get("status") == "completed" and gate[-1].get("conclusion") == "failure":
            # the gate does not re-run when a signature lands: re-run the latest failed job
            s, _, b = ctx.gh("POST", "/repos/%s/actions/jobs/%s/rerun" % (REPO, gate[-1]["id"]))
            say("re-ran stale failed `%s` job %s -> HTTP %s" % (R177_JOB, gate[-1]["id"], s))
            say("PENDING: re-run the same command"); sys.exit(3)
        if gate and gate[-1].get("status") != "completed":
            say("PENDING: `%s` still running; re-run the same command" % R177_JOB); sys.exit(3)
    latest = {}
    for r in sorted(runs, key=lambda r: r.get("started_at") or ""):
        latest[r["name"]] = r
    red = [k for k, r in latest.items() if r.get("conclusion") in ("failure", "timed_out") and k not in TOLERATED_RED]
    if red:
        say("REFUSED: failing check-run(s) on head %s: %s" % (sha[:10], red)); sys.exit(2)
    missing = [k for k in REQUIRED_CHECKS if not (latest.get(k) and latest[k].get("conclusion") == "success")]
    if missing:
        pend = [k for k in missing if not latest.get(k) or latest[k].get("status") != "completed"]
        if pend:
            say("PENDING: required check(s) not finished: %s; re-run the same command" % pend); sys.exit(3)
        say("REFUSED: required check(s) not green: %s" % missing); sys.exit(2)
    say("gate ok: required checks green")
    # enqueue
    s, d = ctx.gql('query($n:Int!){repository(owner:"StellarEdgeServices",name:"otterquote-platform"){pullRequest(number:$n){id isInMergeQueue}}}', {"n": int(n)})
    node = ((d or {}).get("data") or {}).get("repository", {}).get("pullRequest") if s == 200 else None
    if not node:
        say("REFUSED: GraphQL PR lookup failed (HTTP %s)" % s); sys.exit(2)
    if not node["isInMergeQueue"]:
        s, d = ctx.gql('mutation($id:ID!,$oid:GitObjectID){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{id state position}}}', {"id": node["id"], "oid": sha})
        if s != 200 or (d or {}).get("errors"):
            say("REFUSED: enqueue failed: HTTP %s %s" % (s, scrub(json.dumps((d or {}).get("errors"))[:300]))); sys.exit(2)
        say("enqueued PR #%s on the merge queue" % n)
    else:
        say("PR #%s already in the merge queue" % n)
    deadline = time.time() + min(140, left() - 5)
    while time.time() < deadline:
        time.sleep(10)
        s, p, _ = ctx.gh("GET", "/repos/%s/pulls/%s" % (REPO, n))
        if s == 200 and p.get("merged"):
            say("MERGED %s" % p["merge_commit_sha"][:10]); return p["merge_commit_sha"]
        if s == 200 and p.get("state") == "closed":
            say("REFUSED: PR #%s closed without merging (left the queue)" % n); sys.exit(2)
    say("PENDING: not merged yet; re-run the same command"); sys.exit(3)


# ---------------------------------------------------------------- step 2: publish

def credits(ctx):
    s, d = ctx.nl("GET", "/%s/billing/credits" % NETLIFY_ACCOUNT)
    try:
        return float(d["plan_credits"]["available"])
    except Exception:
        say("STOP: cannot read Netlify credits (HTTP %s); not publishing blind" % s); sys.exit(4)


def publish_site(ctx, key, merge_sha):
    site = SITES[key]
    sid = site["id"]
    s, d = ctx.nl("GET", "/sites/%s" % sid)
    if s != 200:
        say("REFUSED: cannot read %s site (HTTP %s)" % (key, s)); sys.exit(2)
    old = d["published_deploy"]
    s, ds = ctx.nl("GET", "/sites/%s/deploys?production=true&state=ready&per_page=30" % sid)
    new = pick_deploy(ds if isinstance(ds, list) else [], merge_sha)
    if old.get("commit_ref") == merge_sha:
        say("[%s] merge deploy %s already published (locked=%s)" % (key, old["id"], old.get("locked")))
        new = old
    elif not new:
        # still building? show state of the newest deploys for the merge sha
        s, all_ = ctx.nl("GET", "/sites/%s/deploys?production=true&per_page=10" % sid)
        st = [x.get("state") for x in (all_ or []) if str(x.get("commit_ref") or "") == merge_sha]
        return ("wait", st)
    elif new.get("published_at"):
        say("[%s] deploy %s was already published before; not re-publishing" % (key, new["id"]));
    else:
        if (new.get("created_at") or "") <= (old.get("created_at") or ""):
            say("REFUSED: [%s] merge deploy is older than the published one; publishing would roll back" % key); sys.exit(2)
        if left() < 60:
            say("PENDING: only %ds left in this invocation's budget; not unlocking %s now. Re-run the same command" % (left(), key)); sys.exit(3)
        say("[%s] publishing %s (commit %s) over %s" % (key, new["id"], merge_sha[:10], old["id"]))
        try:
            su, _ = ctx.nl("POST", "/deploys/%s/unlock" % old["id"], timeout=15); say("  unlock old -> HTTP %s" % su)
            sr, _ = ctx.nl("POST", "/sites/%s/deploys/%s/restore" % (sid, new["id"]), timeout=15); say("  restore new -> HTTP %s" % sr)
            time.sleep(6)
        finally:
            s2, d2 = ctx.nl("GET", "/sites/%s" % sid, timeout=15)
            live = (d2 or {}).get("published_deploy") or {}
            if s2 != 200 or not live.get("id"):
                say("WARNING: site may be UNLOCKED \u2014 re-run this command"); sys.exit(1)
            if not live.get("locked"):
                sl, _ = ctx.nl("POST", "/deploys/%s/lock" % live["id"], timeout=15); say("  lock live %s -> HTTP %s" % (live["id"], sl))
                if not 200 <= sl < 300:
                    say("WARNING: site may be UNLOCKED \u2014 re-run this command"); sys.exit(1)
    s, d = ctx.nl("GET", "/sites/%s" % sid)
    pd = (d or {}).get("published_deploy") or {}
    if pd.get("id") != new["id"] and pd.get("commit_ref") != merge_sha:
        # a newer main deploy published by the batch is fine only if it carries the merge sha ancestry; be strict
        say("FAIL: [%s] published deploy %s != expected %s" % (key, pd.get("id"), new["id"])); sys.exit(1)
    if not pd.get("locked"):
        sl, _ = ctx.nl("POST", "/deploys/%s/lock" % pd["id"]); say("  re-lock -> HTTP %s" % sl)
        s, d = ctx.nl("GET", "/sites/%s" % sid); pd = (d or {}).get("published_deploy") or {}
        if not pd.get("locked"):
            say("FAIL: [%s] site left UNLOCKED; lock it by hand" % key); sys.exit(1)
    say("[%s] verified: published_deploy=%s commit=%s locked=%s" % (key, pd["id"], str(pd.get("commit_ref"))[:10], pd.get("locked")))
    return ("ok", pd["id"])


def step_publish(ctx, sites, merge_sha):
    c = credits(ctx)
    say("netlify credits available: %s" % c)
    if c < CREDIT_FLOOR:
        say("STOP: credits %s < %s (Dustin's rule). Not publishing; tell Dustin." % (c, CREDIT_FLOOR)); sys.exit(4)
    pending = set(sites)
    while pending:
        for key in sorted(pending):
            st, info = publish_site(ctx, key, merge_sha)
            if st == "ok":
                pending.discard(key)
        if not pending:
            break
        if left() < 25:
            say("PENDING: ready main deploy for %s not up yet (state %s); re-run the same command" % (sorted(pending), info)); sys.exit(3)
        time.sleep(10)


# ---------------------------------------------------------------- step 3: verify

def tree_files(ctx, ref):
    s, d, _ = ctx.gh("GET", "/repos/%s/git/trees/%s?recursive=1" % (REPO, ref))
    if s != 200 or not d:
        return []
    return [t["path"] for t in d.get("tree", []) if t.get("type") == "blob"]


def fetch_repo_sitemap(ctx, ref):
    s, d, _ = ctx.gh("GET", "/repos/%s/contents/sitemap.xml?ref=%s" % (REPO, ref))
    if s == 200 and d and d.get("content"):
        import base64
        return base64.b64decode(d["content"]).decode("utf-8", "replace")
    # fallback: raw.githubusercontent.com (public repo) when the API is unavailable
    s, b = http("GET", "https://raw.githubusercontent.com/%s/%s/sitemap.xml" % (REPO, ref), timeout=30)
    if s == 200 and "<loc>" in b:
        return b
    say("note: could not read repo sitemap.xml at %s (HTTP %s); sitemap=n/a for all URLs" % (ref[:10], s))
    return ""


def curl_status(url):
    sep = "&" if "?" in url else "?"
    s, _ = http("GET", url + sep + "oq_internal=1", timeout=30)
    return s


def step_check(ctx, files, ref, sites):
    repo_locs = sitemap_locs(fetch_repo_sitemap(ctx, ref))
    s, live_xml = http("GET", SITES["jade"]["host"] + "/sitemap.xml?oq_internal=1", timeout=30)
    live_locs = sitemap_locs(live_xml) if s == 200 else set()
    if s != 200:
        say("note: live sitemap.xml returned HTTP %s" % s)
    urls = check_urls(files, sites)
    ok_all = True
    dirs = set()
    if not urls:
        say("FAIL: no public URLs derived from the change set"); return False
    for u in urls:
        st = curl_status(u)
        needs = u.startswith(SITES["jade"]["host"]) and listed_in_sitemap(u, repo_locs)
        in_live = listed_in_sitemap(u, live_locs)
        ok, label = judge_url(st, needs, in_live)
        say(format_line(ok, u, st, label))
        ok_all &= ok
        dirs.add(u.rsplit("/", 1)[0] + "/")
    for d in sorted(dirs):
        ctl = d + "oq-negative-control-%s.html" % uuid.uuid4().hex[:10]
        st = curl_status(ctl)
        good = st == 404
        say("%s control %s %s (non-existent path must be 404)" % ("PASS" if good else "FAIL", ctl, st))
        ok_all &= good
    return ok_all


# ---------------------------------------------------------------- main

def main(argv):
    try:
        sys.stdout.reconfigure(errors="replace")  # a non-UTF-8 console must not break the WARNING line
    except Exception:
        pass
    args = [a for a in argv if not a.startswith("--")]
    check_only = "--check-only" in argv
    paths = None
    if "--paths" in argv:
        i = argv.index("--paths")
        if i + 1 >= len(argv):
            say("usage: publish-now.py <pr-number> [--check-only] [--paths a.html,b/]"); return 2
        paths = argv[i + 1]
        args = [a for a in args if a != paths]
    if not args and not paths:
        say("usage: publish-now.py <pr-number> [--check-only] [--paths a.html,b/]"); return 2
    n = args[0] if args else "0"
    ctx = Ctx()
    if not check_only and not (ctx.gh_tok and ctx.nl_tok):
        say("REFUSED: GITHUB_TOKEN and NETLIFY_TOKEN must be set in the environment"); return 2
    # --check-only reads only public data; GITHUB_TOKEN is optional there (avoids anonymous rate limits)
    if n in ("-", "0", ""):
        if not paths:
            say("usage: a PR number or --paths is required"); return 2
        ref = "main"
        tree = tree_files(ctx, "main")
        bad = empty_dirs(paths, tree)
        if bad:
            say("REFUSED: --paths director%s %s expanded to no files (repo tree unreadable, e.g. HTTP 403 without a GITHUB_TOKEN, or no such prefix); not checking a partial list" % ("y" if len(bad) == 1 else "ies", ", ".join(bad))); return 2
        files = expand_paths(paths, tree)
        sites = sites_for_files(files)
    else:
        n = str(int(n))
        all_paths, files = split_pr_files(pr_files(ctx, n))
        sites = sites_for_files(all_paths)
        if paths:
            tree = tree_files(ctx, "main")
            bad = empty_dirs(paths, tree)
            if bad:
                say("REFUSED: --paths director%s %s expanded to no files (repo tree unreadable or no such prefix)" % ("y" if len(bad) == 1 else "ies", ", ".join(bad))); return 2
            files = expand_paths(paths, tree)
        ref = "main"
    if check_only:
        say("check-only: no merge, no publish")
        if n not in ("-", "0", ""):
            s, p, _ = ctx.gh("GET", "/repos/%s/pulls/%s" % (REPO, n))
            if s == 200 and p.get("merged"):
                ref = p["merge_commit_sha"]
        ok = step_check(ctx, files, ref, sites)
        say("RESULT: %s" % ("PASS" if ok else "FAIL")); return 0 if ok else 1
    if n in ("-", "0", ""):
        say("REFUSED: publishing requires a PR number"); return 2
    say("PR #%s changes %d file(s) (%d to URL-check); sites: %s" % (n, len(all_paths), len(files), sorted(sites) or "none (nothing served changes)"))
    merge_sha = step_merge(ctx, n)
    ref = merge_sha
    if sites:
        step_publish(ctx, sites, merge_sha)
    else:
        say("no served files changed: nothing to publish")
    ok = step_check(ctx, files, ref, sites)
    say("RESULT: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
