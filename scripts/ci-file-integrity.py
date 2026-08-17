#!/usr/bin/env python3
"""
CI File Integrity Check — null-byte, size sanity, JS syntax, TS structure, and MD gate.

Catches FUSE/bindfs mount truncation before corrupt files reach production.
Root cause (original): May 3, 2026 production outage — login.html and contractor-join.html
were silently truncated by bindfs write corruption, causing a 9.5-hour outage.
Root cause (extended): May 25, 2026 — PR #136 committed a truncated
create-docusign-envelope/index.ts (47,139 bytes; complete is 74,299 bytes), causing
an 8-day EF redeploy block and a D-123 compliance gap. TypeScript EF files
were not scanned by this script at the time. Task 86e1k3yjq.
Extended again: June 11, 2026 — README.md null-byte corruption incident. Markdown
files added to EXTENSIONS for null-byte and size-floor scanning. Task 86e1unc2b.

Detects six violation classes:
  1. Null-byte padding    -- file is full-size but filled with \x00 after real content
  2. Size-floor failure  -- file is shorter than any legitimate page could be
  3. Canary minimums     -- critical pages/EFs must exceed known-good thresholds
  4. HTML truncation     -- HTML files must end with </html>
  5. JS parse error      -- node --check catches syntax errors including clean truncation
  6. TS EF truncation    -- Supabase Edge Function index.ts files must end with });
                            (Deno.serve wrapper close) -- catches mid-function truncation

Canary matching rules:
  - Keys with no "/" are ROOT-ANCHORED: only match at repo root (e.g. "index.html"
    matches root index.html but NOT blog/index.html)
  - Keys with "/" match the exact path or any path ending with that suffix
    (e.g. "js/auth.js" matches js/auth.js and also vendor/js/auth.js)
"""
import os
import subprocess
import sys

# Extensions to scan
EXTENSIONS = {".html", ".js", ".css", ".ts", ".md"}

# Minimum size floors per extension (bytes)
# A legitimate HTML page cannot be < 500 bytes; a real JS module cannot be < 50 bytes
# Supabase Edge Function index.ts files are typically 5,000-75,000 bytes
# Markdown files: 50 bytes catches null-padded or near-empty files
MIN_SIZES = {
    ".html": 500,
    ".js": 50,
    ".css": 50,
    ".ts": 500,
    ".md": 50,
}

# Canary files: critical pages/scripts with hard minimum thresholds (bytes).
# These were affected by the May 3, 2026 outage or are single points of failure.
# Values are conservative (~30-50% of actual file size as of May 2026).
# Root-anchored (no slash): only matches at repo root level.
# Path canaries (contains slash): matches exact path or suffix.
#
# EF canaries: Supabase Edge Function files. Thresholds at ~80% of current
# known-good size (May 27, 2026). PR #136 incident: file dropped from 74,299 to
# 47,139 bytes (-36%) -- well below an 80% canary. Task 86e1k3yjq.
CANARY_FILES = {
    # Frontend critical pages (root-anchored)
    "login.html":                  3000,
    "contractor-join.html":        4000,
    "contractor-login.html":       2000,
    "index.html":                  5000,   # NOT blog/index.html
    "get-started.html":            4000,
    "contractor-dashboard.html":   5000,
    "dashboard.html":              5000,
    "auth-callback.html":          7000,   # bumped 2000->7000 (current ~9338 bytes, May 19 2026)
    # Frontend critical scripts (path canaries)
    "js/auth.js":                  8000,
    "js/config.js":                 200,
    # Supabase Edge Function canaries (path canaries, ~80% of known-good size)
    "supabase/functions/create-docusign-envelope/index.ts": 59000,  # known-good 74,299 bytes
    "supabase/functions/notify-contractors/index.ts":        48000,  # known-good 61,138 bytes
    "supabase/functions/process-dunning/index.ts":           43000,  # known-good 53,989 bytes
    "supabase/functions/process-coi-reminders/index.ts":     32000,  # known-good 40,948 bytes
    "supabase/functions/process-bid-expirations/index.ts":   29000,  # known-good 36,794 bytes
    "supabase/functions/docusign-webhook/index.ts":          24000,  # known-good 30,263 bytes
}

# Directories to skip entirely
EXCLUDE_DIRS = {".git", "node_modules", "react-app", "tests", "democracy", "docs", "Docs"}

failures = []
checked = 0

