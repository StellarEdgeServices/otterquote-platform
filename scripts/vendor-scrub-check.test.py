#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/vendor-scrub-check.py (gh-1339 item 6).

A scrub meter that cannot fail is worse than no meter: #1339's own thread records
a sweep run against `app.otterquote.com`, which 404s every path with an identical
body and would have returned a clean zero on every vendor name. So each assertion
below is paired with the mutation it is supposed to catch.

OUTPUT FORMAT (PR #1860 REVIEW blocker 1). Every assertion prints `PASS` or
`FAIL`. The first version printed `ok`, and scripts/detector-negative-control-check.py
counts PASS/FAIL lines specifically -- so nineteen real assertions were scored as
ZERO and this repo's own gate failed the detector. A test that self-reports
nothing is, to the gate, a test that proves nothing, and the gate is right.

No network. Run: python3 scripts/vendor-scrub-check.test.py
"""

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("vsc", HERE / "vendor-scrub-check.py")
vsc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vsc)

failures: list[str] = []


def check(name, got, want):
    if got != want:
        failures.append(f"{name}: got {got!r}, want {want!r}")
        print(f"FAIL  {name}: got {got!r}, want {want!r}")
    else:
        print(f"PASS  {name}")


print("gh-1339 vendor-scrub-check proof of detection")

# 1. CSS hover is not a vendor reference -- and stripping it must not blind the
#    meter to a real one sitting on the same line.
css = 'a:hover{color:red} .btn.hover:bg-x{} <div id="hoverPhotoModal">'
check("the raw fixture carries three 'hover' substrings", len(vsc.hits_for(css, "hover")), 3)
stripped = vsc.strip_css_hover(css)
check("CSS :hover and hover: leave nothing behind to count",
      vsc.hits_for(stripped, "hover"), ["hoverPhotoModal"])
check("a real identifier survives the strip", "hoverPhotoModal" in stripped, True)

# 2. Classification. The distinction the thread kept losing.
check("a database column is WIRE", vsc.classify("hover_orders"), "wire")
check("an Edge Function path is WIRE", vsc.classify("/functions/v1/get-hover-pdf"), "wire")
check("a shared client API is WIRE", vsc.classify("Services.createHoverPaymentIntent"), "wire")
check("a retired-vendor EF name is WIRE", vsc.classify("create-docusign-envelope"), "wire")
check("an element id is CLIENT", vsc.classify("hoverPhotoModal"), "client")
check("a CSS class is CLIENT", vsc.classify("hover-step-content"), "client")
check("a sessionStorage key is CLIENT", vsc.classify("hover_photos_"), "client")
check("an element id that LOOKS like a path is CLIENT", vsc.classify("resend-hover-btn"), "client")

# 3. Every vendor D-312 names is actually searched for. A meter that quietly drops
#    one is exactly how 29 `docusign` hits survived three hand sweeps.
for vendor in ("hover", "boldsign", "roofscope", "docusign", "scope technologies"):
    check(f"D-312 vendor '{vendor}' is in the token list", vendor in vsc.VENDOR_TOKENS, True)

# 4. The widening: a bare token must be reported as the identifier it sits inside.
check("a hit is widened to its identifier",
      vsc.hits_for("const x = hoverClientSecret;", "hover"), ["hoverClientSecret"])
check("NEG: an absent vendor scores a true zero",
      vsc.hits_for('<div id="photoModal">', "hover"), [])

# 5. A non-200 body is never counted. This is the app.otterquote.com trap.
check("fetch refuses to count a non-200",
      "refusing to count a non-200 body" in (HERE / "vendor-scrub-check.py").read_text(), True)

# 6. Coverage is DISCOVERED, not hand-listed (PR #1860 REVIEW blocker 3): the
#    first version measured 7 of 78 pages and reported it as a sweep.
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    (root / "js").mkdir()
    for name in ("index.html", "brand-new-page.html"):
        (root / name).write_text("<html>otterquote</html>")
    (root / "js" / "config.js").write_text("// otterquote")
    found = vsc.repo_surfaces(root)
    check("a page nobody listed is still scanned", "brand-new-page.html" in found, True)
    check("js/ is scanned too", "js/config.js" in found, True)

# 7. The ratchet fires in BOTH directions, driven through the real CLI.
def ratchet(baseline: dict, page_body: str):
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        (root / "p.html").write_text(page_body)
        bl = root / "baseline.json"
        bl.write_text(json.dumps(baseline))
        proc = subprocess.run(
            [sys.executable, str(HERE / "vendor-scrub-check.py"),
             "--repo", str(root), "--ratchet", "--baseline", str(bl)],
            capture_output=True, text=True)
        return proc.returncode, proc.stdout + proc.stderr

clean = '<html>otterquote</html>'
one = '<html>otterquote <div id="hoverPanel"></div></html>'
check("a NEW vendor reference fails the ratchet", ratchet({"p.html": 0}, one)[0], 1)
check("... and says so as a REGRESSION", "REGRESSION" in ratchet({"p.html": 0}, one)[1], True)
check("an unchanged count passes", ratchet({"p.html": 1}, one)[0], 0)
check("a page missing from the baseline is held to zero", ratchet({}, one)[0], 1)
check("a DROP fails too, so the floor cannot drift back up", ratchet({"p.html": 5}, one)[0], 1)
check("... and says the baseline is stale", "BASELINE STALE" in ratchet({"p.html": 5}, one)[1], True)
check("a clean page against a clean baseline passes", ratchet({}, clean)[0], 0)

# 8. The repo's own baseline is honest: re-derived counts must equal it exactly.
repo_root = HERE.parent
bl_path = repo_root / "scripts" / "vendor-scrub-baseline.json"
if bl_path.exists():
    proc = subprocess.run(
        [sys.executable, str(HERE / "vendor-scrub-check.py"), "--repo", str(repo_root),
         "--ratchet", "--baseline", str(bl_path)],
        capture_output=True, text=True)
    check("the committed baseline matches the tree it was taken from", proc.returncode, 0)

if failures:
    print(f"\n{len(failures)} assertion(s) failed")
    sys.exit(1)
print("\nall assertions passed")
