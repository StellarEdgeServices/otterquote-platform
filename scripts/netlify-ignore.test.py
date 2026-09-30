#!/usr/bin/env python3
"""gh-2389: test the [context.production] ignore command in the ROOT netlify.toml.

Netlify semantics (docs.netlify.com/build/configure-builds/ignore-builds/):
  ignore command exit 0 = SKIP the build, exit 1 = BUILD.

This runs the EXACT command string from netlify.toml (extracted, not re-typed)
through `bash -c` inside a full-history checkout, with CACHED_COMMIT_REF /
COMMIT_REF set the way Netlify sets them, against real commit pairs from the
jade-alpaca-b82b5e production deploy history (CTO RUN 52 census, #2389), plus
guard cases (empty / equal / bogus refs must BUILD).

Usage (from a clone with full history, blobs optional):
    python3 scripts/netlify-ignore.test.py
Exit 0 = all cases behave as expected. Any wrong verdict prints FAIL and exits 1.
A commit missing from the local clone is reported as MISSING and fails the run
(fetch full history first) so a shallow clone can never silently pass.
"""
import os
import re
import subprocess
import sys

REPO = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip() or os.getcwd()
TOML = os.path.join(REPO, "netlify.toml")


def extract_ignore():
    text = open(TOML, encoding="utf-8").read()
    m = re.search(r"^\[context\.production\]\s*\n(?:#.*\n|\s*\n)*\s*ignore\s*=\s*\"((?:[^\"\\]|\\.)*)\"\s*$", text, re.M)
    if not m:
        sys.exit("FAIL: no `ignore = \"...\"` under [context.production] in netlify.toml")
    return re.sub(r"\\(.)", r"\1", m.group(1))  # TOML basic-string unescape (only \" is used)


IGNORE = extract_ignore()

# Sanity: the whole file must be valid TOML where a parser exists (Python >= 3.11).
try:
    import tomllib
    with open(TOML, "rb") as fh:
        cfg = tomllib.load(fh)
    assert cfg["context"]["production"]["ignore"] == IGNORE, "regex-extracted command != parsed TOML value"
    assert "ignore" not in cfg.get("build", {}), "[build] must not carry a global ignore (previews/branches stay unfiltered)"
except ImportError:
    pass


def verdict(cached, commit):
    env = dict(os.environ)
    env.pop("CACHED_COMMIT_REF", None)
    env.pop("COMMIT_REF", None)
    if cached is not None:
        env["CACHED_COMMIT_REF"] = cached
    if commit is not None:
        env["COMMIT_REF"] = commit
    r = subprocess.run(["bash", "-c", IGNORE], cwd=REPO, env=env, capture_output=True, text=True)
    return r.returncode


def have(sha):
    return subprocess.run(["git", "cat-file", "-e", sha + "^{commit}"], cwd=REPO, capture_output=True).returncode == 0


SKIP, BUILD = 0, 1
# (label, cached, commit, expected exit, what changed)
PAIRS = [
    ("SKIP  supabase-only",            "e11f7df7e894", "e33d859b166a", SKIP,  "supabase/functions + 3 migrations"),
    ("SKIP  .github + scripts",        "79a325d599c8", "318ef555c8f9", SKIP,  ".github/workflows/*.yml, scripts/*.txt"),
    ("SKIP  Docs md only",             "e9d733d70065", "54169ec5d437", SKIP,  "Docs/is-test-steering-queries.md"),
    ("SKIP  sql + supabase (5 files)", "ce3d1ff555d9", "b935c46d37f8", SKIP,  "sql/schema-pending.json + supabase/functions"),
    ("SKIP  tests only",               "b41b1b7e30e9", "7c8da07c2c56", SKIP,  "tests/e2e/package*.json"),
    ("BUILD negative control: HTML",   "e33d859b166a", "7b2eee6d48d8", BUILD, "blog/hail-damage-roof-inspection-first-72-hours.html"),
    ("BUILD root html + js",           "6b489e112688", "e559d5820d05", BUILD, "auth-callback.html, js/ga-gate.js"),
    ("EDGE  1 site file among excluded", "096b29702a75", "1e853b247d71", BUILD, "js/meta-pixel-gate.js + scripts/check-gtag-single-source.py"),
    ("EDGE  index.html + react-app",   "ebf2b70e877b", "103d393667c0", BUILD, "index.html + react-app/app/get-started/page.tsx"),
    ("EDGE  attribution-core.ts (edge import)", "d1dd000a^", "d1dd000a", BUILD, "react-app/app/auth-callback/page.tsx + react-app/app/lib/attribution-core.ts"),
    ("EDGE  attribution-core.ts only",   "6700c9df^", "6700c9df", BUILD, "react-app/app/lib/attribution-core.ts imported by first-touch-attribution.ts"),
    ("EDGE  tools/ (unlisted -> build)", "cc2f40408a04", "b66fd53d9a08", BUILD, "tools/partner_parity_check.py only"),
    ("EDGE  accumulated skip+build range", "e11f7df7e894", "7b2eee6d48d8", BUILD, "skipped supabase merge + later blog html accumulate"),
]
# Guard cases: whatever the refs, these must BUILD (exit 1).
GUARDS = [
    ("GUARD empty CACHED_COMMIT_REF",     "",  "7b2eee6d48d8"),
    ("GUARD CACHED_COMMIT_REF unset",     None, "7b2eee6d48d8"),
    ("GUARD CACHED == COMMIT (no-cache)", "e33d859b166a", "e33d859b166a"),
    ("GUARD bogus CACHED ref (diff fails)", "000000000000", "e33d859b166a"),
    ("GUARD bogus COMMIT ref (diff fails)", "e33d859b166a", "000000000000"),
]