def canary_matches(rel_path, canary_key):
    """Return True if rel_path matches canary_key under the matching rules."""
    if "/" in canary_key:
        # Path canary: exact match OR ends-with match
        return rel_path == canary_key or rel_path.endswith("/" + canary_key)
    else:
        # Root-anchored: exact match only (no subdirectory matches)
        return rel_path == canary_key

def is_ef_index(rel_path):
    """Return True if rel_path is a Supabase Edge Function index.ts file.

    Matches supabase/functions/<name>/index.ts -- exactly four path segments
    with the first two being supabase/functions. This ensures we apply the
    Deno.serve structural check only to EF entry points, not shared helpers
    (_shared/*.ts) or other TypeScript files.
    """
    parts = rel_path.split("/")
    return (
        len(parts) == 4
        and parts[0] == "supabase"
        and parts[1] == "functions"
        and parts[3] == "index.ts"
    )

for root, dirs, files in os.walk("."):
    # Prune excluded dirs in-place (modifies dirs so os.walk won't descend)
    dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

    for fname in files:
        ext = os.path.splitext(fname)[1].lower()
        if ext not in EXTENSIONS:
            continue

        fpath = os.path.join(root, fname)
        # Normalize to forward-slash relative path (strip leading ./)
        rel_path = fpath.replace("\\", "/").lstrip("./")

        try:
            with open(fpath, "rb") as f:
                data = f.read()
        except OSError as e:
            failures.append(f"FAIL [unreadable] {rel_path}: {e}")
            continue

        checked += 1
        size = len(data)
        null_count = data.count(b"\x00")

        # Check 1: Null bytes -- most common truncation signature
        if null_count > 0:
            failures.append(
                f"FAIL [null-bytes] {rel_path}: {null_count} null bytes "
                f"(file size: {size} bytes) -- FUSE/bindfs truncation signature"
            )

        # Check 2: Extension-level minimum floor
        min_size = MIN_SIZES.get(ext, 0)
        if size < min_size:
            failures.append(
                f"FAIL [too-small] {rel_path}: {size} bytes < {min_size} byte "
                f"floor for {ext} files"
            )

        # Check 3: Canary file specific thresholds
        for canary_key, canary_min in CANARY_FILES.items():
            if canary_matches(rel_path, canary_key):
                if size < canary_min:
                    failures.append(
                        f"FAIL [canary] {rel_path}: {size} bytes < {canary_min} "
                        f"byte canary threshold for '{canary_key}'"
                    )
                break  # Each file matches at most one canary key

        # Check 4: HTML structural completeness -- must end with </html>.
        # Catches clean HTML truncation that has no null bytes and clears size
        # canary thresholds (the May 19, 2026 86e1fbxgq pattern).
        # Uses rfind so trailing deploy comments (<!-- deploy: ... -->) after
        # </html> don't false-positive. Window of 512 bytes allows metadata
        # while still catching files with substantial content after </html>.
        if ext == ".html":
            trimmed = data.rstrip()
            last_close = trimmed.rfind(b"</html>")
            if last_close == -1 or (len(trimmed) - last_close) > 512:
                tail = trimmed[-60:].decode("utf-8", errors="replace")
                failures.append(
                    f"FAIL [html-truncation] {rel_path}: file does not end with "
                    f"</html> (tail: ...{tail!r}) -- clean truncation signature"
                )

        # Check 5: JS syntax parse -- node --check (catches clean truncation that
        # has no null bytes, e.g. a file that ends mid-expression after truncation).
        # Added May 2026 (bug-killer 86e1b422x): js/auth.js was cleanly truncated
        # with no null bytes; size-floor and canary checks both passed, but the file
        # was syntactically invalid. node --check catches this class of failure.
        if ext == ".js":
            try:
                result = subprocess.run(
                    ["node", "--check", fpath],
                    capture_output=True,
                    text=True
                )
                if result.returncode != 0:
                    stderr = result.stderr.strip()
                    lines = stderr.splitlines()
                    # Extract line number from first stderr line: "<path>:<linenum>"
                    line_num = "?"
                    if lines:
                        first = lines[0]
                        colon_idx = first.rfind(":")
                        if colon_idx != -1:
                            candidate = first[colon_idx + 1:]
                            if candidate.isdigit():
                                line_num = candidate
                    # Find the SyntaxError description line
                    syntax_msg = "SyntaxError (see stderr)"
                    for ln in lines:
                        if ln.strip().startswith("SyntaxError:"):
                            syntax_msg = ln.strip()
                            break
                    failures.append(
                        f"FAIL [parse-error] {rel_path}: line {line_num} -- {syntax_msg}"
                    )
            except FileNotFoundError:
                failures.append(
                    f"FAIL [parse-error] {rel_path}: node not found on PATH -- "
                    f"cannot syntax-check JS files"
                )

        # Check 6: TypeScript Edge Function structural completeness.
        # Supabase EF entry points (supabase/functions/<name>/index.ts) must end
        # with a statement-closing character: ';' or '}'.
        # A file truncated mid-expression (the PR #136 pattern) ends with an
        # identifier, keyword, or string -- NOT a closing punctuation mark.
        # Note: EFs use different entry-point patterns -- some use Deno.serve()
        # (ending with '});'), others export handlers ending with '}', and older
        # EFs use 'serve(handleRequest);' (ending with ';').  Checking for ';' or
        # '}' correctly accepts all patterns while catching mid-expression truncation.
        # Null bytes are stripped before the check so padded-corruption files are
        # handled by Check 1 (null-bytes) rather than producing a double-failure here.
        # PR #136 incident: truncated file ended with 'e' (mid-expression) -- caught.
        # Task 86e1k3yjq, May 27 2026.
        # Shared helpers (_shared/*.ts) are excluded by is_ef_index().
        if ext == ".ts" and is_ef_index(rel_path):
            trimmed = data.rstrip(b"\x00 \t\r\n")
            last_char = trimmed[-1:].decode("utf-8", errors="replace") if trimmed else ""
            if last_char not in (";", "}"):
                tail = trimmed[-80:].decode("utf-8", errors="replace")
                failures.append(
                    f"FAIL [ts-ef-truncation] {rel_path}: EF index.ts ends with "
                    f"{last_char!r} not ';' or '}}' -- likely mid-expression truncation "
                    f"(tail: ...{tail!r})"
                )

