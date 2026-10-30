#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/p18-reserved-slugs.py (P18, #3218), the house pattern (sibling <name>.test.py, PASS/FAIL lines,
exit 0 only if all pass; see scripts/detector-negative-control-check.py CHECK 1).

Builds a fixture tree and feeds it to the real generator:
  - positive: root file, root folder, a React top-level route, a route inside a "(group)", a _redirects source, a netlify.toml source.
  - NEGATIVE CONTROLS: the old root-only generator (names only) misses the React route and the redirect sources, which is exactly the
    defect found in review (`refer`, `oq-crm`, `inspector-landing`); a "_" / "[" segment and a folder with no page are NOT reserved;
    a `home-` name is kept out of the seed (pattern rule instead).
Run: python scripts/p18-reserved-slugs.test.py
"""
import importlib.util
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("p18_reserved_slugs", HERE / "p18-reserved-slugs.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

fails = 0


def check(cond, msg):
    global fails
    if cond:
        print("PASS " + msg)
    else:
        fails += 1
        print("FAIL " + msg)


with tempfile.TemporaryDirectory() as td:
    root = pathlib.Path(td)
    (root / "index.html").write_text("x")
    (root / "Partner-Thing.html").write_text("x")
    (root / "somefolder").mkdir()
    (root / "home-zzz.html").write_text("x")
    app = root / "react-app" / "app"
    for rel in ("refer/page.tsx", "(grp)/bids/page.tsx", "(grp)/_shell/page.tsx", "_private/page.tsx", "[id]/page.tsx",
                "components/button.tsx", "api/thing/route.ts", "test/a.test.ts"):
        f = app / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("x")
    (root / "_redirects").write_text("# c\n/oq-crm.html /x 301\n/get-started* /y 200\nhttps://otterquote.com/the-ashes* /z 301\n"
                                     "https://stellaredgeservices.com/* /q 301\n\n/inspector-landing.html /w 301\n")
    (root / "netlify.toml").write_text('[[redirects]]\n  from = "/democracy/*"\n  to = "/404"\n[[redirects]]\n  from = "/*.md"\n'
                                       '[[edge_functions]]\n  path = "/edge-only"\n  function = "x"\n'        # gh-3237
                                       '[[edge_functions]]\n  path = "/*"\n  function = "y"\n'
                                       "[[edge_functions]]\n  pattern = '^/[Zz][Zz]-.*$'\n  function = \"z\"\n")

    full = set(mod.collect(str(root), names=["index.html", "Partner-Thing.html", "somefolder", "home-zzz.html"]))
    # the pre-review generator: root names + EXTRA only (React routes and redirect sources switched off)
    real = (mod.react_routes, mod.redirect_sources, mod.edge_function_paths)
    mod.react_routes = lambda r: set()
    mod.redirect_sources = lambda r: set()
    mod.edge_function_paths = lambda r: set()
    try:
        rootonly = set(mod.collect(str(root), names=["index.html", "Partner-Thing.html", "somefolder"]))
    finally:
        mod.react_routes, mod.redirect_sources, mod.edge_function_paths = real

    check({"index", "partner-thing", "somefolder"} <= full, "root files and folders are reserved (.html stripped, lower-cased)")
    check("refer" in full, "React top-level route `refer` is reserved")
    check("bids" in full, "React route inside a (group) is reserved as a top-level route")
    check("api" in full, "React route.ts folder is reserved")
    check({"oq-crm", "inspector-landing"} <= full, "_redirects source paths are reserved (oq-crm, inspector-landing)")
    check("democracy" in full, "netlify.toml `from` first segment is reserved")
    check("get-started" in full and "the-ashes" in full, "_redirects wildcard and absolute-host sources are reserved")
    check("the-ashes" in full and "admin" in full, "the CEO's named EXTRA list is included")
    # negative controls
    check("refer" not in rootonly and "oq-crm" not in rootonly, "NEGATIVE CONTROL: the old root-only generator misses `refer` and `oq-crm` (the review defect)")
    check("_private" not in full and "_shell" not in full and "[id]" not in full and "id" not in full, "NEGATIVE CONTROL: `_` and `[` segments are not reserved")
    check("components" not in full and "test" not in full, "NEGATIVE CONTROL: a folder with no page/route file is not reserved")
    check("*.md" not in full and "stellaredgeservices.com" not in full, "NEGATIVE CONTROL: wildcard-only and other-host redirect sources are not reserved")
    check(not any(s.startswith("home-") for s in full), "a `home-` name is kept out of the seed (refused by the pattern rule instead)")
    check("edge-only" in full, "gh-3237: an exact netlify.toml edge-function `path` (like /ref-bind) is reserved")
    check("edge-only" not in rootonly, "gh-3237 NEGATIVE CONTROL: without the edge-function source the /edge-only path is missed (the /ref-bind defect)")
    check("zz-" not in full and "" not in full, "gh-3237 NEGATIVE CONTROL: a wildcard-only edge path and a regex `pattern` add no seed row (prefix rules cover patterns)")

sys.exit(1 if fails else 0)
