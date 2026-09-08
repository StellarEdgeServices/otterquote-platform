#!/usr/bin/env python3
"""
schema-column-lint.py — OtterQuote Schema Contract Linter

Catches frontend HTML/JS writes to Supabase columns that do not exist in the
public schema, failing CI before a bad column name reaches production.

Motivation: This bug class surfaced twice in OtterQuote history:
  - coi_document_url vs coi_file_url on contractors (D-210, May 13, 2026)
  - wc_exemption_claimed phantom column (D-210, fixed in commit 23488d0)
Both were silent runtime failures — no build error, no lint catch.

Usage:
  python3 scripts/schema-column-lint.py [--root REPO_ROOT] [--schema sql/schema-snapshot.json]

Exit codes:
  0  — clean (no violations)
  1  — one or more violations found
  2  — configuration error (schema file missing, etc.)

ADR: Docs/ADRs/ADR-010-schema-column-lint.md
"""

import argparse
import difflib
import json
import os
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCHEMA_FILE_DEFAULT = "sql/schema-snapshot.json"

# gh-1314 / PR #1856 REVIEW blocker 2. Columns a merged writer uses whose
# migration is drafted but NOT YET APPLIED. Declared in one greppable file so
# the gap is loud rather than silent, and so it cannot outlive itself:
#   - each entry names the migration file, which must exist;
#   - a declared column that IS already in the snapshot is a STALE declaration
#     and fails the lint until the entry is deleted.
# This is deliberately NOT a suppression list. Before it, the only two ways to
# merge a writer ahead of its migration were to leave `main` red with no owner
# named, or to hide the write behind a non-literal argument -- which downgrades
# a hard violation to a WARN that nobody reads. See the file's own _README.
PENDING_FILE_DEFAULT = "sql/schema-pending.json"

# File extensions to scan
SCAN_EXTENSIONS = {".html", ".js", ".ts", ".tsx", ".jsx"}

# Directories to skip
SKIP_DIRS = {
    ".git", "node_modules", "react-app/node_modules", "tests",
    "e2e", ".github", "democracy", "__pycache__",
}

# Tables whose write column-sets cannot be statically validated
# (dynamic JSONB columns, RPC result tables, etc.)
SKIP_TABLES: set[str] = set()

# Pattern: .from('table').insert/update/upsert/select(
# Handles: sb.from, supabase.from, client.from, any_var.from
FROM_PATTERN = re.compile(
    r'\.from\s*\(\s*[\'"`](\w+)[\'"`]\s*\)\s*\.'
    r'(insert|update|upsert|select)\s*\('
)

# RPC-arg exemption marker (key with this inline comment is not validated)
RPC_ARG_MARKER = re.compile(r'//\s*rpc-arg', re.IGNORECASE)


# ---------------------------------------------------------------------------
# Schema loading
# ---------------------------------------------------------------------------

def load_schema(schema_path: str) -> dict[str, set[str]]:
    """Load schema-snapshot.json → {table_name: {col1, col2, ...}}"""
    if not os.path.exists(schema_path):
        print(f"ERROR: Schema snapshot not found at '{schema_path}'.", file=sys.stderr)
        print("       Regenerate with: python3 scripts/refresh-schema-snapshot.py", file=sys.stderr)
        sys.exit(2)
    with open(schema_path) as f:
        raw = json.load(f)
    return {tbl: set(cols) for tbl, cols in raw.items()}


