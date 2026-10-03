#!/usr/bin/env python3
"""IndexNow submitter for otterquote.com (gh-2423, standard library only).

IndexNow tells participating search engines which URLs changed. The site hosts
a key file at https://otterquote.com/<key>.txt (the key is public by design, it
is served from the site, so it lives in the repo and is not a secret). A
submitter POSTs {"host","key","keyLocation","urlList"} to
https://api.indexnow.org/indexnow ; 200 or 202 means accepted.

Default is a DRY RUN: the JSON payload is printed and nothing is sent. Sending
needs an explicit --send, and before sending the script GETs the live key file
and refuses unless it is served with the right content.

Run it AFTER a publish, never at merge time (merges are published by hand later,
and announcing URLs that are not live yet is wrong):

  python3 tools/indexnow_submit.py                       # dry run, whole sitemap
  python3 tools/indexnow_submit.py --since <sha> --send  # changed pages only
  python3 tools/indexnow_submit.py --urls urls.txt       # or a space-separated list

Exit codes: 0 ok (or dry run), 1 non-2xx / key file not live, 2 usage or bad input.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

HOST = "otterquote.com"
ENDPOINT = "https://api.indexnow.org/indexnow"
BATCH = 10000
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_FILE_RE = re.compile(r"^([0-9a-f]{32})\.txt$")
NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


class Refusal(Exception):
    """A reason not to continue; message is printed and the exit code is non-zero."""


def find_key(repo=None):
    repo = repo or REPO
    """The key is the name of the single <32 hex>.txt at the repo root; its content must equal the name."""
    names = sorted(n for n in os.listdir(repo) if KEY_FILE_RE.match(n))
    if len(names) != 1:
        raise Refusal("expected exactly one <32-hex>.txt key file at the repo root, found %d" % len(names))
    key = KEY_FILE_RE.match(names[0]).group(1)
    with open(os.path.join(repo, names[0]), encoding="utf-8") as fh:
        body = fh.read().strip()
    if body != key:
        raise Refusal("key file %s content does not equal its name" % names[0])
    return key


def parse_sitemap(path):
    """Every <loc> in the sitemap, in order."""
    root = ET.parse(path).getroot()
    return [e.text.strip() for e in root.iter(NS + "loc") if e.text and e.text.strip()]


def host_of(url):
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def check_hosts(urls):
    bad = [u for u in urls if host_of(u) != HOST or urllib.parse.urlsplit(u).scheme not in ("http", "https")]
    if bad:
        raise Refusal("refusing URL(s) not on host %s: %s" % (HOST, ", ".join(bad[:5])))


def loc_to_sources(loc):
    """Repo-relative file paths that can produce this sitemap URL."""
    p = urllib.parse.unquote(urllib.parse.urlsplit(loc).path)
    if p.endswith("/"):
        return [p.lstrip("/") + "index.html"]
    rel = p.lstrip("/")
    return [rel] if rel.endswith(".html") else [rel, rel + ".html"]


def changed_files(ref, repo=None):
    repo = repo or REPO
    r = subprocess.run(["git", "diff", "--name-only", ref + "..HEAD"], cwd=repo, capture_output=True, text=True)
    if r.returncode != 0:
        raise Refusal("git diff against %r failed: %s" % (ref, r.stderr.strip()))
    return {l.strip() for l in r.stdout.splitlines() if l.strip()}


def urls_since(locs, ref, repo=None):
    """Sitemap URLs whose source file changed between ref and HEAD. Pages not in the sitemap are skipped."""
    changed = changed_files(ref, repo)
    return [u for u in locs if any(s in changed for s in loc_to_sources(u))]


def read_urls_arg(items):
    if len(items) == 1 and os.path.isfile(items[0]):
        with open(items[0], encoding="utf-8") as fh:
            items = fh.read().split()
    return [i for i in items if i]


def build_payload(key, urls):
    return {"host": HOST, "key": key, "keyLocation": "https://%s/%s.txt" % (HOST, key), "urlList": list(urls)}


def batches(urls, size=BATCH):
    for i in range(0, len(urls), size):
        yield urls[i:i + size]


def verify_live_key(key):
    """GET the live key file; refuse unless 200, text/plain and body == key."""
    url = "https://%s/%s.txt" % (HOST, key)
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=30) as resp:
            status = resp.status
            ctype = resp.headers.get("Content-Type", "")
            body = resp.read().decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as e:
        raise Refusal("key file not live: GET %s returned HTTP %s (publish first)" % (url, e.code))
    except Exception as e:
        raise Refusal("key file check failed: GET %s: %s" % (url, e))
    if status != 200:
        raise Refusal("key file not live: GET %s returned HTTP %s" % (url, status))
    if not ctype.lower().startswith("text/plain"):
        raise Refusal("key file served as %r, expected text/plain" % ctype)
    if body != key:
        raise Refusal("key file content at %s does not match the key" % url)


def post(payload):
    req = urllib.request.Request(ENDPOINT, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--sitemap", default=os.path.join(REPO, "sitemap.xml"))
    ap.add_argument("--urls", nargs="+", metavar="URL_OR_FILE", help="submit only these (a file of URLs, or a list)")
    ap.add_argument("--since", metavar="GIT_REF", help="only URLs whose source file changed between GIT_REF and HEAD")
    ap.add_argument("--dry-run", action="store_true", help="print the payload, send nothing (the default)")
    ap.add_argument("--send", action="store_true", help="actually send (checks the live key file first)")
    a = ap.parse_args(argv)
    if a.send and a.dry_run:
        print("error: --send and --dry-run are mutually exclusive", file=sys.stderr)
        return 2
    try:
        key = find_key()
        if a.urls:
            urls = read_urls_arg(a.urls)
            check_hosts(urls)
        else:
            locs = [u for u in parse_sitemap(a.sitemap) if host_of(u) == HOST]
            urls = urls_since(locs, a.since) if a.since else locs
        urls = list(dict.fromkeys(urls))
        if not urls:
            print("no URLs to submit")
            return 0
        if not a.send:
            for chunk in batches(urls):
                print(json.dumps(build_payload(key, chunk), indent=2))
            print("DRY RUN: %d URL(s) in %d batch(es); nothing sent (use --send)" % (len(urls), len(list(batches(urls)))))
            return 0
        verify_live_key(key)
        for n, chunk in enumerate(batches(urls), 1):
            status = post(build_payload(key, chunk))
            ok = 200 <= status < 300
            print("HTTP %s batch %d: %s %d URL(s)" % (status, n, "accepted" if ok else "REJECTED", len(chunk)))
            if not ok:
                return 1
        return 0
    except Refusal as e:
        print("REFUSED: %s" % e, file=sys.stderr)
        return 1 if "key file" in str(e) else 2


if __name__ == "__main__":
    sys.exit(main())