# --- Import guard (gh-2389 REVIEW 5909666470 blocker 1) -----------------------
# Netlify bundles every file that netlify/edge-functions (and netlify/functions)
# import into the deployed site, wherever it lives. So a change to ANY such
# file must BUILD, even when it sits under an ignored tree (e.g. react-app/).
# This parses relative imports (transitively) under those dirs, then proves
# behaviourally, with the real ignore command, that touching each imported
# file yields BUILD. Synthetic tree objects are used (no commits, no working
# tree change): a temp index = HEAD tree with one imported file modified.
NETLIFY_DIRS = ["netlify/edge-functions", "netlify/functions"]
CODE_EXT = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".mts")
IMPORT_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}/[^"']+)["']""")


def imported_files():
    """Return {repo-relative imported path: importer} for relative imports reachable from NETLIFY_DIRS."""
    found, problems, queue, seen = {}, [], [], set()
    for d in NETLIFY_DIRS:
        root = os.path.join(REPO, d)
        for base, _dirs, files in os.walk(root):
            for f in files:
                if f.endswith(CODE_EXT):
                    queue.append(os.path.join(base, f))
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        src = open(path, encoding="utf-8", errors="replace").read()
        for spec in IMPORT_RE.findall(src):
            target = os.path.normpath(os.path.join(os.path.dirname(path), spec))
            rel = os.path.relpath(target, REPO).replace(os.sep, "/")
            if not os.path.isfile(target):
                problems.append("%s imports %s which does not resolve to a file" % (os.path.relpath(path, REPO), spec))
                continue
            if rel not in found:
                found[rel] = os.path.relpath(path, REPO).replace(os.sep, "/")
            if target.endswith(CODE_EXT):
                queue.append(target)
    return found, problems


def touch_verdict(ignore, rel):
    """Exit code of `ignore` for a synthetic change to file `rel` (0 skip / 1 build)."""
    tmp_index = os.path.join(REPO, ".git", "netlify-ignore-test.index")
    env = dict(os.environ, GIT_INDEX_FILE=tmp_index)
    def git(*a, **kw):
        return subprocess.run(["git"] + list(a), cwd=REPO, env=env, capture_output=True, text=True, **kw)
    try:
        base_tree = git("rev-parse", "HEAD^{tree}").stdout.strip()
        git("read-tree", base_tree)
        content = open(os.path.join(REPO, rel), "rb").read() + b"\n// netlify-ignore.test synthetic change\n"
        blob = subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=REPO, input=content, capture_output=True).stdout.decode().strip()
        git("update-index", "--cacheinfo", "100644,%s,%s" % (blob, rel))
        new_tree = git("write-tree").stdout.strip()
    finally:
        if os.path.exists(tmp_index):
            os.remove(tmp_index)
    if not (base_tree and blob and new_tree) or base_tree == new_tree:
        return None
    e = dict(os.environ, CACHED_COMMIT_REF=base_tree, COMMIT_REF=new_tree)
    return subprocess.run(["bash", "-c", ignore], cwd=REPO, env=e, capture_output=True, text=True).returncode


def import_guard(ignore):
    """Return list of failure strings (empty = every imported file BUILDs)."""
    imports, problems = imported_files()
    bad = list(problems)
    for rel, importer in sorted(imports.items()):
        v = touch_verdict(ignore, rel)
        if v != BUILD:
            bad.append("%s (imported by %s) would be SKIPPED (exit=%s): add a carve-out" % (rel, importer, v))
    return bad, imports


failed = 0
print("ignore command under test:\n  " + IGNORE + "\n")
for label, a, b, want, what in PAIRS:
    if not (have(a) and have(b)):
        print("MISSING %-36s commit not in clone (need full history)" % label)
        failed += 1
        continue
    got = verdict(a, b)
    ok = got == want
    failed += 0 if ok else 1
    print("%s %-38s exit=%d (%s) want=%d  [%s]" % ("ok  " if ok else "FAIL", label, got, "skip" if got == 0 else "build", want, what))
for label, a, b in GUARDS:
    got = verdict(a, b)
    ok = got == BUILD
    failed += 0 if ok else 1
    print("%s %-38s exit=%d (%s) want=1" % ("ok  " if ok else "FAIL", label, got, "skip" if got == 0 else "build"))
bad, imports = import_guard(IGNORE)
for rel, importer in sorted(imports.items()):
    print("%s %-38s imported by %s" % ("FAIL" if any(b.startswith(rel + " ") for b in bad) else "ok  ", "IMPORT " + os.path.basename(rel), importer))
for b in bad:
    print("FAIL IMPORT-GUARD " + b)
failed += len(bad)
if not imports:
    print("FAIL IMPORT-GUARD found no imports under netlify/ (parser broken?)")
    failed += 1
# Negative control: the same guard against the command WITHOUT the carve-out must FAIL.
nocarve = re.sub(r'git diff --quiet "\$CACHED_COMMIT_REF" "\$COMMIT_REF" -- react-app/[^&]*&& ', "", IGNORE)
if nocarve == IGNORE:
    print("FAIL IMPORT-GUARD negative control: could not strip carve-out from the command")
    failed += 1
else:
    nbad, _ = import_guard(nocarve)
    ok = any("attribution-core.ts" in b for b in nbad)
    failed += 0 if ok else 1
    print("%s IMPORT-GUARD negative control (carve-out removed => guard must flag attribution-core.ts): %d flagged" % ("ok  " if ok else "FAIL", len(nbad)))

print("\n%s: %d failing" % ("PASS" if not failed else "FAIL", failed))
sys.exit(1 if failed else 0)
