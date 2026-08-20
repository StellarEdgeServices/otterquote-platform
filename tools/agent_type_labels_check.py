#!/usr/bin/env python3
"""Agent-type label single-source-of-truth guard (gh-914).

gh-914 found 16 independent agent-type label-map declarations across 14
files (#851's class one layer up — a hardcoded partner-role LIST duplicated
three ways; this is the display-STRING map duplicated five ways). The fix
consolidated them into two canonical sources:

  - js/agent-types.js            (static HTML pages load this via <script>)
  - react-app/app/lib/agent-types.ts  (the React app imports from this)

Each declares four purpose-scoped maps (CHOOSER_LABELS, PARTNER_DISPLAY_LABELS,
ADMIN_DROPDOWN_LABELS, ADMIN_BADGE — see either file's header comment for why
four, not one). This script is the AC3 guard: it (1) parses both canonical
files and asserts their four maps agree key-for-key, and (2) scans the rest
of the repo for a re-introduced local label map, so the next regression is a
CI failure on the introducing PR rather than a 14-file audit.

Chained here (tools/agent_type_labels_check.py), invoked from
scripts/ci-file-integrity.py, rather than added as its own workflow step:
that script's job ("Null-Byte & Size Sanity Check" in
.github/workflows/post-deploy-verify.yml) is the sole CI entry point this
lane's push credential can modify -- direct edits to .github/workflows/*.yml
are rejected outright (gh-634/#873). Same mechanism gh-634's
partner_parity_check.py already uses.

Exit codes:
  0 -- single source of truth intact (both files agree, no rogue maps found)
  1 -- diverged, or a new label map was found outside the canonical files
"""
from __future__ import annotations

import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

JS_CANONICAL = os.path.join(REPO_ROOT, "js", "agent-types.js")
TS_CANONICAL = os.path.join(REPO_ROOT, "react-app", "app", "lib", "agent-types.ts")

# JS var name -> TS export name, for the four maps each file declares.
MAP_NAME_PAIRS = [
    ("AGENT_TYPE_CHOOSER_LABELS", "CHOOSER_LABELS"),
    ("AGENT_TYPE_PARTNER_DISPLAY_LABELS", "PARTNER_DISPLAY_LABELS"),
    ("AGENT_TYPE_ADMIN_DROPDOWN_LABELS", "ADMIN_DROPDOWN_LABELS"),
    ("AGENT_TYPE_ADMIN_BADGE", "ADMIN_BADGE"),
]

AGENT_TYPE_KEYS = (
    "re_agent",
    "insurance_agent",
    "home_inspector",
    "customer",
    "adjuster",
    "other",
)

# Entry shapes: a plain string label, or a { label: '...', className: '...' } badge.
ENTRY_RE = re.compile(
    r"""(['"]?)(re_agent|insurance_agent|home_inspector|customer|adjuster|other)\1\s*:\s*
    (?:
        \{\s*label\s*:\s*(['"])(?P<blabel>(?:(?!\3).)*)\3\s*,\s*className\s*:\s*(['"])(?P<bclass>(?:(?!\5).)*)\5\s*\}
      | (['"])(?P<label>(?:(?!\7).)*)\7
    )
    """,
    re.VERBOSE,
)


def extract_block(text: str, var_name: str) -> str | None:
    """Return the `{...}` block text following `var_name = ` (JS `var X = {`
    or TS `export const X: ... = {`), via brace matching."""
    m = re.search(re.escape(var_name) + r"\s*(?::[^=]+)?=\s*\{", text)
    if not m:
        return None
    start = text.rfind("{", 0, m.end())
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def parse_map(block: str) -> dict[str, tuple[str, str | None]]:
    """Return {key: (label, className-or-None)} for every agent-type key in block."""
    out: dict[str, tuple[str, str | None]] = {}
    for m in ENTRY_RE.finditer(block):
        key = m.group(2)
        if m.group("blabel") is not None:
            out[key] = (m.group("blabel"), m.group("bclass"))
        else:
            out[key] = (m.group("label"), None)
    return out


