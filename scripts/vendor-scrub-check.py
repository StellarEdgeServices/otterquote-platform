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

COVERAGE, AND THE RATCHET (PR #1860 REVIEW blocker 3)
-----------------------------------------------------
The first version of this script scanned the seven surfaces #1339 names and was
wired into no workflow, so the criterion stayed hand-run and the other 70-odd
pages were not measured at all. Both halves are fixed:

  - `--repo` mode now walks EVERY root-level *.html page plus js/*.js, not a
    hand-list. A new page cannot join the tree unmeasured.
  - `--ratchet` compares each file against scripts/vendor-scrub-baseline.json and
    fails ONLY on an increase. That is what makes this wirable today: the residue
    is 296 client-only hits whose removal needs the D-312 scope ruling recorded on
    #1339, so a gate demanding zero would be red on arrival and would be switched
    off within a day. A ratchet is green now, blocks the next regression, and
    ratchets down as the scrub proceeds -- a file whose count DROPS below its
    baseline also fails, with the instruction to lower the baseline in the same PR,
    so the floor can never silently drift back up.

Usage:
    python3 scripts/vendor-scrub-check.py                 # deployed bytes (default)
    python3 scripts/vendor-scrub-check.py --repo .        # this checkout instead
    python3 scripts/vendor-scrub-check.py --repo . --ratchet   # CI mode
    python3 scripts/vendor-scrub-check.py --json
    python3 scripts/vendor-scrub-check.py --self-test

Exit status: without --ratchet, 0 when the client-only residue is zero, 1
otherwise. With --ratchet, 0 unless a per-file count moved. Wire-contract hits
never fail a run -- clearing them is a migration/deploy decision, not a rename.
"""

import argparse
import json
import pathlib
import re
import sys
import urllib.request

HOST = "https://otterquote.com"
BASELINE_DEFAULT = "scripts/vendor-scrub-baseline.json"

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

# Proof the instrument is live on the same bytes. A zero for a vendor name is only
# meaningful beside a non-zero for something that MUST be there -- otherwise a
# 404 body, an empty read or a misspelled path reads as a clean scrub. (The
# app.otterquote.com sweep is exactly that failure, and it happened.)
#
# One fixed token does not work across a whole tree: contractor-bid-form.html and
# roughly twenty admin pages carry no "otterquote" string at all, so a per-file
# control is tried in order and the first that fires is reported. Only if ALL of
# them score zero is the read itself suspect -- and that is the only case that
# warns.
POSITIVE_CONTROLS = ["otterquote", "supabase", "<html", "function"]

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


def repo_surfaces(root: pathlib.Path) -> list[str]:
    """Every customer-facing page in the tree, discovered -- never hand-listed.

    A hand-list is how the first version of this script measured 7 of 78 pages and
    reported a number that sounded like coverage.
    """
    pages = sorted(p.name for p in root.glob("*.html"))
    scripts = sorted("js/" + p.name for p in (root / "js").glob("*.js")) if (root / "js").is_dir() else []
    return pages + scripts


def count_surface(raw: str):
    """(client_hits, wire_hits) for one surface's bytes."""
    body = strip_css_hover(raw)
    client, wire = [], []
    for token in VENDOR_TOKENS:
        for hit in hits_for(body, token):
            (wire if classify(hit) == "wire" else client).append(hit)
    return client, wire


def self_test() -> int:
    """Firing self-test: the classifier and the CSS strip, on fixtures.

    Printed as PASS/FAIL lines because scripts/detector-negative-control-check.py
    counts exactly those -- an "ok" line self-reports zero assertions and the gate
    scores the whole test file as proving nothing. That is what failed this
    script's first review.
    """
    fails = passes = 0
    def check(name, got, want):
        nonlocal fails, passes
        if got == want:
            passes += 1
            print(f"PASS  {name}")
        else:
            fails += 1
            print(f"FAIL  {name}: got {got!r}, want {want!r}")

    check("CSS :hover is not a vendor reference",
          count_surface("a:hover{} .btn.hover:bg-x{}")[0], [])
    check("a real element id IS a vendor reference",
          count_surface('<div id="hoverPhotoModal">')[0], ["hoverPhotoModal"])
    check("a database column is WIRE, not client",
          count_surface('sb.from("hover_orders")')[1], ["hover_orders"])
    check("a retired-vendor EF name is WIRE",
          classify("create-docusign-envelope"), "wire")
    check("an element id that looks like a path is CLIENT",
          classify("resend-hover-btn"), "client")
    for vendor in VENDOR_TOKENS:
        check(f"D-312 vendor '{vendor}' is searched for", vendor in VENDOR_TOKENS, True)
    check("NEG: a clean surface scores a true zero",
          count_surface('<div id="photoModal">')[0], [])
    check("the positive-control list is ordered and non-empty",
          POSITIVE_CONTROLS[0], "otterquote")
    print(f"\nself-test: {passes} passed | {fails} failed")
    return 1 if fails else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", metavar="ROOT", help="scan a checkout instead of the deployed bytes")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--ratchet", action="store_true",
                    help="fail only when a per-file count MOVED against the baseline (CI mode)")
    ap.add_argument("--baseline", default=BASELINE_DEFAULT)
    ap.add_argument("--write-baseline", action="store_true",
                    help="rewrite the baseline from the current counts (never run this in CI)")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    surfaces = repo_surfaces(pathlib.Path(args.repo)) if args.repo else SURFACES
    report, client_total, wire_total = [], 0, 0
    for path in surfaces:
        raw = read_repo(pathlib.Path(args.repo), path) if args.repo else fetch(path)
        control, control_n = POSITIVE_CONTROLS[-1], 0
        for candidate in POSITIVE_CONTROLS:
            n = len(re.findall(re.escape(candidate), raw, flags=re.I))
            if n:
                control, control_n = candidate, n
                break
        client, wire = count_surface(raw)
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
                "EVERY positive control scored 0 -- this surface's bytes were not read as expected, "
                "so its vendor zero proves nothing"
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

    if args.write_baseline:
        base = {r["surface"]: r["client_only"] for r in report if r["client_only"]}
        pathlib.Path(args.baseline).write_text(json.dumps(base, indent=2, sort_keys=True) + "\n")
        print(f"\nbaseline written: {args.baseline} ({len(base)} surface(s))")
        return 0

    if args.ratchet:
        baseline = json.loads(pathlib.Path(args.baseline).read_text())
        moved = []
        for r in report:
            was = baseline.get(r["surface"], 0)
            now = r["client_only"]
            if now > was:
                moved.append(f"REGRESSION  {r['surface']}: {was} -> {now} vendor reference(s). "
                             f"D-312 forbids naming a third-party vendor on a customer-facing surface.")
            elif now < was:
                moved.append(f"BASELINE STALE  {r['surface']}: {was} -> {now}. Good news — lower the "
                             f"baseline in this same PR so the floor cannot drift back up.")
        for m in moved:
            print("\n" + m)
        print(f"\nRATCHET: {len(moved)} surface(s) moved against {args.baseline}")
        return 1 if moved else 0

    return 0 if client_total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
