#!/usr/bin/env python3
"""
innerHTML escape guard (gh-1436).

Fails CI when a served page interpolates a claim.* / profiles.* field into an
innerHTML template without HTML-escaping it first.

Why this exists: gh-1436 was a cross-role stored XSS — homeowner-typed free
text (damage_type, damage_description, property_address, profile full_name)
rendered bare into `el.innerHTML = ...` template literals on contractor-facing
pages. CodeQL never flagged those files (the issue's own title), so the only
automated guard was one already proven blind to the pattern. This check is the
regression gate the reopen demanded: a PR that introduces a bare `${claim.x}`
or `${profiles.y}` (or the string-concat equivalent `+ claim.x +`) inside an
innerHTML assignment fails the Null-Byte & Size Sanity Check job, which chains
this script via scripts/ci-file-integrity.py.

What it detects
  1. For every `.innerHTML =` / `.innerHTML +=` assignment in served .html/.js
     files, the full statement is captured with a small JS-aware scanner
     (string / template-literal / comment / regex-literal aware, bracket-depth
     tracked, so multi-hundred-line `el.innerHTML = rows.map(...).join('')`
     statements are captured whole).
  2. Inside the captured statement, every CODE-context occurrence of
         claim.<field>  |  currentClaim.<field>  |  profiles.<field>
         |  <alias>.profiles.<field>            (e.g. msg.profiles.full_name)
     in a VALUE-FLOW position — inside a `${...}` template interpolation,
     as a `+` string-concat operand, or as the whole right-hand side of the
     assignment — is a violation unless it is:
       a. wrapped in a sanctioned escape helper (escapeHtml / escHtml /
          escHtmlBid / esc / encodeURIComponent) somewhere in its call chain;
       b. a SAFE_FIELD (server-generated, never user-typed: `id`);
       c. explicitly allowlisted below (verified-escaped call sites the
          scanner cannot prove safe).
     Template-literal text and string-literal content are NOT code context, so
     `?claim_id=` inside an href string never false-positives; `${claim.x}`
     interpolation expressions ARE code context, so they do. Comparison uses
     inside a map callback (`currentClaim.job_type === 'retail' ? ...`) are
     code context but NOT value-flow — their results are constants — so they
     do not flag.

Known limits (documented, deliberate):
  - Mapped aliases (bid.location, lead.material, o.location, ...) are NOT
    tainted roots — taint does not flow through `const o = {location: city}`.
    Those sites were escaped in the gh-1436 fix PRs; this guard pins the
    canonical roots the refuter named (claim.* / profiles.*) so the next page
    that renders straight from a claims row or a profiles join fails CI.
  - react-app/ is excluded: JSX text nodes auto-escape.

Usage: python3 tools/innerhtml_escape_check.py [--root DIR]
Exit 0 = clean, 1 = violations found.
"""
import argparse
import os
import re
import sys

EXCLUDE_DIRS = {".git", "node_modules", "react-app", "tests", "democracy", "docs", "Docs"}
EXTENSIONS = {".html", ".js"}

# Escape helpers in use across the codebase (house idioms).
SAFE_WRAPPERS = ("escapeHtml", "escHtml", "escHtmlBid", "esc", "encodeURIComponent")

# Fields that are server-generated and can never carry user-typed markup.
SAFE_FIELDS = {"id"}

# (relative_path, stripped_line_snippet) pairs verified safe by a human.
# Keep SMALL — every entry needs a comment saying why it is safe.
ALLOWLIST = set()

INNERHTML_RE = re.compile(r"\.innerHTML\s*(?:\+=|=(?!=))")
TAINT_RE = re.compile(
    r"(?:\b(?:claim|currentClaim)|(?:\b[A-Za-z_$][\w$]*)?\.?\bprofiles)\.([A-Za-z_$][\w$]*)"
)
WRAPPER_RE = re.compile(r"\b(?:" + "|".join(SAFE_WRAPPERS) + r")\s*\(")

# Chars that, as the previous non-space char, mean a following '/' starts a
# regex literal rather than division (standard JS heuristic).
REGEX_PRECEDERS = set("(,=:[!&|?{};+-*%~^<>\n")