def check_agreement() -> list[str]:
    failures: list[str] = []
    if not os.path.isfile(JS_CANONICAL):
        return [f"canonical file missing: {JS_CANONICAL}"]
    if not os.path.isfile(TS_CANONICAL):
        return [f"canonical file missing: {TS_CANONICAL}"]

    js_text = open(JS_CANONICAL, encoding="utf-8").read()
    ts_text = open(TS_CANONICAL, encoding="utf-8").read()

    for js_name, ts_name in MAP_NAME_PAIRS:
        js_block = extract_block(js_text, js_name)
        ts_block = extract_block(ts_text, ts_name)
        if js_block is None:
            failures.append(f"js/agent-types.js: could not find `{js_name}`")
            continue
        if ts_block is None:
            failures.append(f"react-app/app/lib/agent-types.ts: could not find `{ts_name}`")
            continue
        js_map = parse_map(js_block)
        ts_map = parse_map(ts_block)
        if not js_map:
            failures.append(f"js/agent-types.js: `{js_name}` parsed to zero entries -- check ENTRY_RE against its format")
            continue
        if not ts_map:
            failures.append(f"react-app/app/lib/agent-types.ts: `{ts_name}` parsed to zero entries -- check ENTRY_RE against its format")
            continue
        all_keys = set(js_map) | set(ts_map)
        for key in sorted(all_keys):
            js_val = js_map.get(key)
            ts_val = ts_map.get(key)
            if js_val != ts_val:
                failures.append(
                    f"{js_name} / {ts_name} disagree on '{key}': "
                    f"js/agent-types.js={js_val!r} vs react-app/app/lib/agent-types.ts={ts_val!r}"
                )
    return failures


# -- Rogue-map scan -----------------------------------------------------------
# Directories never worth scanning (deps, build output, git internals).
EXCLUDE_DIRS = {".git", "node_modules", ".next", "dist", "build", "coverage", "otterquote-deploy"}
SCAN_EXTENSIONS = (".html", ".js", ".ts", ".tsx")
CANONICAL_RELATIVE = {
    os.path.normpath("js/agent-types.js"),
    os.path.normpath("react-app/app/lib/agent-types.ts"),
}

# A key:value pair whose value looks like a path/filename/URL, not a display
# label -- e.g. recruit.html's DESTINATIONS map (`re_agent: 'partner-re.html'`)
# or partner-dashboard.html's onepager-asset map. Real agent-type labels are
# short human phrases ("Real Estate Agent"); genuinely unrelated maps that
# happen to reuse these six enum values as keys are excluded by this filter
# rather than by an explicit allowlist, so a *new* routing/asset map doesn't
# need this script updated to stay green.
def _looks_like_path(value: str) -> bool:
    return value.startswith("/") or ".html" in value or value.endswith(".js") or value.endswith(".ts")


WINDOW_LINES = 20
MIN_DISTINCT_KEYS = 3


def scan_for_rogue_maps() -> list[str]:
    failures: list[str] = []
    for root, dirs, files in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for fn in files:
            if not fn.endswith(SCAN_EXTENSIONS):
                continue
            abs_path = os.path.join(root, fn)
            rel_path = os.path.normpath(os.path.relpath(abs_path, REPO_ROOT))
            if rel_path in CANONICAL_RELATIVE:
                continue
            try:
                with open(abs_path, encoding="utf-8", errors="ignore") as f:
                    lines = f.read().splitlines()
            except OSError:
                continue

            # (line_index, key) for every non-path-looking agent-type entry.
            entries: list[tuple[int, str]] = []
            for i, line in enumerate(lines):
                for m in ENTRY_RE.finditer(line):
                    label = m.group("blabel") if m.group("blabel") is not None else m.group("label")
                    if not _looks_like_path(label):
                        entries.append((i, m.group(2)))

            i = 0
            while i < len(entries):
                window_start_line = entries[i][0]
                keys_in_window: set[str] = set()
                j = i
                while j < len(entries) and entries[j][0] - window_start_line <= WINDOW_LINES:
                    keys_in_window.add(entries[j][1])
                    j += 1
                if len(keys_in_window) >= MIN_DISTINCT_KEYS:
                    failures.append(
                        f"{rel_path}:{window_start_line + 1}: found {len(keys_in_window)} distinct "
                        f"agent-type label keys ({', '.join(sorted(keys_in_window))}) within "
                        f"{WINDOW_LINES} lines -- looks like a re-introduced local label map. "
                        f"Import from js/agent-types.js (static HTML) or "
                        f"react-app/app/lib/agent-types.ts (React) instead."
                    )
                    i = j  # don't re-report the same cluster entry-by-entry
                else:
                    i += 1
    return failures


def main() -> int:
    failures = check_agreement()
    failures += scan_for_rogue_maps()

    if failures:
        print("FAIL: agent-type label single-source-of-truth check (gh-914):")
        for f in failures:
            print(f"  - {f}")
        return 1

    print(
        "PASS: js/agent-types.js and react-app/app/lib/agent-types.ts agree on all "
        f"{len(MAP_NAME_PAIRS)} maps, and no rogue agent-type label map was found elsewhere."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
