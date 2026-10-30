#!/usr/bin/env python3
"""P18 (#3232): CI guard that a partner's otterquote.com/<slug> can never shadow a path the site serves.

Fails if any served top-level path is missing from the reserved_slugs seed. "Served top-level path" is exactly what the generator
from PR #3223 computes (scripts/p18-reserved-slugs.py): every top-level repo file/folder, every top-level react-app route, and
the first segment of every _redirects / netlify.toml source. This test REUSES that generator (it does not reimplement it) and
compares its output with the INSERT INTO public.reserved_slugs block of the p18_vanity_slug_data migration, found in
supabase/migrations_drafts/ or, once applied and filed, supabase/migrations/.

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

    missing = missing_from_seed(served, seed)
    if missing:
        print("FAIL: %d served top-level path(s) are not in the reserved_slugs seed (%s):" % (len(missing), seed_file.relative_to(ROOT)))
        for s in missing:
            print("  - " + s)
        print("A partner could claim one of these and shadow the real page. Add it to the seed (a new migration; reserved_slugs is append-only in practice) before merging.")
        sys.exit(1)
    print("OK: all %d served top-level paths are reserved (seed has %d rows, from %s); negative controls detected." % (len(served), len(seed), seed_file.relative_to(ROOT)))


if __name__ == "__main__":
    main()