def scan_statement(text, start):
    """Scan a JS statement from `start`, returning (end, code_mask, interp_mask).

    code_mask[i] is True when text[start + i] is CODE context (not inside a
    string literal, template-literal text, comment, or regex literal).
    interp_mask[i] is True when the offset is code inside a `${...}` template
    interpolation (at any nesting depth) — i.e. its value flows into a string.
    Statement ends at a ';' in top-level code at bracket depth 0, or at EOF,
    or after a 40k-char safety cap.
    """
    CAP = 40000
    n = min(len(text), start + CAP)
    i = start
    # Frame stack: each frame is ["code", brace_depth] or ["template"].
    # A "code" frame pushed by `${` pops back to its template on its `}`.
    stack = [["code", 0]]
    depth = 0  # (), [] depth across top-level code
    mask = []
    interp = []
    prev_code_char = "="  # the assignment operator precedes us

    def push_mask(is_code):
        mask.append(is_code)
        # Only `${` pushes "code" frames above the base frame, so a code
        # offset with stack depth > 1 and a code top is interpolation code.
        interp.append(is_code and len(stack) > 1 and stack[-1][0] == "code")

    while i < n:
        c = text[i]
        top = stack[-1]

        if top[0] == "code":
            nxt = text[i + 1] if i + 1 < n else ""
            if c == "/" and nxt == "/":
                # line comment
                j = text.find("\n", i)
                j = n if j == -1 else j
                for _ in range(i, j):
                    push_mask(False)
                i = j
                continue
            if c == "/" and nxt == "*":
                j = text.find("*/", i + 2)
                j = n - 2 if j == -1 else j
                for _ in range(i, j + 2):
                    push_mask(False)
                i = j + 2
                continue
            if c == "/" and prev_code_char in REGEX_PRECEDERS:
                # regex literal
                push_mask(False)
                i += 1
                in_class = False
                while i < n:
                    push_mask(False)
                    rc = text[i]
                    if rc == "\\":
                        i += 2
                        push_mask(False)
                        continue
                    if rc == "[":
                        in_class = True
                    elif rc == "]":
                        in_class = False
                    elif rc == "/" and not in_class:
                        i += 1
                        break
                    i += 1
                continue
            if c in "'\"":
                quote = c
                push_mask(True)  # the quote itself is code punctuation
                i += 1
                while i < n:
                    push_mask(False)
                    if text[i] == "\\":
                        i += 2
                        push_mask(False)
                        continue
                    if text[i] == quote:
                        mask[-1] = True
                        i += 1
                        break
                    i += 1
                prev_code_char = quote
                continue
            if c == "`":
                stack.append(["template"])
                push_mask(True)
                i += 1
                continue
            if c == "{":
                top[1] += 1
            elif c == "}":
                if top[1] == 0 and len(stack) > 1:
                    # closes a ${ expr } — back to template text
                    stack.pop()
                    push_mask(True)
                    i += 1
                    continue
                top[1] -= 1
            elif c in "([":
                if len(stack) == 1:
                    depth += 1
            elif c in ")]":
                if len(stack) == 1:
                    depth -= 1
            elif c == ";" and len(stack) == 1 and depth <= 0 and top[1] == 0:
                push_mask(True)
                return i + 1 - start, mask, interp
            push_mask(True)
            if not c.isspace():
                prev_code_char = c
            i += 1
            continue

        # template-literal text
        if c == "\\":
            push_mask(False)
            push_mask(False)
            i += 2
            continue
        if c == "`":
            stack.pop()
            push_mask(True)
            i += 1
            continue
        if c == "$" and i + 1 < n and text[i + 1] == "{":
            stack.append(["code", 0])
            push_mask(True)
            push_mask(True)
            i += 2
            prev_code_char = "{"
            continue
        push_mask(False)
        i += 1

    return n - start, mask, interp


def wrapper_spans(stmt, mask):
    """Spans (start, end) inside stmt covered by a sanctioned escape call."""
    spans = []
    for m in WRAPPER_RE.finditer(stmt):
        if m.start() >= len(mask) or not mask[m.start()]:
            continue
        # walk from the '(' to its matching ')' counting only code-context parens
        d = 0
        j = m.end() - 1
        while j < len(stmt):
            if j < len(mask) and mask[j]:
                if stmt[j] == "(":
                    d += 1
                elif stmt[j] == ")":
                    d -= 1
                    if d == 0:
                        break
            j += 1
        spans.append((m.start(), j + 1))
    return spans


