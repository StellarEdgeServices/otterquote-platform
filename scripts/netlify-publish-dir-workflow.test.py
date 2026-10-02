#!/usr/bin/env python3
"""gh-2392 follow-up: prove .github/workflows/netlify-publish-dir-tests.yml fires when it should.

That workflow is the only thing that runs scripts/netlify-publish-dir.test.py and
scripts/netlify-ignore.test.py. Its `pull_request.paths` filter must fire for "any
new root-level entry" (Marty, 5911784069), which a paths filter can only express as
"every root dir EXCEPT today's known ones". So this test:
  1. evaluates the filter with GitHub's rules (patterns in order, last match wins;
     `*` does not cross `/`, `**` does) against a table of changed paths that must
     and must not trigger the run, including a brand-new root dir and root file
  2. keeps the negation list in sync with the repo: every tracked root dir is
     either negated or re-included on purpose, and no negated dir is stale -- so a
     newly added served/internal dir gets a deliberate edit here, exactly like
     SERVED_TOP_LEVEL_DIRS in netlify-publish-dir.test.py
  3. negative control: the same evaluator, with the '*/**' catch-all removed, must
     report that a new root dir does NOT trigger -- so check 1 can see the hole
     it exists to catch

Standard library only (the workflow uses the runner's system python3).
Usage: python3 scripts/netlify-publish-dir-workflow.test.py   (exit 0 = all pass)
"""
import os
import re
import subprocess
import sys

REPO = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip() or os.getcwd()
WORKFLOW = ".github/workflows/netlify-publish-dir-tests.yml"
# Root dirs whose changes SHOULD run the tests (re-included after the negations).
TRIGGER_DIRS = {"netlify"}

failures = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


def read_paths(text):
    """The `paths:` list under `on.pull_request`, in order (no YAML dependency)."""
    lines = text.splitlines()
    out, in_pr, in_paths = [], False, False
    for ln in lines:
        if re.match(r"^  pull_request:\s*$", ln):
            in_pr = True
            continue
        if in_pr and re.match(r"^  \S", ln):
            break
        if in_pr and re.match(r"^    paths:\s*$", ln):
            in_paths = True
            continue
        if in_paths:
            m = re.match(r"^      - '([^']*)'\s*$", ln)
            if m:
                out.append(m.group(1))
            elif re.match(r"^    \S", ln):
                break
    return out


def glob_re(pat):
    i, rx = 0, ""
    while i < len(pat):
        if pat.startswith("**", i):
            rx += ".*"
            i += 2
        elif pat[i] == "*":
            rx += "[^/]*"
            i += 1
        elif pat[i] == "?":
            rx += "[^/]"
            i += 1
        else:
            rx += re.escape(pat[i])
            i += 1
    return re.compile("^" + rx + "$")


def fires(patterns, path):
    hit = False
    for p in patterns:
        neg = p.startswith("!")
        if glob_re(p[1:] if neg else p).match(path):
            hit = not neg
    return hit


text = open(os.path.join(REPO, WORKFLOW), encoding="utf-8").read()
pats = read_paths(text)
check(len(pats) > 10, "read %d paths patterns from %s" % (len(pats), WORKFLOW))
check("merge_group" not in re.sub(r"(?m)^\s*#.*$", "", text), "non-required: no merge_group trigger (paths are ignored there; bills every queue entry)")
check("pull_request_target" not in re.sub(r"(?m)^\s*#.*$", "", text), "uses pull_request, never pull_request_target")

# --- 1. trigger table -----------------------------------------------------------
MUST_RUN = [
    "brand-new-dir/index.html",          # new root dir (served or internal) -> must run
    "brand-new-dir/deep/notes.txt",
    "internal-notes.json",               # new root file
    "backup.sql",
    "netlify.toml", "_redirects", "robots.txt", "sitemap.xml", "llms.txt", "partner-sw.js",
    "netlify/edge-functions/ref-redirect.ts",
    "scripts/netlify-publish-dir.test.py", "scripts/netlify-ignore.test.py",
    "scripts/netlify-publish-dir-workflow.test.py",
    "react-app/app/lib/attribution-core.ts",  # carve-out in the production ignore rule
    WORKFLOW,
]
MUST_NOT_RUN = [
    "index.html", "start.html", "README.md", "CLAUDE.md",
    "js/auth.js", "css/main.css", "img/favicon.svg", "blog/some-post.html",
    "supabase/functions/stripe-webhook/index.ts", "supabase/migrations/v1_x.sql",
    "scripts/r177/predicate.mjs", "react-app/app/page.tsx", "tests/gh2378-ho6.mjs",
    ".github/workflows/e2e-tests.yml", "docs/x.md", "Docs/y.md",
]
for p in MUST_RUN:
    check(fires(pats, p), "runs on change to %s" % p)
for p in MUST_NOT_RUN:
    check(not fires(pats, p), "does not run on change to %s" % p)

# --- 2. negation list == repo's tracked root dirs --------------------------------
tracked = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True, text=True).stdout.splitlines()
root_dirs = {t.split("/", 1)[0] for t in tracked if "/" in t}
negated = {m.group(1) for p in pats for m in [re.match(r"^!([^*/]+)/\*\*$", p)] if m}
unlisted = sorted(root_dirs - negated - TRIGGER_DIRS)
stale = sorted(negated - root_dirs - TRIGGER_DIRS)
check(not unlisted, "every tracked root dir is negated or a trigger dir (add new ones to %s deliberately)%s" % (
    WORKFLOW, (": " + ", ".join(unlisted)) if unlisted else ""))
check(not stale, "no negation for a root dir that no longer exists%s" % ((": " + ", ".join(stale)) if stale else ""))

# --- 3. negative control ----------------------------------------------------------
holed = [p for p in pats if p != "*/**"]
check(len(holed) == len(pats) - 1, "negative control: removed exactly the '*/**' catch-all")
check(not fires(holed, "brand-new-dir/index.html"),
      "negative control: without '*/**' a new root dir does NOT trigger (the evaluator sees the hole)")
check(not fires(["*", "!*.html"], "brand-new-dir/index.html"), "negative control: '*' alone does not cross '/'")

print()
if failures:
    print("FAILED: %d check(s)" % len(failures))
    sys.exit(1)
print("ALL PASS")