def load_pending(pending_path: str, schema: dict[str, set[str]]) -> dict[tuple[str, str], dict]:
    """Load sql/schema-pending.json -> {(table, column): entry}.

    Fails hard (exit 2) on a declaration that is malformed, names a migration
    file that does not exist, or has gone stale because the column now exists in
    the snapshot. A gap that has closed must be deleted, not left standing.
    """
    if not os.path.exists(pending_path):
        return {}
    with open(pending_path) as f:
        raw = json.load(f)

    pending: dict[tuple[str, str], dict] = {}
    errors: list[str] = []
    root = os.path.dirname(os.path.dirname(os.path.abspath(pending_path)))
    for table, cols in raw.items():
        if table.startswith("_"):
            continue  # _README and friends
        if not isinstance(cols, dict):
            errors.append(f"{table}: expected an object of column -> entry")
            continue
        for col, entry in cols.items():
            if not isinstance(entry, dict) or "migration" not in entry or "issue" not in entry:
                errors.append(f"{table}.{col}: each entry needs at least 'migration' and 'issue'")
                continue
            mig = os.path.join(root, entry["migration"])
            if not os.path.exists(mig):
                errors.append(
                    f"{table}.{col}: declared migration '{entry['migration']}' does not exist. "
                    "A pending declaration must point at the migration that closes it."
                )
                continue
            if col in schema.get(table, set()):
                errors.append(
                    f"{table}.{col}: STALE declaration — this column IS in the schema snapshot now. "
                    "The migration has landed; delete this entry from sql/schema-pending.json."
                )
                continue
            pending[(table, col)] = entry

    if errors:
        print("ERROR: sql/schema-pending.json is not usable as written:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        sys.exit(2)
    return pending


# ---------------------------------------------------------------------------
# Depth-0 key extractor
# ---------------------------------------------------------------------------

def extract_depth0_keys(
    source: str,
    start_pos: int,
    file_lines: list[str],
) -> tuple[list[tuple[str, int, bool]], bool]:
    """
    Extract top-level property keys from the JS object literal whose opening
    brace is at or after start_pos in source.

    Only emits keys at depth==1 (directly inside the outer object brace), so
    nested JSONB sub-objects like `metadata: { claim_id: x }` do NOT produce
    false-positive column violations for 'claim_id'.

    Also handles ES6 shorthand properties: `{ contractor_id, }` is captured as
    key 'contractor_id' even though there is no explicit `: value`.

    Returns:
        (keys, has_dynamic)
        keys       — list of (key_name, line_1indexed, is_rpc_arg)
        has_dynamic — True if spread (...) or computed ([expr]) keys found;
                      caller should emit a warning and skip column validation.
    """
    brace_start = source.find("{", start_pos)
    if brace_start == -1:
        return [], False

    keys: list[tuple[str, int, bool]] = []
    has_dynamic = False

    depth = 0          # 0 = before opening brace, 1 = inside object, 2+ = nested
    i = brace_start
    in_str = False
    str_ch = None
    in_tmpl = False
    tmpl_brace = 0     # depth of ${...} inside template literal
    at_key_pos = False  # True when the next token should be a property key

    while i < len(source):
        ch = source[i]

        # ── String tracking ──────────────────────────────────────────────
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == str_ch:
                in_str = False
            i += 1
            continue

        # ── Template literal tracking ─────────────────────────────────────
        if in_tmpl:
            if ch == '\\':
                i += 2
                continue
            if ch == '`':
                in_tmpl = False
                i += 1
                continue
            if ch == '$' and i + 1 < len(source) and source[i + 1] == '{':
                tmpl_brace += 1
                i += 2
                continue
            if ch == '}' and tmpl_brace > 0:
                tmpl_brace -= 1
            i += 1
            continue

        # ── Comment skipping ──────────────────────────────────────────────
        if ch == '/' and i + 1 < len(source):
            if source[i + 1] == '/':
                nl = source.find('\n', i + 2)
                i = (nl + 1) if nl != -1 else len(source)
                continue
            if source[i + 1] == '*':
                end = source.find('*/', i + 2)
                i = (end + 2) if end != -1 else len(source)
                continue

        # ── String / template start ───────────────────────────────────────
        if ch in ('"', "'"):
            # If we're at key position inside the object, try to read a quoted key
            if at_key_pos and depth == 1:
                j = i + 1
                while j < len(source):
                    if source[j] == '\\':
                        j += 2
                        continue
                    if source[j] == ch:
                        break
                    j += 1
                # j is at closing quote (or past end of source)
                if j < len(source):
                    key_candidate = source[i + 1 : j]
                    after_q = source[j + 1 : j + 20].lstrip(' \t')
                    if after_q.startswith(':') and not after_q.startswith('::'):
                        abs_line = source[:i].count('\n') + 1
                        line_idx = abs_line - 1
                        src_line = file_lines[line_idx] if line_idx < len(file_lines) else ''
                        is_rpc = bool(RPC_ARG_MARKER.search(src_line))
                        keys.append((key_candidate, abs_line, is_rpc))
                        at_key_pos = False
                        i = j + 1  # past closing quote; loop keeps going to find ':'
                        continue
            in_str = True
            str_ch = ch
            i += 1
            continue

        if ch == '`':
            in_tmpl = True
            i += 1
            continue

        # ── Spread / dynamic markers ──────────────────────────────────────
        if ch == '.' and i + 2 < len(source) and source[i + 1] == '.' and source[i + 2] == '.':
            if depth == 1:
                has_dynamic = True
                at_key_pos = False  # spread target is not a property key
            i += 3
            continue

        # ── Structural brackets ───────────────────────────────────────────
        if ch in ('{', '['):
            if ch == '[' and depth == 1 and at_key_pos:
                has_dynamic = True
            depth += 1
            if depth == 1:  # just opened the outer object brace
                at_key_pos = True
            else:
                at_key_pos = False
            i += 1
            continue

        if ch in ('}', ']'):
            depth -= 1
            if depth == 0:
                break  # closed the outer object — we're done
            i += 1
            continue

        # ── Comma at depth==1 → next token is a key ───────────────────────
        if ch == ',' and depth == 1:
            at_key_pos = True
            i += 1
            continue

        # ── Key detection at depth==1 ─────────────────────────────────────
        if depth == 1 and at_key_pos and ch not in (' ', '\t', '\n', '\r'):
            m = re.match(r'([a-zA-Z_$][\w$]*)', source[i:])
            if m:
                ident = m.group(1)
                after_pos = i + len(ident)
                after_str = source[after_pos : after_pos + 30].lstrip(' \t')

                if after_str.startswith(':') and not after_str.startswith('::'):
                    # Explicit property: key: value
                    abs_line = source[:i].count('\n') + 1
                    line_idx = abs_line - 1
                    src_line = file_lines[line_idx] if line_idx < len(file_lines) else ''
                    is_rpc = bool(RPC_ARG_MARKER.search(src_line))
                    keys.append((ident, abs_line, is_rpc))
                    at_key_pos = False
                    i = after_pos
                    continue

                if (after_str.startswith(',')
                        or after_str.startswith('}')
                        or after_str.startswith('//')
                        or after_str.startswith('/*')
                        or (after_str and after_str[0] in ('\n', '\r'))
                        or not after_str):
                    # Shorthand property: key (no explicit value)
                    abs_line = source[:i].count('\n') + 1
                    line_idx = abs_line - 1
                    src_line = file_lines[line_idx] if line_idx < len(file_lines) else ''
                    is_rpc = bool(RPC_ARG_MARKER.search(src_line))
                    keys.append((ident, abs_line, is_rpc))
                    at_key_pos = False
                    i = after_pos
                    continue

                # Unknown pattern at key position — don't crash, just clear flag
                at_key_pos = False

        i += 1

    return keys, has_dynamic


# ---------------------------------------------------------------------------
# Suggestion engine
# ---------------------------------------------------------------------------

def best_suggestion(bad_col: str, valid_cols: set[str]) -> str | None:
    matches = difflib.get_close_matches(bad_col, valid_cols, n=1, cutoff=0.6)
    return matches[0] if matches else None


# ---------------------------------------------------------------------------
# File scanner
# ---------------------------------------------------------------------------

def scan_file(
    file_path: str,
    source: str,
    schema: dict[str, set[str]],
    violations: list[dict],
    warnings: list[dict],
) -> None:
    file_lines = source.splitlines()

    for m in FROM_PATTERN.finditer(source):
        table = m.group(1)
        operation = m.group(2)

        # Only validate write operations
        if operation == "select":
            continue

        if table in SKIP_TABLES:
            continue

        arg_start = m.end()

        # Skip calls where the first argument is not an inline object literal.
        # e.g. .upsert(payloadVar, { onConflict: ... }) — we'd wrongly pick up
        # the options object. Safe to skip: the dynamic-object warning covers it.
        j = arg_start
        while j < len(source) and source[j] in (' ', '\t', '\n', '\r'):
            j += 1
        if j >= len(source) or source[j] != '{':
            # First arg is a variable/expression, not an object literal — skip
            line_no = source[: m.start()].count("\n") + 1
            warnings.append({
                "file": file_path,
                "line": line_no,
                "table": table,
                "message": (
                    f"Non-literal argument in .{operation}() on '{table}' — "
                    "cannot statically validate columns. Review manually."
                ),
            })
            continue

        if table not in schema:
            line_no = source[: m.start()].count("\n") + 1
            warnings.append({
                "file": file_path,
                "line": line_no,
                "table": table,
                "message": (
                    f"Table '{table}' not found in schema snapshot. "
                    "Verify manually (may be an RPC, view, or typo)."
                ),
            })
            continue

        valid_cols = schema[table]
        keys, has_dynamic = extract_depth0_keys(source, arg_start, file_lines)

        if has_dynamic:
            line_no = source[: m.start()].count("\n") + 1
            warnings.append({
                "file": file_path,
                "line": line_no,
                "table": table,
                "message": (
                    f"Dynamic/spread object in .{operation}() on '{table}' — "
                    "cannot statically validate all keys. Review manually."
                ),
            })

        for key, line_no, is_rpc_arg in keys:
            if is_rpc_arg:
                continue
            if key not in valid_cols:
                suggestion = best_suggestion(key, valid_cols)
                hint = f" (did you mean '{suggestion}'?)" if suggestion else ""
                violations.append({
                    "file": file_path,
                    "line": line_no,
                    "table": table,
                    "bad_col": key,
                    "suggestion": suggestion,
                    "message": f"Column '{key}' does not exist on table '{table}'{hint}",
                })


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="OtterQuote schema column linter")
    parser.add_argument("--root", default=".", help="Repo root to scan (default: .)")
    parser.add_argument(
        "--schema",
        default=SCHEMA_FILE_DEFAULT,
        help=f"Path to schema snapshot JSON (relative to --root; default: {SCHEMA_FILE_DEFAULT})",
    )
    parser.add_argument(
        "--pending",
        default=PENDING_FILE_DEFAULT,
        help=f"Path to the pending-column declarations (relative to --root; default: {PENDING_FILE_DEFAULT})",
    )
    parser.add_argument(
        "--warn-only",
        action="store_true",
        help="Print violations as warnings and exit 0 (for gradual rollout)",
    )
    args = parser.parse_args()

    repo_root = os.path.abspath(args.root)
    schema_path = os.path.join(repo_root, args.schema)
    schema = load_schema(schema_path)
    pending = load_pending(os.path.join(repo_root, args.pending), schema)

    violations: list[dict] = []
    warnings: list[dict] = []
    files_scanned = 0

    for dirpath, dirnames, filenames in os.walk(repo_root):
        rel_dir = os.path.relpath(dirpath, repo_root)
        # Prune excluded directories in-place (affects os.walk recursion)
        dirnames[:] = [
            d for d in dirnames
            if d not in SKIP_DIRS
            and not any(rel_dir.startswith(skip) for skip in SKIP_DIRS)
        ]

        for fname in filenames:
            ext = Path(fname).suffix.lower()
            if ext not in SCAN_EXTENSIONS:
                continue
            full_path = os.path.join(dirpath, fname)
            rel_path = os.path.relpath(full_path, repo_root)
            try:
                with open(full_path, encoding="utf-8", errors="replace") as f:
                    source = f.read()
            except OSError:
                continue
            scan_file(rel_path, source, schema, violations, warnings)
            files_scanned += 1

    # ── Output ────────────────────────────────────────────────────────────
    for w in sorted(warnings, key=lambda x: (x["file"], x["line"])):
        print(f"WARN  {w['file']}:{w['line']} — {w['message']}")

    # gh-1314: a violation whose column is DECLARED pending is reported loudly on
    # its own line, every run, and does not fail the build. Everything else is
    # still a hard failure.
    pending_hits = [v for v in violations if (v["table"], v["bad_col"]) in pending]
    violations = [v for v in violations if (v["table"], v["bad_col"]) not in pending]

    for v in sorted(pending_hits, key=lambda x: (x["file"], x["line"])):
        entry = pending[(v["table"], v["bad_col"])]
        print(
            f"PENDING  {v['file']}:{v['line']} — column '{v['bad_col']}' on '{v['table']}' is not in the "
            f"schema snapshot yet; declared in {PENDING_FILE_DEFAULT} against {entry['migration']} "
            f"({entry['issue']}). This is a DECLARED gap, not a clean bill of health: the writer is "
            f"merged and the migration is not applied."
        )

    for v in sorted(violations, key=lambda x: (x["file"], x["line"])):
        print(f"FAIL  {v['file']}:{v['line']} — {v['message']}")

    print(f"\n{'─' * 60}")
    print(
        f"Scanned {files_scanned} files | "
        f"{len(violations)} violation(s) | "
        f"{len(pending_hits)} pending | "
        f"{len(warnings)} warning(s)"
    )
    if pending_hits:
        print(
            f"{len(pending_hits)} write(s) target columns whose migration has NOT been applied. "
            "Apply the migrations named above, refresh sql/schema-snapshot.json, then delete their "
            "entries from sql/schema-pending.json — a stale declaration fails this check."
        )

    if violations:
        print("Schema contract check FAILED.")
        return 0 if args.warn_only else 1

    print("Schema contract check PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
