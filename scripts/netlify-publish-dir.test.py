#!/usr/bin/env python3
"""gh-2392: prove repository internals are PHYSICALLY ABSENT from the published tree.

Background: netlify.toml used to publish the repo root (`publish = "."`), so
internals were served (gh-2389). Forced 404 redirects match EXACT CASE only while
Netlify's static lookup is case-insensitive, so /nEtlify/edge-functions/x.ts and
/REACT-APP/... still returned 200. The only case-proof fix is for the files not to
exist in the publish directory. The build command now copies the served tree into
a dedicated publish dir (`_site`) minus every internal.

This test EXECUTES the real build command (extracted from netlify.toml, not
re-typed) inside a temp copy of the working tree, with STRIPE_PK set to a dummy,
under both `sh` (dash on Debian/Ubuntu) and `bash`, then asserts:
  1. nothing internal is in the publish dir (case-insensitive walk over every
     path segment, plus internal file suffixes) -- including synthetic trap files
     planted in the temp copy (README.MD, Netlify/, REACT-APP/, .git, node_modules)
  2. the top-level dir set of the publish dir is exactly the known served set (a
     new root dir must be added to SERVED_TOP_LEVEL_DIRS deliberately -- a new
     internal dir therefore fails closed in CI rather than being published), and
     the set of non-.html top-level FILES is exactly the known served set (same
     rule for a new root file: a stray internal-notes.json or .env.bak fails
     closed rather than going live)
  3. required served files exist; js/config.js has the dummy key injected
  4. every local path a served page/script/stylesheet references that exists in
     the source tree also exists in the publish dir (nothing referenced excluded)
  5. the SOURCE tree is untouched: netlify/edge-functions and
     react-app/app/lib/attribution-core.ts still exist (edge functions are bundled
     from the source tree, not from the publish dir), and source js/config.js
     still holds the %%STRIPE_PK%% placeholder
  6. `publish` is set consistently in [build], [context.staging] and
     [context.deploy-preview]

Usage: python3 scripts/netlify-publish-dir.test.py     (exit 0 = all pass)
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib

REPO = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip() or os.getcwd()
DUMMY_KEY = "pk_test_DUMMY_gh2392_0123456789"

# Every name that must never appear as ANY path segment in the publish dir
# (compared lower-cased).
INTERNAL_SEGMENTS = {
    "netlify", "react-app", "supabase", "scripts", "sql", "tests", "handoffs", ".github",
    "docs", "archive", "runbooks", "skills-for-code", "democracy", "deploy-checks",
    "forge-config", "otterquote-deploy", ".claude", "tools", "node_modules", ".netlify",
    ".git", "netlify.toml", "tools-e2e-test.txt", "package.json", "package-lock.json",
    ".gitignore", ".gitattributes", "_site",
}
INTERNAL_SUFFIXES = (".md", ".py", ".sh", ".toml", ".ts", ".tsx")
SERVED_TOP_LEVEL_DIRS = {"assets", "blog", "contractors", "css", "data", "guides", "img", "js", "locations", "twiml"}
# Root-level *.html pages are served by design (and item 3 proves every one is copied);
# every OTHER root file the build publishes is pinned here. A new root file that is not
# internal must be added deliberately; an internal one belongs in the netlify.toml denylist.
SERVED_TOP_LEVEL_FILES = {
    "_redirects", "admin-app.webmanifest", "admin-sw.js", "llms.txt",
    "partner-app.webmanifest", "partner-sw.js", "robots.txt", "sitemap.xml",
}
REQUIRED = [
    "index.html", "login.html", "start.html", "privacy.html", "terms.html",
    "js/auth.js", "js/config.js", "js/nav.js", "_redirects", "robots.txt", "sitemap.xml",
    "llms.txt", "partner-sw.js", "admin-sw.js", "partner-app.webmanifest", "admin-app.webmanifest",
    "contractors/index.html", "data/us-counties.json", "twiml/forward-voice.xml",
    "img/otter-icon-navy.png", "img/favicon.svg",
]

failures = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


def rmtree(path):
    shutil.rmtree(path, ignore_errors=True)


with open(os.path.join(REPO, "netlify.toml"), "rb") as fh:
    cfg = tomllib.load(fh)
BUILD = cfg["build"]["command"]
PUBLISH = cfg["build"].get("publish", ".")

# --- 6. publish consistency -------------------------------------------------
for ctx in ("staging", "deploy-preview"):
    got = cfg.get("context", {}).get(ctx, {}).get("publish")
    check(got == PUBLISH, "publish in [context.%s] (%r) == [build] publish (%r)" % (ctx, got, PUBLISH))
check(PUBLISH not in (".", "./", ""), "[build] publish is a dedicated directory, not the repo root (got %r)" % PUBLISH)
check("edge_functions" not in cfg["build"], "no [build] edge_functions override (default netlify/edge-functions relative to base)")
ignore_cmd = cfg["context"]["production"]["ignore"]
check("react-app/app/lib/attribution-core.ts" in ignore_cmd, "production ignore rule still carves out attribution-core.ts (builds on change)")

# --- temp copy of the working tree + synthetic traps -------------------------
tmp = tempfile.mkdtemp(prefix="gh2392-")
work = os.path.join(tmp, "repo")


def ignore_copy(d, names):
    return [n for n in names if n == ".git" and os.path.abspath(d) == REPO]


shutil.copytree(REPO, work, ignore=ignore_copy, symlinks=True)
if PUBLISH not in (".", ""):
    rmtree(os.path.join(work, PUBLISH))
traps = {
    ".git/HEAD": "ref: refs/heads/main\n", ".netlify/state.json": "{}", "node_modules/pkg/index.js": "x",
    "README.MD": "x", "Readme.md": "x", "Netlify/edge-functions/x.ts": "x", "NETLIFY/edge-functions/y.ts": "x",
    "REACT-APP/app/lib/attribution-core.ts": "x", "Supabase/config.toml": "x", "Scripts/a.PY": "x",
    "TOOLS/z.py": "x", "Netlify.Toml": "x", "blog/notes.md": "x", "js/tool.py": "x",
    "js/node_modules/m/i.js": "x", "extra-root-script.sh": "x",
}
for rel, body in traps.items():
    p = os.path.join(work, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        fh.write(body)

# js/config.js currently hardcodes its keys (no %%STRIPE_PK%% placeholder), so the sed is a
# no-op today. Plant a placeholder line in the temp copy so the injection mechanism itself
# stays proven for as long as the build command carries it.
with open(os.path.join(work, "js/config.js"), "a", encoding="utf-8") as fh:
    fh.write("\n// gh2392-injection-probe: %%STRIPE_PK%%\n")
src_cfg_before = open(os.path.join(work, "js/config.js"), encoding="utf-8").read()
check("%%STRIPE_PK%%" in src_cfg_before, "temp-copy source js/config.js carries a %%STRIPE_PK%% placeholder before the build")

# --- run the build under sh and bash -----------------------------------------
pub = os.path.join(work, PUBLISH)
for sh in ("sh", "bash"):
    if PUBLISH not in (".", ""):
        rmtree(pub)
    env = dict(os.environ, STRIPE_PK=DUMMY_KEY)
    r = subprocess.run([sh, "-c", BUILD], cwd=work, env=env, capture_output=True, text=True)
    check(r.returncode == 0, "build command exits 0 under `%s -c` (exit=%s)" % (sh, r.returncode))
    if r.returncode != 0:
        print(r.stdout[-2000:], r.stderr[-2000:])
        continue
    # idempotent: Netlify may reuse a cached checkout that already has the publish dir
    r2 = subprocess.run([sh, "-c", BUILD], cwd=work, env=dict(env), capture_output=True, text=True)
    check(r2.returncode == 0, "build command is re-runnable under `%s -c` (second run exit=%s)" % (sh, r2.returncode))
    src_now = open(os.path.join(work, "js/config.js"), encoding="utf-8").read()
    check(src_now == src_cfg_before, "[%s] source js/config.js unchanged by the build (injection happens in the copy)" % sh)

# --- 1. no internals, case-insensitive walk ---------------------------------
bad, paths = [], []
for base, dirs, files in os.walk(pub):
    for n in dirs + files:
        rel = os.path.relpath(os.path.join(base, n), pub)
        paths.append(rel)
        for seg in rel.split(os.sep):
            low = seg.lower()
            if low in INTERNAL_SEGMENTS or low.endswith(INTERNAL_SUFFIXES):
                bad.append(rel)
                break
check(not bad, "publish dir has no internal path segment (case-insensitive) [%d paths walked]%s" % (
    len(paths), "" if not bad else ": " + ", ".join(sorted(set(bad))[:15])))
check(len(paths) > 100, "publish dir is populated (%d paths)" % len(paths))

# --- 2. top-level shape ------------------------------------------------------
top = sorted(os.listdir(pub))
top_dirs = {n for n in top if os.path.isdir(os.path.join(pub, n))}
check(top_dirs == SERVED_TOP_LEVEL_DIRS, "top-level dirs == known served set; extra=%s missing=%s" % (
    sorted(top_dirs - SERVED_TOP_LEVEL_DIRS), sorted(SERVED_TOP_LEVEL_DIRS - top_dirs)))
top_files = {n for n in top if os.path.isfile(os.path.join(pub, n)) and not n.lower().endswith(".html")}
check(top_files == SERVED_TOP_LEVEL_FILES, "top-level non-.html files == known served set; extra=%s missing=%s" % (
    sorted(top_files - SERVED_TOP_LEVEL_FILES), sorted(SERVED_TOP_LEVEL_FILES - top_files)))
dot = [n for n in top if n.startswith(".")]
check(not dot, "no dotfiles/dot-dirs at publish root %s" % dot)

# --- 3. required files --------------------------------------------------------
for rel in REQUIRED:
    check(os.path.exists(os.path.join(pub, rel)), "required served path exists: %s" % rel)
cfgjs = ""
if os.path.exists(os.path.join(pub, "js/config.js")):
    cfgjs = open(os.path.join(pub, "js/config.js"), encoding="utf-8").read()
check(DUMMY_KEY in cfgjs and "%%STRIPE_PK%%" not in cfgjs, "publish js/config.js has the dummy STRIPE_PK injected and no placeholder left")
pub_red = os.path.join(pub, "_redirects")
check(os.path.exists(pub_red) and open(pub_red, "rb").read() == open(os.path.join(REPO, "_redirects"), "rb").read(),
      "publish _redirects is byte-identical to source")
src_html = sorted(n for n in os.listdir(REPO) if n.endswith(".html"))
missing_html = [n for n in src_html if not os.path.exists(os.path.join(pub, n))]
check(not missing_html, "every root *.html in the source is in the publish dir (%d files)%s" % (len(src_html), missing_html or ""))

# --- 4. referenced local paths that exist in source must exist in publish -----
REF_RE = re.compile(
    r"""(?:href|src|action|data-src|poster)\s*=\s*["']([^"'#?\s]+)|url\(\s*["']?([^"')#?\s]+)"""
    r"""|["'](/?[A-Za-z0-9_./-]+\.(?:html|js|css|png|jpg|jpeg|svg|webp|ico|json|xml|txt|webmanifest|woff2|mp4|pdf))["']""")
TEXT_EXT = (".html", ".js", ".css", ".webmanifest")
regress, nrefs = set(), 0
for base, _d, files in os.walk(pub):
    for f in files:
        if not f.lower().endswith(TEXT_EXT):
            continue
        fp = os.path.join(base, f)
        txt = open(fp, encoding="utf-8", errors="replace").read()
        for m in REF_RE.finditer(txt):
            ref = next(g for g in m.groups() if g)
            if re.match(r"^(?:[a-z][a-z0-9+.-]*:|//|\$|\{|%)", ref, re.I):
                continue
            if ref.startswith("/"):
                rel = ref.lstrip("/")
            else:
                rel = os.path.join(os.path.relpath(base, pub), ref)
            rel = os.path.normpath(rel)
            if rel.startswith("..") or rel == ".":
                continue
            nrefs += 1
            if os.path.exists(os.path.join(REPO, rel)) and not os.path.exists(os.path.join(pub, rel)):
                regress.add("%s -> %s" % (os.path.relpath(fp, pub), rel))
check(not regress, "no served file references a path that exists in source but is missing from publish (%d refs scanned)%s" % (
    nrefs, "" if not regress else ": " + "; ".join(sorted(regress)[:15])))

# --- 5. source tree untouched -------------------------------------------------
for rel in ("netlify/edge-functions/first-touch-attribution.ts", "netlify/edge-functions/admin-auth-gate.ts",
            "react-app/app/lib/attribution-core.ts", "netlify.toml", "supabase", "scripts"):
    check(os.path.exists(os.path.join(work, rel)), "source tree still has %s after the build" % rel)
check(open(os.path.join(work, "js/config.js"), encoding="utf-8").read() == src_cfg_before, "source js/config.js placeholder logic unchanged")

rmtree(tmp)
print()
if failures:
    print("FAILED: %d check(s)" % len(failures))
    sys.exit(1)
print("ALL PASS")
