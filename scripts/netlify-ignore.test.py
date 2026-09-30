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
    ("SKIP  supabase-only",            "e11f7df7e8942088cf49a5b0422938959008e240", "e33d859b166ab7c3d3dce3211033a5b92061273c", SKIP,  "supabase/functions + 3 migrations"),
    ("SKIP  .github + scripts",        "79a325d599c8ddb2b90894d327a50bb8951776e2", "318ef555c8f9d5e0fac7f0f9782ce03813e112f4", SKIP,  ".github/workflows/*.yml, scripts/*.txt"),
    ("SKIP  Docs md only",             "e9d733d70065a2ad04a09036b912179c40b1692a", "54169ec5d4377166a2f961f8b6f55d6418a07815", SKIP,  "Docs/is-test-steering-queries.md"),
    ("SKIP  sql + supabase (5 files)", "ce3d1ff555d9c7ef42d65a0b1b36a6f6aa088b02", "b935c46d37f89558e0f72bb4256476c245610e9c", SKIP,  "sql/schema-pending.json + supabase/functions"),
    ("SKIP  tests only",               "b41b1b7e30e9263a98c5d0baa3fee55a3024165f", "7c8da07c2c566c56d7d5554df5636caf0f5bd49f", SKIP,  "tests/e2e/package*.json"),
    ("BUILD negative control: HTML",   "e33d859b166ab7c3d3dce3211033a5b92061273c", "7b2eee6d48d878e8718e223ee1a4d51e15eb079d", BUILD, "blog/hail-damage-roof-inspection-first-72-hours.html"),
    ("BUILD root html + js",           "6b489e1126888b6fe4912b43a5976dc98359e276", "e559d5820d051769652cc5bd6fffc11aeb1d4496", BUILD, "auth-callback.html, js/ga-gate.js"),
    ("EDGE  1 site file among excluded", "096b29702a7501badc3de2d64026dd5b3f8e276a", "1e853b247d7132038754e0edf590127577fc6677", BUILD, "js/meta-pixel-gate.js + scripts/check-gtag-single-source.py"),
    ("EDGE  index.html + react-app",   "ebf2b70e877bb414953827939745ddffe0a9de58", "103d393667c027f674429538d3143d23490a4387", BUILD, "index.html + react-app/app/get-started/page.tsx"),
    ("EDGE  tools/ (unlisted -> build)", "cc2f40408a043850d123e58c7057cce684e763b8", "b66fd53d9a08c5c9d5e1deac9a0bababcf0ee095", BUILD, "tools/partner_parity_check.py only"),
    ("EDGE  accumulated skip+build range", "e11f7df7e8942088cf49a5b0422938959008e240", "7b2eee6d48d878e8718e223ee1a4d51e15eb079d", BUILD, "skipped supabase merge + later blog html accumulate"),
]
# Guard cases: whatever the refs, these must BUILD (exit 1).
GUARDS = [
    ("GUARD empty CACHED_COMMIT_REF",     "",  "7b2eee6d48d878e8718e223ee1a4d51e15eb079d"),
    ("GUARD CACHED_COMMIT_REF unset",     None, "7b2eee6d48d878e8718e223ee1a4d51e15eb079d"),
    ("GUARD CACHED == COMMIT (no-cache)", "e33d859b166ab7c3d3dce3211033a5b92061273c", "e33d859b166ab7c3d3dce3211033a5b92061273c"),
    ("GUARD bogus CACHED ref (diff fails)", "0000000000000000000000000000000000000001", "e33d859b166ab7c3d3dce3211033a5b92061273c"),
    ("GUARD bogus COMMIT ref (diff fails)", "e33d859b166ab7c3d3dce3211033a5b92061273c", "0000000000000000000000000000000000000002"),
]

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
print("\n%s: %d failing" % ("PASS" if not failed else "FAIL", failed))
sys.exit(1 if failed else 0)
