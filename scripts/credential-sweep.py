#!/usr/bin/env python3
"""
credential-sweep.py — OtterQuote CI credential-shape grep (standing CTO duty 2)

Walks the repo tree looking for text that has the SHAPE of a live credential
(a long hex run, a provider-prefixed key, a JWT, a PAT, or generic
high-entropy base64) and fails loudly, naming file:line and the SHAPE CLASS
that matched — never the matched text itself. This is a shape sweep, not a
verified-secret detector: it will find things that merely look like a key
(commit SHAs quoted in docs, public Sentry/Pinterest identifiers, npm
integrity hashes) as readily as it would find a real one. That is by design
— see the allowlist file for how known-safe shapes get out of the way
without turning the detector blind for the file/directory they live in.

Motivation: gh-1295's own thread names this exact failure mode by analogy —
"credential-sweep.py printing FINDINGS: 0 without scanning" (fixed 08-28,
Cowork-side sec-sweep tooling) is one of "four instances, four subsystems,
inside two weeks" of a check reporting green while measuring nothing. This
script is written the other way: it enumerates every scanned file and every
finding, and an empty result set is reported as an explicit zero, not a
silent pass.

NEVER PRINTS A CANDIDATE SECRET. Output names the file, the line number, and
the shape class ("HEX_RUN_20", "STRIPE_LIVE_KEY", ...) — never the matched
substring, never even a truncated prefix of it. If you are tempted to add a
debug line that prints `match.group(0)` to help triage a finding locally,
redirect that debugging to length/shape metadata instead (e.g. "40 hex
chars") — the discipline is easy to erode by exactly one convenience print.

Usage:
  python scripts/credential-sweep.py [--root REPO_ROOT] [--allowlist PATH]

Exit codes:
  0 — clean (no findings)
  2 — one or more findings (fail-hard; matches the schema-lint family's
      convention of a distinct nonzero code, offset by 1 so "no findings"
      (0) and "tool broke" (1, an uncaught exception) stay distinguishable
      from "findings exist" (2) in CI logs)
"""

import argparse
import fnmatch
import math
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Directories never walked, anywhere in the tree (name match, any depth).
SKIP_DIR_NAMES = {
    ".git", "node_modules", ".next", "dist", "build", "out", "coverage",
    ".venv", "venv", "__pycache__",
}

# File extensions never scanned — binary/font/image formats where arbitrary
# byte sequences routinely produce shape-matching noise (an SVG's embedded
# base64 font data coincidentally starts "eyJ..." dozens of times in this
# tree; that is encoded binary, not source).
SKIP_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".avif", ".bmp",
    ".svg", ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".gz", ".zip", ".pdf", ".mp4", ".mp3", ".wav", ".ogg",
}

# Shape classes, checked in this order. A span already claimed by an earlier
# (more specific) class is not re-flagged by a later, more generic one —
# every hex-prefixed provider key is also a valid hex run, and re-flagging it
# twice would just be noise with the same underlying finding.
#
# Each entry: (class_name, compiled_regex)
SHAPE_PATTERNS = [
    ("STRIPE_LIVE_KEY", re.compile(r"\b(?:sk|pk)_live_[A-Za-z0-9]{20,}\b")),
    ("STRIPE_WEBHOOK_SECRET", re.compile(r"\bwhsec_[A-Za-z0-9]{20,}\b")),
    ("GITHUB_PAT", re.compile(r"\b(?:github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,})\b")),
    ("JWT_SHAPED", re.compile(
        r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b"  # full 3-segment JWT
        r"|\beyJ[A-Za-z0-9_-]{20,}\b"  # bare header/fragment, no dots
    )),
    ("HEX_RUN_20", re.compile(r"\b[0-9a-fA-F]{20,}\b")),
    # Generic base64 candidate; entropy-filtered in code below, not here —
    # a regex alone can't measure entropy.
    ("GENERIC_BASE64_HIGH_ENTROPY", re.compile(r"\b[A-Za-z0-9+/]{32,}={0,2}\b")),
]

ENTROPY_CLASS = "GENERIC_BASE64_HIGH_ENTROPY"
ENTROPY_THRESHOLD_BITS_PER_CHAR = 4.7  # calibrated against this repo's tree; see PR body


def shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


# ---------------------------------------------------------------------------
# Allowlist
# ---------------------------------------------------------------------------

