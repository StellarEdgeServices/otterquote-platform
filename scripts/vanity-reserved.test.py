#!/usr/bin/env python3
"""P18 (#3232): CI guard that a partner's otterquote.com/<slug> can never shadow a path the site serves.

Fails if any served top-level path is missing from the reserved_slugs seed. "Served top-level path" is exactly what the generator
from PR #3223 computes (scripts/p18-reserved-slugs.py): every top-level repo file/folder, every top-level react-app route, and
the first segment of every _redirects / netlify.toml source. This test REUSES that generator (it does not reimplement it) and
compares its output with the INSERT INTO public.reserved_slugs block of the p18_vanity_slug_data migration, found in
supabase/migrations_drafts/ or, once applied and filed, supabase/migrations/.

PREFIX ROUTES (REVIEW: FAIL 6524261593): a route that matches a whole name prefix (`_redirects` `/get-started*`, a netlify.toml `from =
"/foo*"`, an edge-function `pattern: '^/[Aa][Dd][Mm][Ii][Nn]-.*$'`) never 404s, so vanity-redirect never sees a slug under it and a
partner who claimed one would never be credited. Exact names in the seed do not cover them, so every such prefix must also have a
`lower(s) LIKE '<prefix>%'` rule in the body of p18_slug_is_reserved (same file). Edge-function patterns are reduced to their literal
leading prefix with `[Aa]`-style case classes folded. Negative control: a synthetic `/foo*` source must be flagged.

Names refused by the `home-` pattern rule in the database are not in the seed by design (the generator already drops them).

DEPENDS ON PR #3223: the generator and the seed file arrive with it. Before that merges this test fails with a clear message
rather than passing vacuously.

Run from the repo root: python3 scripts/vanity-reserved.test.py
Negative controls run first: the same comparison must flag a tree with an extra served path and a seed with a row removed.
"""
import glob
import importlib.util
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEN = ROOT / "scripts" / "p18-reserved-slugs.py"
SEED_GLOBS = ("supabase/migrations_drafts/p18_vanity_slug_data.sql", "supabase/migrations/*p18_vanity_slug_data*.sql")


