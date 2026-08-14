#!/usr/bin/env python3
"""
Weekly legal-surface link-check, for #806.

The underlying failure this detects: a mandatory consent/attestation
checkbox pointed at a 404 for an unknown period (partner-agreement.html,
#766) and nothing noticed — no test failed, no alert fired. This script
exists so that failure mode is a loud, scheduled, production-checked red,
not a human coincidentally reading a page twice.

Pipeline:
  1. Runs find-legal-surface-links.py to (re-)discover every legally
     load-bearing URL currently linked from a consent/attestation/terms/
     privacy/disclaimer control anywhere in the repo's top-level HTML.
     This is what keeps the list from going stale (AC #1) — it is
     regenerated on every run, nothing is hand-registered.
  2. Fetches each URL against production, following redirects.
  3. Asserts the FINAL status is exactly 200 (not a redirect target that
     itself 404s, not a soft-404 served at 200 with an empty/near-empty
     body).
  4. Asserts the body is non-empty and above MIN_BODY_BYTES.
  5. On any failure: prints a loud, itemized report to stderr, exits 1
     (fails the scheduled workflow red), and files/updates a GitHub issue
     naming the specific URL, its source file(s), and the status/reason.

Known coverage gap, disclosed rather than silently assumed away: this
generator only sees URLs that are actually hyperlinked from a file in this
git repo. A URL referenced only from Supabase-stored copy, a CMS field, or
an email template outside the repo (if any) will not be discovered. The
current partner-agreement.html 404 (#766) is a live example: no in-repo
file links to it as of 2026-08-14 (partner-re.html's Partner Terms
checkbox links to terms.html; partner-insurance.html's equivalent
checkbox has no link at all — a separate, smaller defect worth its own
issue), so this run's discovery pass will not include it. The checker's
correctness at flagging a real 404 is proven directly against the live
URL in tests/check-legal-surface-links.test.py instead.

Usage:
  python scripts/check-legal-surface-links.py [--file-issue]

  --file-issue   On failure, create/update a GitHub issue via the API
                 (requires GITHUB_TOKEN with `issues: write`). Without
                 this flag the script still exits 1 on failure (loud in
                 CI logs) but does not touch GitHub — used by the local/
                 test invocation so a manual run never spams the tracker.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

MIN_BODY_BYTES = 200
TIMEOUT_SECONDS = 15
REPO = "StellarEdgeServices/otterquote-platform"
ISSUE_TITLE_PREFIX = "[legal-surface-link-check] "


def discover() -> list[dict]:
    proc = subprocess.run(
        [sys.executable, os.path.join(os.path.dirname(__file__), "find-legal-surface-links.py")],
        capture_output=True, text=True, check=True,
    )
    entries = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        entries.append(json.loads(line))
    return entries


def check_url(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "otterquote-legal-link-check/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            body = resp.read()
            final_url = resp.geturl()
            status = resp.status
    except urllib.error.HTTPError as e:
        return {"url": url, "ok": False, "status": e.code, "final_url": e.url,
                "reason": f"HTTP {e.code}"}
    except Exception as e:  # network error, timeout, etc.
        return {"url": url, "ok": False, "status": None, "final_url": None,
                "reason": f"{type(e).__name__}: {e}"}

    if status != 200:
        return {"url": url, "ok": False, "status": status, "final_url": final_url,
                "reason": f"non-200 final status {status}"}
    if len(body) < MIN_BODY_BYTES:
        return {"url": url, "ok": False, "status": status, "final_url": final_url,
                "reason": f"body only {len(body)} bytes (< {MIN_BODY_BYTES} minimum) — "
                          f"likely a soft-404 or empty SPA shell"}
    return {"url": url, "ok": True, "status": status, "final_url": final_url, "reason": None}


def file_or_update_issue(failures: list[dict], sources_by_url: dict[str, list[dict]]) -> None:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN")
    if not token:
        print("!! --file-issue requested but no GITHUB_TOKEN in environment — skipping issue file", file=sys.stderr)
        return

    lines = ["Weekly legal-surface link-check found the following broken URL(s):\n"]
    for f in failures:
        srcs = sources_by_url.get(f["url"], [])
        src_desc = "; ".join(f"{s['source_file']}:{s['source_line']} ({s['link_text'] or s['trigger']})" for s in srcs) or "unknown"
        lines.append(f"- **{f['url']}** — {f['reason']}\n  Linked from: {src_desc}")
    body = "\n".join(lines) + (
        "\n\nA mandatory consent/attestation whose link 404s is an unenforceable consent "
        "record for every user who checked the box while it was broken. Filed automatically "
        "by `scripts/check-legal-surface-links.py` (#806). Do not close by silencing the "
        "check — close by fixing the link or removing the now-defunct reference."
    )
    title = ISSUE_TITLE_PREFIX + f"{len(failures)} broken legal-surface link(s)"

    def api(method: str, path: str, payload: dict | None = None):
        req = urllib.request.Request(
            f"https://api.github.com/repos/{REPO}{path}",
            data=json.dumps(payload).encode() if payload is not None else None,
            method=method,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read())

    existing = api("GET", "/issues?state=open&labels=legal-surface-link-check&per_page=10")
    open_match = next((i for i in existing if i["title"].startswith(ISSUE_TITLE_PREFIX)), None)

    if open_match:
        api("POST", f"/issues/{open_match['number']}/comments", {"body": body})
        print(f"Updated existing issue #{open_match['number']} with latest failures.", file=sys.stderr)
    else:
        created = api("POST", "/issues", {
            "title": title, "body": body,
            "labels": ["legal-surface-link-check", "lane:auto", "env:code"],
        })
        print(f"Filed new issue #{created['number']}.", file=sys.stderr)


def main() -> int:
    file_issue = "--file-issue" in sys.argv

    entries = discover()
    sources_by_url: dict[str, list[dict]] = {}
    for e in entries:
        sources_by_url.setdefault(e["url"], []).append(e)

    print(f"Checking {len(sources_by_url)} distinct legally load-bearing URL(s)...", file=sys.stderr)

    results = [check_url(url) for url in sources_by_url]
    failures = [r for r in results if not r["ok"]]

    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        print(f"{mark}: {r['url']} (status={r['status']})" + (f" — {r['reason']}" if not r["ok"] else ""))

    if failures:
        print(f"\n{len(failures)} of {len(results)} legally load-bearing URL(s) FAILED.", file=sys.stderr)
        for f in failures:
            srcs = sources_by_url.get(f["url"], [])
            for s in srcs:
                print(f"  {f['url']} <- {s['source_file']}:{s['source_line']}", file=sys.stderr)
        if file_issue:
            file_or_update_issue(failures, sources_by_url)
        return 1

    print(f"\nAll {len(results)} legally load-bearing URL(s) OK.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