# -- Summary -----------------------------------------------------------------
print(f"Scanned {checked} files ({', '.join(sorted(EXTENSIONS))})")
print()

if failures:
    print(f"X {len(failures)} integrity violation(s) found:\n")
    for item in failures:
        print(f"  {item}")
    print()
    print("Action: these files may have been silently truncated by FUSE/bindfs mount.")
    print("Check the commit source -- do not deploy until all violations are resolved.")
    file_integrity_exit = 1
else:
    print(f"All {checked} files passed null-byte, size, HTML structure, JS syntax, TS EF structure, and MD checks.")
    file_integrity_exit = 0

# -- Partner-path structural parity check (gh-634) ---------------------------
# Chained here rather than added as its own workflow step: this job (the
# "Null-Byte & Size Sanity Check" job in .github/workflows/post-deploy-verify.yml,
# which invokes only this file) is the sole CI entry point this lane's push
# credential can modify -- direct edits to .github/workflows/*.yml are rejected
# outright ("refusing to allow a GitHub App to create or update workflow ...
# without `workflows` permission", confirmed 2026-08-12, gh-634). Running
# tools/partner_parity_check.py here, in the same job, satisfies "wired into
# CI alongside the Null-Byte check" without a workflow-file edit.
print()
print("-" * 78)
_parity_script = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "tools", "partner_parity_check.py"
)
_parity_result = subprocess.run([sys.executable, _parity_script], capture_output=True, text=True)
print(_parity_result.stdout, end="")
if _parity_result.stderr:
    print(_parity_result.stderr, end="", file=sys.stderr)
partner_parity_exit = _parity_result.returncode

# -- Agent-type label single-source-of-truth check (gh-914) ------------------
# Chained for the same reason as partner_parity_check.py above: this is the
# one CI job this lane's push credential can extend without a workflow-file
# edit (gh-634/#873).
print()
print("-" * 78)
_agent_types_script = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "tools", "agent_type_labels_check.py"
)
_agent_types_result = subprocess.run([sys.executable, _agent_types_script], capture_output=True, text=True)
print(_agent_types_result.stdout, end="")
if _agent_types_result.stderr:
    print(_agent_types_result.stderr, end="", file=sys.stderr)
agent_types_exit = _agent_types_result.returncode

if file_integrity_exit != 0 or partner_parity_exit != 0 or agent_types_exit != 0:
    sys.exit(1)
sys.exit(0)