def load_generator():
    if not GEN.is_file():
        sys.exit("FAIL: scripts/p18-reserved-slugs.py is missing. It arrives with PR #3223 (P18 data layer); this test depends on it.")
    spec = importlib.util.spec_from_file_location("p18_reserved_slugs", GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def find_seed_file():
    for g in SEED_GLOBS:
        hits = sorted(glob.glob(str(ROOT / g)))
        hits = [h for h in hits if not h.endswith("_rollback.sql")]
        if hits:
            return Path(hits[0])
    sys.exit("FAIL: the reserved_slugs seed (p18_vanity_slug_data.sql) is missing from supabase/migrations_drafts/ and supabase/migrations/. It arrives with PR #3223.")


def parse_seed(text):
    m = re.search(r"INSERT\s+INTO\s+public\.reserved_slugs\s*\(slug\)\s*VALUES(.*?)ON\s+CONFLICT", text, re.S | re.I)
    if not m:
        sys.exit("FAIL: could not find the INSERT INTO public.reserved_slugs ... VALUES block in the seed file.")
    return {s.lower() for s in re.findall(r"\(\s*'((?:[^']|'')*)'\s*\)", m.group(1))}


def reserved_fn_prefixes(text):
    """LIKE '<prefix>%' rules in the body of p18_slug_is_reserved (lower-cased)."""
    m = re.search(r"FUNCTION\s+public\.p18_slug_is_reserved\b.*?\$fn\$(.*?)\$fn\$", text, re.S | re.I)
    if not m:
        sys.exit("FAIL: could not find the p18_slug_is_reserved body in the seed file.")
    return {x.lower() for x in re.findall(r"LIKE\s+'([^'%]+)%'", m.group(1), re.I)}


def toml_and_redirect_prefixes(redirects_text, toml_text):
    """First path segments ending in `*` (e.g. /get-started*, /foo*) on otterquote.com sources: returns {prefix: where}."""
    found = {}
    def add(path, where):
        path = re.sub(r"^https?://(www\.)?otterquote\.com(?=/)", "", path.strip())
        if not path.startswith("/"):
            return  # other hosts (stellaredgeservices.com, netlify.app) do not serve otterquote.com/<slug>
        seg = path.lstrip("/").split("/")[0].split("?")[0].split("#")[0]
        if seg.endswith("*") and len(seg) > 1 and "*" not in seg[:-1]:
            found[seg[:-1].lower()] = where
    for line in redirects_text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            add(line.split()[0], "_redirects: " + line.split()[0])
    for m in re.finditer(r'^\s*from\s*=\s*"([^"]+)"', toml_text, re.M):
        add(m.group(1), "netlify.toml: " + m.group(1))
    return found


def literal_prefix(pattern):
    """Literal leading name prefix of an edge-function regex like ^/[Aa][Dd]min-.*$ ; None when the name is closed ('/', '$', '\\.')."""
    if not pattern.startswith("^/"):
        return None
    i, out, n = 2, "", len(pattern)
    while i < n:
        c = pattern[i]
        cls = re.match(r"\[([A-Za-z])([A-Za-z])\]", pattern[i:])
        if cls and cls.group(1).lower() == cls.group(2).lower():
            out += cls.group(1).lower(); i += 4; continue
        if re.match(r"[A-Za-z0-9-]", c):
            out += c.lower(); i += 1; continue
        # first non-literal char: only an open-ended continuation makes this a PREFIX route
        return out if out and c in ".*+([\\" and not pattern[i:].startswith("\\.") else None
    return None


def edge_pattern_prefixes(ts_sources):
    """ts_sources: {path: text}. Returns {prefix: where} for `pattern: '^/...'` / `pattern = '^/...'` declarations."""
    found = {}
    for where, text in ts_sources.items():
        for m in re.finditer(r"""^[ \t]*pattern\s*[:=]\s*(['"])(\^/.*?)\1""", text, re.M):
            pre = literal_prefix(m.group(2))
            if pre:
                found[pre] = "%s: %s" % (where, m.group(2))
    return found


def prefixes_without_rule(required, rules):
    return sorted((p, w) for p, w in required.items() if not any(p.startswith(r) for r in rules))


def missing_from_seed(served, seed):
    return sorted(s for s in served if s.lower() not in seed)


def main():
    gen = load_generator()
    seed_file = find_seed_file()
    seed = parse_seed(seed_file.read_text(encoding="utf-8"))
    if len(seed) < 50:
        sys.exit("FAIL: parsed only %d seed rows from %s; the parser or the file is broken." % (len(seed), seed_file))

    served = gen.collect(str(ROOT))
    if len(served) < 50:
        sys.exit("FAIL: the generator returned only %d served paths; the generator is broken." % len(served))

    # Negative control 1: a tree with an extra served top-level file must be flagged.
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "brand-new-page.html").write_text("x")
        extra = gen.collect(td, names=["brand-new-page.html"])
        if missing_from_seed(extra, seed) != ["brand-new-page"]:
            sys.exit("FAIL (negative control): an unseeded served path was not detected.")
    # Negative control 2: removing a seed row must be flagged.
    victim = "faq" if "faq" in seed else sorted(seed)[0]
    if victim not in missing_from_seed(served, seed - {victim}):
        sys.exit("FAIL (negative control): a removed seed row was not detected.")

    # Prefix routes (see the module docstring).
    rules = reserved_fn_prefixes(seed_file.read_text(encoding="utf-8"))
    required = {}
    required.update(toml_and_redirect_prefixes((ROOT / "_redirects").read_text(encoding="utf-8", errors="replace"),
                                               (ROOT / "netlify.toml").read_text(encoding="utf-8", errors="replace")))
    srcs = {str(f.relative_to(ROOT)): f.read_text(encoding="utf-8", errors="replace") for f in sorted((ROOT / "netlify" / "edge-functions").glob("*.ts"))}
    srcs["netlify.toml"] = (ROOT / "netlify.toml").read_text(encoding="utf-8", errors="replace")
    required.update(edge_pattern_prefixes(srcs))
    # Parser sanity: the prefixes known today must be found, or the parser is broken.
    for known in ("get-started", "the-ashes", "admin-"):
        if known not in required:
            sys.exit("FAIL: prefix parser did not find the known prefix route %r; the parser is broken." % known)
    # Negative controls: a synthetic /foo* source and a synthetic edge pattern must be flagged; a covered one must not.
    fake = toml_and_redirect_prefixes("/foo* /bar 301\n", "")
    if prefixes_without_rule(fake, rules) != [("foo", "_redirects: /foo*")]:
        sys.exit("FAIL (negative control): an unreserved /foo* source was not flagged.")
    fake_e = edge_pattern_prefixes({"x.ts": "  pattern: '^/[Zz][Zz]-.*$',\n"})
    if [p for p, _ in prefixes_without_rule(fake_e, rules)] != ["zz-"]:
        sys.exit("FAIL (negative control): an unreserved edge-function pattern prefix was not flagged.")
    bad_prefix = prefixes_without_rule(required, rules)

    missing = missing_from_seed(served, seed)
    if bad_prefix:
        print("FAIL: %d prefix route(s) have no `LIKE '<prefix>%%'` rule in p18_slug_is_reserved (%s):" % (len(bad_prefix), seed_file.relative_to(ROOT)))
        for p, w in bad_prefix:
            print("  - %s*   (%s)" % (p, w))
        print("These routes never 404, so a partner slug under them could never be credited. Add the prefix rule.")
        if not missing:
            sys.exit(1)
    if missing:
        print("FAIL: %d served top-level path(s) are not in the reserved_slugs seed (%s):" % (len(missing), seed_file.relative_to(ROOT)))
        for s in missing:
            print("  - " + s)
        print("A partner could claim one of these and shadow the real page. Add it to the seed (a new migration; reserved_slugs is append-only in practice) before merging.")
        sys.exit(1)
    if bad_prefix:
        sys.exit(1)
    print("OK: all %d served top-level paths are reserved plus %d prefix routes (seed has %d rows, from %s); negative controls detected." % (len(served), len(required), len(seed), seed_file.relative_to(ROOT)))


if __name__ == "__main__":
    main()
