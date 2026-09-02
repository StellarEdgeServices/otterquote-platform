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
This discipline applies identically to the two modes added by gh-1528 below:
--paths never reads file content at all, and --stores prints a field name
and a shape VERDICT for its value, never the value or any prefix of it.

MODES (gh-1528 — three measured blind spots closed; see BLIND SPOTS BY MODE
near the bottom of this docstring for what each mode still cannot see):

  (default, no flags)  Shape scan — this file's original behavior, unchanged.
                        Walks --root, greps file CONTENT against
                        SHAPE_PATTERNS. This is the mode CI invokes today
                        (.github/workflows/credential-sweep.yml) and its
                        invocation is unchanged by this revision.

  --paths               PATH-convention enumeration. Reports every file
                        anywhere under --root whose NAME matches a
                        secret-by-convention glob (.env*, *.pem, *.key,
                        *credentials*, *secret*, *token*.json, *.p12,
                        id_rsa*) — regardless of what is inside it. A shape
                        sweep only ever looks at content; it has no way to
                        flag a plaintext-password .env file whose values
                        don't happen to look like hex/base64/JWT. This mode
                        is the fix for exactly that: a PATH hit is a FINDING
                        class of its own, independent of content shape.

  --stores               Doppler otterquote/prd field/value shape audit.
                        Authenticates with OTTERQUOTE_PRD_TOKEN (read from
                        the environment only, never printed) and reports
                        every secret field whose NAME and VALUE shape
                        disagree: a field named like an id/url/email whose
                        value has the shape of a private key / JWT / JSON
                        blob / provider key (the dangerous direction — a
                        real secret mislabelled as something safe to
                        display), and the reverse (a field named like a
                        secret whose value looks like a plain id/url/email —
                        usually a placeholder or a mislabelled non-secret).
                        Only the field name, its classification, the value's
                        shape class, and the value's LENGTH are ever printed
                        — never the value, never any prefix of it.

--paths and --stores are mutually exclusive with each other and select an
alternate mode entirely (they do not run alongside the shape scan) — run
each as its own invocation.

Checkpointing (shape scan and --paths mode; gh-1528 blind spot 3): the walk
persists a checkpoint file to disk after every directory finishes, not only
at clean exit, so a kill partway through (the standing failure mode: a
device_bash timeout around 45s) loses at most one directory of progress
instead of the whole run. On the next invocation with the same root/mode/
allowlist, already-completed directories are skipped and reported as
resumed. The checkpoint is cleared automatically on a clean completed run.
See the Checkpoint class and BLIND SPOTS BY MODE below for what this
guarantee does and does not cover.

Usage:
  python scripts/credential-sweep.py [--root REPO_ROOT] [--allowlist PATH]
  python scripts/credential-sweep.py --paths [--root REPO_ROOT] [--checkpoint-file PATH]
  python scripts/credential-sweep.py --stores
  (any mode) [--checkpoint-file PATH] overrides the default per-(mode,root)
  checkpoint location under the system temp dir.

Exit codes:
  0 — clean (no findings)
  2 — one or more findings (fail-hard; matches the schema-lint family's
      convention of a distinct nonzero code, offset by 1 so "no findings"
      (0) and "tool broke" (1, an uncaught exception) stay distinguishable
      from "findings exist" (2) in CI logs)
  3 — UNMEASURED (--stores only): the store could not be checked at all (no
      token, network/auth failure, or an empty/unreadable response). This is
      NOT a pass and must never be read as one — same convention as
      scripts/drift-detector-age.py's UNMEASURED verdict (gh-1419: measured
      cleanly-and-found-nothing and could-not-measure-at-all must never look
      the same).