def _adjacent_concat(stmt, mask, s, e):
    """True when the taint expression at [s, e) is a `+` concat operand.

    Walks outward over whitespace, string-literal bytes, quotes, `(`/`)`, and
    `|` (the `(claim.x || 'N/A')` default idiom) looking for a `+`."""
    skippable = set("'\")(|")
    j = s - 1
    while j >= 0 and (stmt[j].isspace() or not mask[j] or stmt[j] in "('"):
        j -= 1
    if j >= 0 and stmt[j] == "+":
        return True
    j = e
    while j < len(stmt) and (stmt[j].isspace() or not mask[j] or stmt[j] in skippable):
        j += 1
    return j < len(stmt) and stmt[j] == "+"


def check_file(fpath, rel_path):
    try:
        text = open(fpath, "r", encoding="utf-8", errors="replace").read()
    except OSError as e:
        return [f"FAIL [unreadable] {rel_path}: {e}"]

    violations = []
    for am in INNERHTML_RE.finditer(text):
        stmt_start = am.end()
        length, mask, interp = scan_statement(text, stmt_start)
        stmt = text[stmt_start:stmt_start + length]
        spans = wrapper_spans(stmt, mask)
        for tm in TAINT_RE.finditer(stmt):
            s, e = tm.start(), tm.end()
            if s >= len(mask) or not all(mask[k] for k in range(s, min(e, len(mask)))):
                continue  # not code context (string/template text/comment)
            if tm.group(1) in SAFE_FIELDS:
                continue
            if any(ws <= s and e <= we for ws, we in spans):
                continue  # escaped via sanctioned wrapper
            # Value-flow gate: only flag taint whose value reaches the HTML
            # string — `${...}` interpolation code, a `+` concat operand, or
            # the bare right-hand side of the assignment. Comparison/branching
            # uses inside map callbacks produce constants and do not flag.
            in_interp = s < len(interp) and interp[s]
            leading = stmt[:s].strip() == ""
            if not (in_interp or leading or _adjacent_concat(stmt, mask, s, e)):
                continue
            abs_pos = stmt_start + s
            line_no = text.count("\n", 0, abs_pos) + 1
            line_start = text.rfind("\n", 0, abs_pos) + 1
            line_end = text.find("\n", abs_pos)
            line_end = len(text) if line_end == -1 else line_end
            snippet = text[line_start:line_end].strip()
            if (rel_path, snippet) in ALLOWLIST:
                continue
            violations.append(
                f"FAIL [bare-interpolation] {rel_path}:{line_no}: "
                f"`{tm.group(0)}` rendered into innerHTML without escaping "
                f"-- wrap in escapeHtml()/escHtml() or render via textContent "
                f"(snippet: {snippet[:120]!r})"
            )
    return violations


def main():
    ap = argparse.ArgumentParser(description="innerHTML escape guard (gh-1436)")
    ap.add_argument("--root", default=".", help="directory to scan (default: repo root)")
    args = ap.parse_args()

    all_violations = []
    checked = 0
    for root, dirs, files in os.walk(args.root):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for fname in files:
            if os.path.splitext(fname)[1].lower() not in EXTENSIONS:
                continue
            fpath = os.path.join(root, fname)
            rel_path = os.path.relpath(fpath, args.root).replace("\\", "/")
            checked += 1
            all_violations.extend(check_file(fpath, rel_path))

    print(f"innerHTML escape guard (gh-1436): scanned {checked} files (.html, .js)")
    if all_violations:
        print(f"X {len(all_violations)} bare claim.*/profiles.* interpolation(s) inside innerHTML:\n")
        for v in all_violations:
            print(f"  {v}")
        print()
        print("These fields carry user-typed free text; rendering them bare into")
        print("innerHTML is stored XSS (gh-1436). Escape at the sink or use textContent.")
        return 1
    print("All innerHTML claim.*/profiles.* interpolations are escaped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
