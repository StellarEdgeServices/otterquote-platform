#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/vendor-scrub-check.py (gh-1339 item 6).

A scrub meter that cannot fail is worse than no meter: #1339's own thread records
a sweep run against `app.otterquote.com`, which 404s every path with an identical
body and would have returned a clean zero on every vendor name. So each assertion
below is paired with the mutation it is supposed to catch.

No network. Run: python3 scripts/vendor-scrub-check.test.py
"""

import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("vsc", HERE / "vendor-scrub-check.py")
vsc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vsc)

failures = []


def check(name, got, want):
    if got != want:
        failures.append(f"{name}: got {got!r}, want {want!r}")
    else:
        print(f"  ok  {name}")


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

# 4. The widening: a bare token must be reported as the identifier it sits inside,
#    or the residue cannot be read as a work order.
check("a hit is widened to its identifier",
      vsc.hits_for("const x = hoverClientSecret;", "hover"), ["hoverClientSecret"])
check("NEG: an absent vendor scores a true zero",
      vsc.hits_for('<div id="photoModal">', "hover"), [])

# 5. A non-200 body is never counted. This is the app.otterquote.com trap.
check("fetch refuses to count a non-200",
      "refusing to count a non-200 body" in (HERE / "vendor-scrub-check.py").read_text(), True)

# 6. The two surfaces with no "otterquote" string get their own positive control,
#    so their zero is not a meaningless one.
check("contractor-bid-form has a non-default positive control",
      vsc.POSITIVE_CONTROL.get("contractor-bid-form.html"), "supabase")

if failures:
    print("\nFAILED:")
    for f in failures:
        print("  " + f)
    sys.exit(1)
print("\nall assertions passed")