class Allowlist:
    """Two independent forms, one per line, `#` comments and blank lines
    ignored:
      path:<glob relative to repo root>   — skip the whole file
      value:<exact matched literal>       — skip this exact matched string,
                                             wherever it recurs
    `value:` is preferred for a single recurring public constant (a Sentry
    loader id embedded in every page, say) where excluding the *path* would
    blind the scanner for that file's whole content. `path:` is preferred
    for a structurally-exempt class (lockfiles, test fixtures) where the
    file's entire content is expected to contain synthetic or vendored
    hash-shaped text.
    """

    def __init__(self):
        self.path_globs: list[str] = []
        self.values: set[str] = set()

    @classmethod
    def load(cls, path: Path) -> "Allowlist":
        al = cls()
        if not path.exists():
            return al
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("path:"):
                al.path_globs.append(line[len("path:"):].strip())
            elif line.startswith("value:"):
                al.values.add(line[len("value:"):].strip())
            # Unrecognized line shapes are silently ignored rather than
            # crashing the sweep — a malformed allowlist entry should not
            # itself take CI down; it just fails to suppress anything.
        return al

    def path_allowed(self, rel_path: str) -> bool:
        norm = rel_path.replace(os.sep, "/")
        return any(fnmatch.fnmatch(norm, g) for g in self.path_globs)

    def value_allowed(self, matched_text: str) -> bool:
        return matched_text in self.values


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------

def iter_scannable_files(repo_root: Path, allowlist: Allowlist):
    for dirpath, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES]
        for fname in filenames:
            full = Path(dirpath) / fname
            rel = str(full.relative_to(repo_root))
            if full.suffix.lower() in SKIP_EXTENSIONS:
                continue
            if allowlist.path_allowed(rel):
                continue
            yield full, rel


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def scan_file(rel_path: str, source: str, allowlist: Allowlist, findings: list) -> None:
    claimed_spans: list[tuple[int, int]] = []

    def overlaps_claimed(start: int, end: int) -> bool:
        return any(start < c_end and end > c_start for c_start, c_end in claimed_spans)

    for class_name, pattern in SHAPE_PATTERNS:
        for m in pattern.finditer(source):
            start, end = m.start(), m.end()
            if overlaps_claimed(start, end):
                continue
            matched_text = m.group(0)

            if class_name == ENTROPY_CLASS:
                if shannon_entropy(matched_text) < ENTROPY_THRESHOLD_BITS_PER_CHAR:
                    continue

            if allowlist.value_allowed(matched_text):
                continue

            claimed_spans.append((start, end))
            findings.append({
                "file": rel_path,
                "line": line_of(source, start),
                "class": class_name,
                "length": len(matched_text),
            })


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=".", help="Repository root (default: current directory)")
    parser.add_argument(
        "--allowlist",
        default=None,
        help="Path to the allowlist file (default: <root>/scripts/credential-sweep-allowlist.txt)",
    )
    args = parser.parse_args()

    repo_root = Path(os.path.abspath(args.root))
    allowlist_path = Path(args.allowlist) if args.allowlist else repo_root / "scripts" / "credential-sweep-allowlist.txt"
    allowlist = Allowlist.load(allowlist_path)

    findings: list[dict] = []
    files_scanned = 0

    for full_path, rel_path in iter_scannable_files(repo_root, allowlist):
        try:
            with open(full_path, encoding="utf-8", errors="strict") as f:
                source = f.read()
        except (OSError, UnicodeDecodeError):
            # Not UTF-8 text (or unreadable) — treat as binary and skip.
            # A credential shape cannot be meaningfully asserted against
            # bytes we couldn't decode as text in the first place.
            continue
        files_scanned += 1
        scan_file(rel_path, source, allowlist, findings)

    for f in sorted(findings, key=lambda x: (x["file"], x["line"])):
        print(f"FINDING  {f['file']}:{f['line']} — shape class {f['class']} "
              f"({f['length']} chars, MATCH REDACTED)")

    print(f"\n{'-' * 60}")
    print(f"Scanned {files_scanned} file(s) | allowlist: {len(allowlist.path_globs)} path rule(s), "
          f"{len(allowlist.values)} value rule(s) | {len(findings)} finding(s)")

    if findings:
        print("Credential shape sweep FAILED.")
        return 2

    print("Credential shape sweep PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
