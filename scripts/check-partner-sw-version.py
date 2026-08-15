#!/usr/bin/env python3
"""
gh-831: partner-sw.js VERSION-bump enforcement.

`partner-sw.js`'s cache-busting VERSION constant is a hand-maintained string
with a comment telling the next editor to bump it — and across at least four
auth PRs since 2026-08-03, nobody did. The result was a silently stale
js/auth.js served to the one surface (the installed Partner PWA) where
partner auth bugs actually get reported, defeating #818's fix outright and
confounding every device re-test on #817/#643 (fix-wrong vs.
fix-never-executed became indistinguishable).

Rather than trust a human to remember, VERSION is derived: this script
recomputes a hash of the file's own caching configuration (everything
except the VERSION line itself, so there's no circularity) and asserts the
VERSION constant embeds that hash. Any change to which assets are cached,
which strategy they use, or how the fetch/install/activate handlers behave
moves the hash — and a stale VERSION is then a CI failure, not a missed
code-review comment.

Exit codes:
  0 -- VERSION matches the derived hash
  1 -- VERSION is stale (or the file/constant couldn't be parsed)
"""
from __future__ import annotations
import hashlib
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
SW_PATH = REPO / "partner-sw.js"
VERSION_RE = re.compile(r"const VERSION = '([^']+)';")
HASH_LEN = 8


def derive_expected_hash(text: str) -> str:
    # Blank out the VERSION line's value before hashing so the hash never
    # depends on its own prior output.
    normalized = VERSION_RE.sub("const VERSION = '';", text, count=1)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:HASH_LEN]


def main() -> int:
    if not SW_PATH.exists():
        print(f"FAIL: {SW_PATH} not found.")
        return 1

    text = SW_PATH.read_text(encoding="utf-8")
    match = VERSION_RE.search(text)
    if not match:
        print("FAIL: could not find `const VERSION = '...';` in partner-sw.js.")
        return 1

    current_version = match.group(1)
    expected_hash = derive_expected_hash(text)

    if current_version.endswith(expected_hash):
        print(f"PASS: partner-sw.js VERSION ({current_version}) matches its derived content hash.")
        return 0

    print(
        "FAIL: partner-sw.js's caching config changed but VERSION was not bumped.\n"
        f"  Current VERSION:  {current_version}\n"
        f"  Expected to end with the hash: {expected_hash}\n\n"
        "  Update the VERSION constant in partner-sw.js so it ends with that hash,\n"
        "  e.g. const VERSION = 'oq-partner-v2-" + expected_hash + "';\n\n"
        "  This check exists because a stale partner-sw.js VERSION silently serves\n"
        "  cached js/auth.js/js/nav.js to the installed Partner PWA even after the\n"
        "  source files change (gh-831) — the exact confounder that cost five\n"
        "  device-test round-trips on #817/#643."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