BLIND SPOTS BY MODE (gh-1528) — a clean run of ONE mode is not "no secrets
present"; each mode narrows a different slice of the surface and none of the
three sees everything the others do.

  Default (shape scan, no flags):
    - Content that IS a live credential but does not match any
      SHAPE_PATTERNS regex (a plain-English password, a short PIN, a
      passphrase with spaces) — this is the exact gap gh-1528 was filed
      over: an archived .env held 5 plaintext creds and this mode flagged 1.
      --paths mode exists specifically to still catch the FILE this mode's
      shape logic cannot see inside of.
    - Anything inside SKIP_DIR_NAMES (node_modules, .git, build output, ...)
      or with a SKIP_EXTENSIONS suffix — by design, but still a blind spot
      for a credential pasted into, say, a vendored .svg or a build
      artifact.
    - Any file the allowlist's path:/value: rules exempt — an allowlist
      entry is a standing trust decision; a wrong or stale one is invisible
      to this mode by construction (nothing here re-derives whether an
      allowlist entry is still valid).
    - A credential split across a concatenation, template interpolation, or
      multiple variables ("sk_" + "live_" + "...") — the regexes match
      contiguous text only.

  --paths mode:
    - Reads FILENAMES only, never content — a secret-by-convention name that
      is actually a template/example file (.env.example with placeholder
      values) is reported exactly the same as a real leak; a human still
      has to open the hit. Deliberate (the mode's whole point is to stop
      trusting content shape to decide whether the LOCATION deserves a
      look), but it means the mode cannot itself tell a true positive from
      a false one.
    - A secret-by-convention file whose NAME doesn't match any of the eight
      globs (an arbitrarily named dump like notes-2026.txt or
      config.local.yml holding a real credential) is invisible to this mode
      — the shape scan is what would still catch that one, if the value
      inside happens to match a SHAPE_PATTERNS class.
    - Same SKIP_DIR_NAMES prune as the shape scan (node_modules/.git/build
      output are not walked), so a secret-by-convention file vendored into
      one of those trees is not enumerated.
    - gitignore-coverage is informational only, computed via `git
      check-ignore` against this working tree's rules at scan time — it
      does not mean the file was never committed (history is not
      consulted), and it degrades to False (not a crash) if git itself is
      unavailable or --root is outside a repo.
    - Not filtered through credential-sweep-allowlist.txt (see the
      Allowlist docstring) — every match is reported every run.

  --stores mode:
    - Covers exactly one store: the Doppler otterquote/prd project/config
      reachable with OTTERQUOTE_PRD_TOKEN. It does not reach any other
      Doppler project/config, and it does not scan the machine-local secret
      stores (.backup-credentials / .claude-code-secrets /
      .doppler-credentials) that OTTERQUOTE_PRD_TOKEN itself is read from —
      those are out of scope for this mode by design: it authenticates WITH
      a token sourced from one of those files, it does not scan the files
      themselves.
    - Only catches a NAME/VALUE shape MISMATCH — a field correctly named
      API_KEY holding a real API key raises no finding at all. There is no
      way for this mode to know a correctly labelled secret is exposed to
      more callers than it should be; that is an access-grant question, not
      a shape question.
    - The name/value classifiers are both heuristics (a curated token list,
      a handful of shape regexes) — a field name using vocabulary outside
      NAME_SECRET_TOKENS / NAME_ID_URL_EMAIL_TOKENS is UNCLASSIFIED_NAME and
      silently produces no verdict either way; same for a value shape
      outside every listed class (UNCLASSIFIED).
    - UNMEASURED (exit 3 — no token / network / auth failure / zero fields)
      is NOT the same as a clean run and must never be read as one — same
      convention as scripts/drift-detector-age.py's UNMEASURED, per
      gh-1419.

  Checkpointing (shape scan and --paths mode):
    - Granularity is one directory, not one file — a kill mid-way through a
      very large single directory still re-scans that whole directory's
      files on resume (re-scanning is safe/idempotent; it just isn't free).
    - The checkpoint file lives outside the repo tree (system temp dir, or
      --checkpoint-file) so it is never itself something either mode would
      need to reason about scanning — but that also means it is NOT durable
      across a different machine/container picking up the same clone (a CI
      run rescheduled onto a different runner starts over, by design; this
      is a same-process-tree recovery aid, not a distributed job queue).
    - A signature mismatch (root, mode, or allowlist content changed since
      the checkpoint was written) discards the old checkpoint silently and
      starts clean — correct, but editing the allowlist mid-run-sequence
      forfeits any resume value accumulated before the edit.
"""

import argparse
import base64
import fnmatch
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration — shape scan (default mode)
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
# Configuration — --paths mode (gh-1528 blind spot 1)
# ---------------------------------------------------------------------------

# Secret-by-convention filename globs, matched case-insensitively against the
# basename only. Deliberately shape-blind: a file matching one of these is
# reported regardless of what (if anything) is inside it, because the shape
# scan above already covers content — this list exists for the files that
# scan misses precisely when their content doesn't happen to match a shape
# (gh-1528's motivating case: an archived .env with 5 plaintext creds, only
# 1 shape-flagged).
PATH_CONVENTION_GLOBS = (
    ".env*", "*.pem", "*.key", "*credentials*", "*secret*", "*token*.json",
    "*.p12", "id_rsa*",
)


def path_matches_convention(fname: str) -> bool:
    lower = fname.lower()
    return any(fnmatch.fnmatchcase(lower, glob.lower()) for glob in PATH_CONVENTION_GLOBS)


def gitignore_coverage(repo_root: Path, rel_paths: list) -> dict:
    """Best-effort: which of these repo-relative paths are covered by an
    ancestor .gitignore, using git's own ignore evaluation (`git
    check-ignore`) so this matches real gitignore semantics (negation,
    anchoring, directory-only patterns) instead of a hand-rolled
    approximation. Returns False (not covered) for every path if git is
    unavailable, the call fails, or --root isn't inside a git repo — this is
    informational metadata on a PATH finding, never a reason to suppress the
    finding itself.
    """
    if not rel_paths:
        return {}
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "check-ignore", "--stdin"],
            input="\n".join(rel_paths),
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return {p: False for p in rel_paths}
    # check-ignore exits 0 (some matched), 1 (none matched), 128 (fatal, e.g.
    # not a repo) — only 0/1 are a valid signal; anything else means "could
    # not determine", not "not covered", but we still must not block the
    # finding on it, so it degrades to False either way.
    if proc.returncode not in (0, 1):
        return {p: False for p in rel_paths}
    ignored = {line.strip() for line in proc.stdout.splitlines() if line.strip()}
    return {p: (p in ignored) for p in rel_paths}


# ---------------------------------------------------------------------------
# Configuration — --stores mode (gh-1528 blind spot 2)
# ---------------------------------------------------------------------------

DOPPLER_PROJECT = "otterquote"
DOPPLER_CONFIG = "prd"
STORES_TOKEN_ENV_VAR = "OTTERQUOTE_PRD_TOKEN"

# Field NAME classification — curated token lists, not a general NLP model.
# A name matching neither list is UNCLASSIFIED_NAME and produces no verdict
# either way (see BLIND SPOTS BY MODE).
NAME_SECRET_TOKENS = {
    "key", "apikey", "secret", "token", "password", "passwd", "pwd",
    "credential", "credentials", "pat", "privatekey",
}
NAME_ID_URL_EMAIL_TOKENS = {
    "id", "url", "uri", "endpoint", "email", "domain", "host", "hostname",
    "name", "region", "slug", "username", "user", "org", "account", "handle",
}

# Value SHAPE classification for --stores mode. Reuses SHAPE_PATTERNS (the
# same regexes the file-content scan uses) plus a few shapes that only make
# sense for a single discrete value rather than free text: a PEM private key
# block and a JSON blob.
PRIVATE_KEY_PEM_PATTERN = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
URL_LIKE_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://\S+$")
EMAIL_LIKE_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
UUID_LIKE_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

VALUE_SHAPE_SECRET_CLASSES = frozenset({
    "PRIVATE_KEY_PEM", "JSON_BLOB", "JWT_SHAPED", "STRIPE_LIVE_KEY",
    "STRIPE_WEBHOOK_SECRET", "GITHUB_PAT", "HEX_RUN_20",
    "GENERIC_BASE64_HIGH_ENTROPY",
})
VALUE_SHAPE_BENIGN_CLASSES = frozenset({
    "URL_LIKE", "EMAIL_LIKE", "UUID_LIKE", "SHORT_LOW_ENTROPY", "EMPTY",
})


def classify_field_name(name: str) -> str:
    """SECRET_LIKE_NAME, ID_URL_EMAIL_LIKE_NAME, or UNCLASSIFIED_NAME. Token
    split on non-alphanumerics so e.g. "STRIPE_API_KEY" -> {"stripe","api",
    "key"}. SECRET_LIKE wins ties (a name could plausibly hit both lists,
    e.g. contains both "secret" and "id") because mislabelling a real secret
    as benign is the higher-severity direction gh-1528 exists to catch."""
    tokens = [t for t in re.split(r"[^a-zA-Z0-9]+", name.lower()) if t]
    if any(t in NAME_SECRET_TOKENS for t in tokens):
        return "SECRET_LIKE_NAME"
    if any(t in NAME_ID_URL_EMAIL_TOKENS for t in tokens):
        return "ID_URL_EMAIL_LIKE_NAME"
    return "UNCLASSIFIED_NAME"


def classify_value_shape(value: str) -> str:
    """One of VALUE_SHAPE_SECRET_CLASSES, one of VALUE_SHAPE_BENIGN_CLASSES,
    or "UNCLASSIFIED" (no verdict). Never returns or logs the value itself —
    callers must only surface this class name and value length."""
    v = value.strip()
    if not v:
        return "EMPTY"
    if PRIVATE_KEY_PEM_PATTERN.search(v):
        return "PRIVATE_KEY_PEM"
    if v.startswith("{") and v.endswith("}"):
        try:
            json.loads(v)
            return "JSON_BLOB"
        except ValueError:
            pass
    for class_name, pattern in SHAPE_PATTERNS:
        m = pattern.search(v)
        if m:
            matched = m.group(0)
            if class_name == ENTROPY_CLASS and shannon_entropy(matched) < ENTROPY_THRESHOLD_BITS_PER_CHAR:
                continue
            return class_name
    if URL_LIKE_PATTERN.match(v):
        return "URL_LIKE"
    if EMAIL_LIKE_PATTERN.match(v):
        return "EMAIL_LIKE"
    if UUID_LIKE_PATTERN.match(v):
        return "UUID_LIKE"
    if len(v) <= 40 and shannon_entropy(v) < ENTROPY_THRESHOLD_BITS_PER_CHAR:
        return "SHORT_LOW_ENTROPY"
    return "UNCLASSIFIED"


def stores_mismatches(secrets: dict) -> list:
    """secrets: {field_name: raw_value}. Returns a list of mismatch dicts —
    field name, direction, name class, value shape class, and value LENGTH
    only. Never includes the value."""
    findings = []
    for name, value in secrets.items():
        name_class = classify_field_name(name)
        if name_class == "UNCLASSIFIED_NAME":
            continue
        value_shape = classify_value_shape(value)
        if name_class == "ID_URL_EMAIL_LIKE_NAME" and value_shape in VALUE_SHAPE_SECRET_CLASSES:
            direction = "NAME_LOOKS_BENIGN_VALUE_LOOKS_SECRET"
        elif name_class == "SECRET_LIKE_NAME" and value_shape in VALUE_SHAPE_BENIGN_CLASSES:
            direction = "NAME_LOOKS_SECRET_VALUE_LOOKS_BENIGN"
        else:
            continue
        findings.append({
            "field": name,
            "direction": direction,
            "name_class": name_class,
            "value_shape": value_shape,
            "length": len(value),
        })
    return findings


def _stores_token():
    """Read OTTERQUOTE_PRD_TOKEN from the environment only. The VALUE never
    leaves this process and is never printed — R-089. Returns None (not "")
    when absent/blank, matching scripts/drift-detector-age.py's _token()."""
    tok = os.environ.get(STORES_TOKEN_ENV_VAR)
    return tok.strip() if tok and tok.strip() else None


def fetch_doppler_secrets(token, timeout=20):
    """Return (secrets_dict, source) or (None, reason). secrets_dict is
    {field_name: raw_value}. Never raises — every failure mode (missing
    token, network, auth, empty result, malformed response) comes back as
    (None, reason), never a crash and never a silent empty pass. Never logs
    the token or any secret value; on an HTTPError the response body is
    deliberately not read into the reason string."""
    if not token:
        return None, "no %s found in the environment" % STORES_TOKEN_ENV_VAR

    url = "https://api.doppler.com/v3/configs/config/secrets?project=%s&config=%s" % (
        DOPPLER_PROJECT, DOPPLER_CONFIG,
    )
    basic = base64.b64encode((token + ":").encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Basic " + basic,
            "Accept": "application/json",
            "User-Agent": "otterquote-credential-sweep",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return None, "Doppler API HTTP %s (%s)" % (exc.code, exc.reason)
    except Exception as exc:  # noqa: BLE001 -- any failure here is UNMEASURED
        return None, "%s: %s" % (type(exc).__name__, exc)

    try:
        data = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        return None, "response was not valid JSON: %s" % exc

    secrets = data.get("secrets")
    if not isinstance(secrets, dict) or not secrets:
        return None, (
            "Doppler API reachable but returned zero secrets for %s/%s"
            % (DOPPLER_PROJECT, DOPPLER_CONFIG)
        )

    out = {}
    for name, meta in secrets.items():
        if isinstance(meta, dict):
            raw_value = meta.get("raw", meta.get("computed", ""))
        else:
            raw_value = meta
        out[name] = raw_value if isinstance(raw_value, str) else ("" if raw_value is None else str(raw_value))
    return out, "doppler-api %s/%s (%d field(s))" % (DOPPLER_PROJECT, DOPPLER_CONFIG, len(out))


def run_stores_mode() -> int:
    token = _stores_token()
    secrets, reason = fetch_doppler_secrets(token)

    if secrets is None:
        print("CREDENTIAL STORE SHAPE AUDIT   store=%s/%s" % (DOPPLER_PROJECT, DOPPLER_CONFIG))
        print("  verdict : UNMEASURED")
        print("  detail  : %s" % reason)
        print("  " + "!" * 70)
        print("  >> UNMEASURED IS NOT A PASS. <<")
        print("  This mode could not check the store at all -- that is not the same")
        print("  as checking it and finding nothing. Fix the measurement (token/")
        print("  network), then re-run.")
        print("  " + "!" * 70)
        return 3

    findings = stores_mismatches(secrets)
    for f in sorted(findings, key=lambda x: x["field"]):
        print(
            "FINDING  field=%s — %s: name~%s, value shape %s (%d chars, VALUE REDACTED)"
            % (f["field"], f["direction"], f["name_class"], f["value_shape"], f["length"])
        )

    print("\n%s" % ("-" * 60))
    print(
        "Checked %d field(s) in %s/%s | %d shape mismatch(es) | source: %s"
        % (len(secrets), DOPPLER_PROJECT, DOPPLER_CONFIG, len(findings), reason)
    )
    if findings:
        print("Credential store shape audit FAILED.")
        return 2
    print("Credential store shape audit PASSED.")
    return 0


# ---------------------------------------------------------------------------
# Checkpointing (gh-1528 blind spot 3) — shape scan and --paths mode
# ---------------------------------------------------------------------------

class Checkpoint:
    """Persists per-directory scan progress to disk after every directory
    finishes, so a process kill loses at most one directory's worth of work
    instead of the whole run (gh-1528: a device_bash kill at ~45s previously
    lost all progress with nothing durable — RUN 13 still ended PARTIAL at
    462 directories). Cleared automatically on a clean completed run of the
    SAME signature — this is a recovery mechanism for an interrupted run,
    not a cache that should make a later, intentional full re-scan silently
    skip directories for an unrelated reason.
    """

    VERSION = 1

    def __init__(self, path: Path, signature: str):
        self.path = path
        self.signature = signature
        self.completed_dirs = set()
        self.findings = []
        self.files_scanned = 0
        self.resumed_dirs = 0  # how many dirs were already done when THIS run started

    @classmethod
    def load_or_new(cls, path: Path, signature: str) -> "Checkpoint":
        cp = cls(path, signature)
        if not path.exists():
            return cp
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cp  # corrupt/unreadable checkpoint -- start clean, not a crash
        if data.get("version") != cls.VERSION or data.get("signature") != signature:
            return cp  # different root/mode/allowlist -- do not resume from it
        cp.completed_dirs = set(data.get("completed_dirs", []))
        cp.findings = list(data.get("findings", []))
        cp.files_scanned = int(data.get("files_scanned", 0))
        cp.resumed_dirs = len(cp.completed_dirs)
        return cp

    def is_done(self, rel_dir: str) -> bool:
        return rel_dir in self.completed_dirs

    def mark_dir_done(self, rel_dir: str, dir_findings: list, dir_files_scanned: int) -> None:
        self.completed_dirs.add(rel_dir)
        self.findings.extend(dir_findings)
        self.files_scanned += dir_files_scanned
        self._persist()

    def _persist(self) -> None:
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(
            json.dumps({
                "version": self.VERSION,
                "signature": self.signature,
                "completed_dirs": sorted(self.completed_dirs),
                "findings": self.findings,
                "files_scanned": self.files_scanned,
            }),
            encoding="utf-8",
        )
        tmp.replace(self.path)  # atomic rename -- never leaves a half-written checkpoint

    def clear(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def compute_signature(mode: str, repo_root: Path, allowlist_path: Path) -> str:
    """A checkpoint's completed-directories list is only valid for the exact
    (mode, root, allowlist-content) it was built under -- an allowlist edit
    can change what an already-'completed' directory would report, so that
    must invalidate resume rather than silently trusting stale state."""
    h = hashlib.sha256()
    h.update(mode.encode("utf-8"))
    h.update(b"\0")
    h.update(str(repo_root).encode("utf-8"))
    h.update(b"\0")
    try:
        h.update(allowlist_path.read_bytes())
    except OSError:
        h.update(b"<no-allowlist>")
    return h.hexdigest()


def default_checkpoint_path(mode: str, repo_root: Path) -> Path:
    root_hash = hashlib.sha256(str(repo_root).encode("utf-8")).hexdigest()[:16]
    return Path(tempfile.gettempdir()) / ("credential-sweep-checkpoint-%s-%s.json" % (mode, root_hash))


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

    Applies to the shape scan (default mode) only. --paths mode is
    deliberately not filtered through this file — see BLIND SPOTS BY MODE:
    it is a raw enumeration by design, not a suppressible check, so an
    allowlist entry written for shape-scan noise cannot silently blind the
    path audit too.
    """

    def __init__(self):
        self.path_globs = []
        self.values = set()

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
# Scan — shape scan (default mode)
# ---------------------------------------------------------------------------

def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def scan_file(rel_path: str, source: str, allowlist: Allowlist, findings: list) -> None:
    claimed_spans = []

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


def run_shape_scan(repo_root: Path, allowlist: Allowlist, checkpoint: Checkpoint):
    """Walks repo_root directory-by-directory, checkpointing after each one.
    A directory already marked done in `checkpoint` (loaded from a prior,
    interrupted run with the same signature) is skipped entirely — its
    findings and file count were already persisted last time."""
    findings = list(checkpoint.findings)
    files_scanned = checkpoint.files_scanned

    for dirpath, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIR_NAMES)
        rel_dir = os.path.relpath(dirpath, repo_root).replace(os.sep, "/")
        if checkpoint.is_done(rel_dir):
            continue

        dir_findings = []
        dir_files_scanned = 0
        for fname in sorted(filenames):
            full = Path(dirpath) / fname
            rel = str(full.relative_to(repo_root)).replace(os.sep, "/")
            if full.suffix.lower() in SKIP_EXTENSIONS:
                continue
            if allowlist.path_allowed(rel):
                continue
            try:
                with open(full, encoding="utf-8", errors="strict") as f:
                    source = f.read()
            except (OSError, UnicodeDecodeError):
                # Not UTF-8 text (or unreadable) — treat as binary and skip.
                # A credential shape cannot be meaningfully asserted against
                # bytes we couldn't decode as text in the first place.
                continue
            dir_files_scanned += 1
            scan_file(rel, source, allowlist, dir_findings)

        checkpoint.mark_dir_done(rel_dir, dir_findings, dir_files_scanned)
        findings.extend(dir_findings)
        files_scanned += dir_files_scanned

    return findings, files_scanned


def report_shape_scan(findings: list, files_scanned: int, allowlist: Allowlist) -> int:
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


# ---------------------------------------------------------------------------
# Scan — --paths mode
# ---------------------------------------------------------------------------

def run_paths_mode(repo_root: Path, checkpoint: Checkpoint):
    """Same directory-by-directory checkpointed walk as run_shape_scan, but
    matches filenames against PATH_CONVENTION_GLOBS instead of reading file
    content. `files_scanned` here counts every file examined (matched or
    not), for parity with the shape scan's summary line."""
    findings = list(checkpoint.findings)
    files_scanned = checkpoint.files_scanned

    for dirpath, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIR_NAMES)
        rel_dir = os.path.relpath(dirpath, repo_root).replace(os.sep, "/")
        if checkpoint.is_done(rel_dir):
            continue

        dir_files_scanned = 0
        matched = []
        for fname in sorted(filenames):
            dir_files_scanned += 1
            if not path_matches_convention(fname):
                continue
            full = Path(dirpath) / fname
            rel = str(full.relative_to(repo_root)).replace(os.sep, "/")
            matched.append((rel, full))

        dir_findings = []
        if matched:
            ignore_map = gitignore_coverage(repo_root, [rel for rel, _ in matched])
            for rel, full in matched:
                try:
                    st = full.stat()
                    size = st.st_size
                    mtime = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat()
                except OSError:
                    size, mtime = None, None
                dir_findings.append({
                    "path": rel,
                    "bytes": size,
                    "mtime": mtime,
                    "gitignored": ignore_map.get(rel, False),
                })

        checkpoint.mark_dir_done(rel_dir, dir_findings, dir_files_scanned)
        findings.extend(dir_findings)
        files_scanned += dir_files_scanned

    return findings, files_scanned


def report_paths_mode(findings: list, files_scanned: int) -> int:
    for f in sorted(findings, key=lambda x: x["path"]):
        print(
            "PATH_FINDING  %s — %s bytes, mtime %s, gitignore-covered=%s"
            % (f["path"], f["bytes"], f["mtime"], f["gitignored"])
        )

    print(f"\n{'-' * 60}")
    print(f"Scanned {files_scanned} file(s) | {len(findings)} path finding(s)")

    if findings:
        print("Credential path-convention sweep FAILED.")
        return 2

    print("Credential path-convention sweep PASSED.")
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=".", help="Repository root (default: current directory)")
    parser.add_argument(
        "--allowlist",
        default=None,
        help="Path to the allowlist file (default: <root>/scripts/credential-sweep-allowlist.txt). "
             "Shape scan mode only.",
    )
    parser.add_argument(
        "--paths",
        action="store_true",
        help="Run PATH-convention enumeration mode instead of the shape scan.",
    )
    parser.add_argument(
        "--stores",
        action="store_true",
        help="Run the Doppler otterquote/prd field/value shape-mismatch audit instead of the "
             "shape scan. Requires OTTERQUOTE_PRD_TOKEN in the environment.",
    )
    parser.add_argument(
        "--checkpoint-file",
        default=None,
        help="Override the checkpoint file path (default: a per-(mode,root) file under the "
             "system temp dir). Shape scan / --paths mode only.",
    )
    args = parser.parse_args()

    if args.paths and args.stores:
        parser.error("--paths and --stores are mutually exclusive modes; run them as separate invocations")

    if args.stores:
        return run_stores_mode()

    repo_root = Path(os.path.abspath(args.root))
    mode = "paths" if args.paths else "shape"

    allowlist_path = Path(args.allowlist) if args.allowlist else repo_root / "scripts" / "credential-sweep-allowlist.txt"
    allowlist = Allowlist.load(allowlist_path)

    checkpoint_path = Path(args.checkpoint_file) if args.checkpoint_file else default_checkpoint_path(mode, repo_root)
    signature = compute_signature(mode, repo_root, allowlist_path)
    checkpoint = Checkpoint.load_or_new(checkpoint_path, signature)

    if checkpoint.resumed_dirs:
        print(
            "[checkpoint] resuming %s scan: %d directory(ies) already completed in a prior "
            "run, skipping them" % (mode, checkpoint.resumed_dirs)
        )

    if mode == "paths":
        findings, files_scanned = run_paths_mode(repo_root, checkpoint)
        checkpoint.clear()
        return report_paths_mode(findings, files_scanned)

    findings, files_scanned = run_shape_scan(repo_root, allowlist, checkpoint)
    checkpoint.clear()
    return report_shape_scan(findings, files_scanned, allowlist)


if __name__ == "__main__":
    sys.exit(main())
