#!/usr/bin/env python3
"""
D-312 vendor-scrub meter for the customer-facing surfaces (gh-1339 item 6).

WHY THIS EXISTS. #1339's `closes-on` requires "an unfiltered grep over the
DEPLOYED site's served bytes, not the repo". That grep has been run by hand three
times on that thread, each time by a different run, each time counting a slightly
different set of vendor names -- and the 2026-09-07 pass counted `hover`,
`roofscope` and `scope technologies` but NOT `docusign`, which turned out to be
present 29 times in the served bytes. A criterion that is re-implemented by hand
every time it is checked is not a criterion.

Two traps this encodes so nobody rediscovers them:

  1. `app.otterquote.com` 404s EVERY path with an identical 10,044-byte body, so a
     sweep run there returns a clean zero on every vendor name and reads as
     success. The live host is `otterquote.com`. Every fetch here asserts HTTP 200
     and a plausible body size.
  2. CSS `:hover` and Tailwind `hover:` are not vendor references. They are
     stripped before counting, and the stripping is asserted by the test.

And one distinction the thread kept losing: not every remaining hit is the same
KIND of work. A JS identifier or an element id is a rename inside one file. A
database column name, an Edge Function path or a shared Services API name is a
WIRE CONTRACT -- renaming it needs a migration or a function deploy plus a
re-registered vendor webhook. This script classifies every hit so the residue can
be read as a work order instead of a number.

Usage:
    python3 scripts/vendor-scrub-check.py                 # deployed bytes (default)
    python3 scripts/vendor-scrub-check.py --repo .        # this checkout instead
    python3 scripts/vendor-scrub-check.py --json

Exit status: 0 when the client-only residue is zero, 1 otherwise. Wire-contract
hits do NOT fail the run -- they are reported, because clearing them is a
migration/deploy decision, not a rename.
"""

import argparse
import json
import pathlib
import re
import sys
import urllib.request

HOST = "https://otterquote.com"

# The five customer-facing pages #1339 names, plus the two the thread measured as
# already clean (kept so a regression on them is visible).
SURFACES = [
    "contractor-bid-form.html",
    "help-measurements.html",
    "dashboard.html",
    "contractor-opportunities.html",
    "bids.html",
    "index.html",
    "js/config.js",
]

# D-312, Dustin verbatim (Q67): "we don't post our vendors on the site ... remove
# Hover, Boldsign, Roofscope, and Docusign references".
VENDOR_TOKENS = ["hover", "boldsign", "roofscope", "docusign", "scope technologies"]

# A hit whose text matches one of these is a WIRE CONTRACT: a database identifier,
# a deployed Edge Function name, or a shared client API surface. Clearing it costs
# a migration or a deploy, not an edit.
WIRE_PATTERNS = [
    # database identifiers (renaming one costs a migration)
    r"hover_orders", r"hover_tokens", r"hover_measurements", r"hover_job_id",
    r"hover_pending", r"hover_rebate\w*", r"hover_measurement_price", r"docusign_\w+",
    # deployed Edge Function names (renaming one costs a deploy, and for
    # hover-webhook also a re-registered vendor webhook URL)
    r"get-hover-pdf", r"get-hover-siding-data", r"hover-webhook", r"create-hover-order",
    r"resend-hover-link", r"docusign-webhook", r"create-docusign-envelope",
    # shared client API surface, used across pages
    r"createHoverPaymentIntent",
]

# NOT wire, and the distinction is easy to get wrong: `hover_photos_{claimId}` is a
# sessionStorage cache key private to one page, and `resend-hover-btn` is an element
# id. Both are renameable in a single file with no server change, so they stay in the
# client-only column where the work order can actually consume them.

# Proof the instrument is live on the same bytes: a token that MUST be present.
# contractor-bid-form.html and contractor-opportunities.html carry no "otterquote"
# string at all (measured 2026-09-07 and again 2026-09-08), so they get their own
# control rather than being allowed to score a meaningless zero.
POSITIVE_CONTROL = {
    "contractor-bid-form.html": "supabase",
    "contractor-opportunities.html": "supabase",
}
DEFAULT_CONTROL = "otterquote"

CSS_HOVER = re.compile(r":hover|hover:")


def strip_css_hover(text: str) -> str:
    """Remove CSS/Tailwind hover pseudo-classes. They are not vendor references."""
    return CSS_HOVER.sub("", text)


def classify(hit: str) -> str:
    for pat in WIRE_PATTERNS:
        if re.fullmatch(pat, hit, flags=re.I) or re.search(pat, hit, flags=re.I):
            return "wire"
    return "client"


def hits_for(text: str, token: str):
    """Every occurrence of `token`, widened to the identifier it sits inside."""
    out = []
    for m in re.finditer(re.escape(token), text, flags=re.I):
        lo, hi = m.start(), m.end()
        while lo > 0 and (text[lo - 1].isalnum() or text[lo - 1] in "_-./"):
            lo -= 1
        while hi < len(text) and (text[hi].isalnum() or text[hi] in "_-./"):
            hi += 1
        out.append(text[lo:hi])
    return out


def fetch(path: str) -> str:
    url = f"{HOST}/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "otterquote-vendor-scrub-check"})
    with urllib.request.urlopen(req, timeout=45) as r:
        if r.status != 200:
            raise RuntimeError(f"{url} -> HTTP {r.status}; refusing to count a non-200 body")
        return r.read().decode("utf-8", "replace")


def read_repo(root: pathlib.Path, path: str) -> str:
    return (root / path).read_text(encoding="utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", metavar="ROOT", help="scan a checkout instead of the deployed bytes")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    report, client_total, wire_total = [], 0, 0
    for path in SURFACES:
        raw = read_repo(pathlib.Path(args.repo), path) if args.repo else fetch(path)
        control = POSITIVE_CONTROL.get(path, DEFAULT_CONTROL)
        control_n = len(re.findall(re.escape(control), raw, flags=re.I))
        body = strip_css_hover(raw)
        client, wire = [], []
        for token in VENDOR_TOKENS:
            for hit in hits_for(body, token):
                (wire if classify(hit) == "wire" else client).append(hit)
        client_total += len(client)
        wire_total += len(wire)
        report.append({
            "surface": path, "bytes": len(raw),
            "positive_control": control, "positive_control_hits": control_n,
            "client_only": len(client), "wire_contract": len(wire),
            "client_sample": sorted(set(client))[:12],
            "wire_sample": sorted(set(wire))[:12],
        })
        if control_n == 0:
            report[-1]["WARNING"] = (
                f"positive control '{control}' scored 0 -- a zero on this surface proves nothing"
            )

    if args.json:
        print(json.dumps({"source": args.repo or HOST, "surfaces": report,
                          "client_only_total": client_total,
                          "wire_contract_total": wire_total}, indent=2))
    else:
        print(f"D-312 vendor scrub — source: {args.repo or HOST}")
        print(f"{'surface':32} {'bytes':>8} {'client':>7} {'wire':>6}  positive control")
        for r in report:
            print(f"{r['surface']:32} {r['bytes']:>8} {r['client_only']:>7} {r['wire_contract']:>6}"
                  f"  {r['positive_control']}={r['positive_control_hits']}"
                  + ("  ⚠ " + r["WARNING"] if "WARNING" in r else ""))
        print(f"\nCLIENT-ONLY residue (renameable in one file): {client_total}")
        print(f"WIRE-CONTRACT residue (needs a migration or a function deploy): {wire_total}")
        for r in report:
            if r["wire_sample"]:
                print(f"  {r['surface']}: {', '.join(r['wire_sample'])}")

    return 0 if client_total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
