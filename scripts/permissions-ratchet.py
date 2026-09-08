#!/usr/bin/env python3
r"""
permissions-ratchet.py -- gh-1767 CI gate: fail a PR that ADDS a GRANT of
EXECUTE/DML to anon or PUBLIC (or authenticated), that combines newly setting
a function SECURITY DEFINER with a grant to a non-service role, or that widens
a RLS policy's USING/WITH CHECK to unconditional `true`.

WHY THIS EXISTS (gh-1767, Refs #1701, #1634)
---------------------------------------------
The only thing that previously noticed `GRANT EXECUTE ON FUNCTION
public.<x>() TO anon` was R-120's `money-permission` branch
(scripts/r177/predicate.mjs, formerly scripts/r120/verify.mjs before PR
#1803), and it only noticed by accident -- it fires because the function's
NAME happens to match MONEY_IDENT_RE. That is false comfort in both
directions:
  - It MISSES the dangerous cases: `GRANT EXECUTE ON FUNCTION
    public.admin_delete_user() TO anon;` contains no money word and sails
    through untouched. This is this file's own negative control -- see
    scripts/permissions-ratchet-fixtures/negative_control_no_money_word_bad.sql
    and --self-test.
  - It OVER-FIRES on the safe ones: PR #1634 (merged as gh1529, "revoke anon
    EXECUTE on 23 of 29 orphaned SECURITY DEFINER functions") is entirely
    REVOKE statements -- the correct direction -- and produced 20 identical
    R-120 rows because the operand names contain commission/payout/rebate/
    fee_.

Per the issue's own instruction, the `money-permission` branch in
scripts/r177/predicate.mjs is NOT removed by this change -- that is its own
follow-up, itself a GATE_FILE change needing its own signature (gh-1767 issue
body, "What was decided on the predicate PR"). This file exists alongside it.

RATCHET, NOT A SCANNER
-----------------------
This only looks at lines a PR's diff ADDS to supabase/migrations/**/*.sql
(literal scope -- see SCOPE NOTE below). It never fails on a pre-existing
statement already on `main`, no matter how it reads -- exactly the migrations
-reconciliation-check.py precedent (gh-1438): "this ratchet's only job is to
stop a PR from making the gap worse," not to retroactively fail the repo's
existing 150+ migration files.

Three rules, each evaluated per-statement against the NEW version of a
changed file, but only for statements that intersect at least one added line
(see `diff_added_line_numbers` / `statements_touched_by_diff`):

  1. GRANT ... TO <role>[, <role> ...] on anything (FUNCTION, TABLE, SEQUENCE,
     SCHEMA, ALL TABLES/SEQUENCES IN SCHEMA, ...) -- passes only if every
     named role is on ALLOWLISTED_GRANT_ROLES, or the PR carries
     BYPASS_LABEL. REVOKE always passes, unconditionally, regardless of the
     role list -- that asymmetry (REVOKE-to-anon is the FIX, GRANT-to-anon is
     the DEFECT) is the whole point of gh-1767 and is what the #1634
     forward/rollback pair in the closing criterion demonstrates.
     UNANCHORED (gh-1767 fix2, PR #1836 comment 5578401122 probe (f)): a
     statement is classified as GRANT-shaped or REVOKE-shaped by whether
     `\bGRANT\b` / `\bREVOKE\b` appears ANYWHERE in it (REVOKE checked
     first), not only at statement-start. The original `^\s*GRANT\b` anchor
     let `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON
     FUNCTIONS TO anon;` -- a fully static, non-dynamic, executable grant --
     ship clean, because that statement starts with ALTER, never GRANT. The
     unanchored scan catches that (and any future prefix: `CREATE ... WITH
     GRANT`, etc.) while still passing the REVOKE direction of the same
     phrasing (`ALTER DEFAULT PRIVILEGES ... REVOKE ... FROM anon;` --
     REVOKE-shaped, checked first) and the one legitimate statement whose
     text contains the word GRANT while still being a REVOKE (`REVOKE GRANT
     OPTION FOR ... FROM anon;` -- starts with REVOKE, so it is
     REVOKE-shaped before rule 1 ever looks for a GRANT clause). Both checks
     run against `stmt.stripped`, which already has every comment/string/
     dollar-quote span blanked by strip_noise() before statement-splitting,
     so a stray GRANT/REVOKE token inside a string or comment can never
     trigger this rule -- that is rule 4's separate job, immediately below.
  2. ALTER FUNCTION ... SECURITY DEFINER (or CREATE OR REPLACE FUNCTION ...
     SECURITY DEFINER, which has identical alter-semantics for a function
     that already exists) newly appearing in the SAME file's added
     statements as a GRANT naming any role outside ALLOWLISTED_GRANT_ROLES.
     This is deliberately broader than rule 1's dangerous-role set --
     "non-service role" per the issue body, not just anon/PUBLIC/
     authenticated -- because elevating a function to run with the owner's
     privileges and then handing EXECUTE to anything other than
     service_role is a privilege-escalation smell independent of which
     specific role receives it.
  3. CREATE POLICY whose USING or WITH CHECK collapses to unconditional
     `true` (any whitespace/casing). Modeled on the issue's literal wording
     ("widening an existing policy's USING/WITH CHECK to true") -- this repo
     never uses ALTER POLICY to change a predicate in place (grep confirms
     zero occurrences across supabase/migrations/), so a widening always
     surfaces in this repo's own convention as a fresh CREATE POLICY
     statement (typically preceded by its own DROP POLICY, which this rule
     does not need to see -- only the newly-added CREATE POLICY matters).
  4. DYNAMIC SQL (PR #1836 comment 5578275973, probe (g) -- a confirmed,
     reproducible evasion, not a hypothetical): a GRANT ... TO <role> can be
     issued from inside a string that is EXECUTE'd rather than written as a
     literal top-level statement, e.g.
       DO $$ BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO anon';
       END $$;
     or the same thing via `EXECUTE format('GRANT ... TO %I', role_expr)`.
     Rules 1-3 run on statements produced by splitting the NOISE-STRIPPED
     text on top-level ';' -- and strip_noise() blanks the CONTENTS of every
     quoted/dollar-quoted span BEFORE that split, by design (see "Comment /
     string-literal / dollar-quote stripping" below), so a GRANT living
     inside a string is invisible to rules 1-3 no matter how it is quoted.
     Rule 4 closes that gap the simple, safe way rather than trying to
     parse "is this string actually EXECUTE'd" (which would require
     understanding PERFORM/EXECUTE/format()/RAISE/etc. call sites -- a full
     SQL interpreter, not a diff-scoped ratchet): it scans the RAW,
     UN-blanked content of every single-quoted and dollar-quoted span that
     intersects an added line (`find_dynamic_sql_grant_findings`,
     `strip_noise_and_collect`) for a `GRANT ... TO <role-list>` shape,
     independent of whether that span is provably executed. Two outcomes:
       - The TO clause names a literal role not on ALLOWLISTED_GRANT_ROLES
         (e.g. `TO anon`, including when only the object name is
         parameterised, `format('GRANT ... TO anon', fn)`) -> FAILS as
         `dynamic-sql-grant`.
       - The TO clause is itself a format()-style placeholder (`TO %I`,
         `TO %1$I`, ...) bound to a variable, so the role cannot be
         statically read off the migration text -- FAILS CLOSED as
         `dynamic-sql-grant-unknown-role` rather than passing for lack of a
         matchable role name.
     REVOKE is unaffected (the regex only fires on GRANT, never REVOKE),
     preserving the same asymmetry as rule 1.
     CONCATENATION-AWARE (gh-1767 fix2, PR #1836 comment 5578401122 probes
     (a)/(e), and the follow-up work order's own `quote_ident(r)` example):
     the original single-span scan missed a role supplied via `||` string
     concatenation. Two mechanisms close this, because the concatenation
     shows up in two structurally different ways --
       - TOP-LEVEL: `EXECUTE 'GRANT ... TO ' || 'anon';` is TWO separate
         literal_spans (each single-quoted region is its own span).
         `_group_concatenated_spans` merges spans separated by nothing but
         `\s*\|\|\s*` (comments in between already blanked to whitespace)
         into one logical string by joining their `.content` fields
         directly, regardless of which side of the `TO` keyword the split
         falls on.
       - NESTED (the more realistic real-world shape): a concatenation
         written INSIDE a `$$...$$` PL/pgSQL body (e.g. `CREATE FUNCTION
         ... AS $$ ... EXECUTE '...' || quote_ident(r); ... $$`) is never
         split into separate spans at all -- dollar-quoted content is raw
         and is not re-parsed for quotes nested inside it, so the inner
         `'...'` literal's quote characters are just ordinary characters
         inside the outer span's content. `_collapse_literal_concat`
         collapses `'...' || '...'` glue (both sides literals) to nothing
         within that raw content, joining the segments; `_UNRESOLVED_CONCAT_RE`
         separately catches the case where the left side is a literal
         ending in an incomplete GRANT...TO clause and the right side is
         NOT a literal (a function call, a variable) -- the role "arrives
         from elsewhere" and can never be read statically off the migration
         text, so this FAILS CLOSED as `dynamic-sql-grant-unknown-role`
         rather than silently passing for lack of a match (the original bug:
         `EXECUTE 'GRANT ... TO ' || 'anon';`'s first span alone captured
         only the trailing whitespace before its closing quote as "roles",
         which `_dynamic_roles()` correctly reduced to an empty list, but
         nothing treated an EMPTY role list as a violation -- it silently
         fell through as a pass). A positive control
         (`dynamic_sql_grant_concat_service_role_good.sql`) confirms the
         merge logic actually resolves and allowlist-checks the role rather
         than failing closed unconditionally on every concatenated GRANT.
     ACCEPTED FALSE-POSITIVE COST: because rule 4 does not distinguish
     "this quoted span is executed" from "this quoted span is merely a
     string constant" (e.g. logged via RAISE NOTICE, or an audit-log
     message), a migration that logs the literal text
     "GRANT EXECUTE ON FUNCTION x() TO anon" as a warning/reminder also
     fails rule 4 -- see
     scripts/permissions-ratchet-fixtures/dollar_quoted_body_with_grant_text_bad.sql.
     This is deliberate, not an oversight: this shape is rare (grep across
     this repo's migration history finds zero real occurrences), the
     `permissions-ratchet: reviewed` bypass label exists precisely for a
     human to clear a reviewed false positive like this one, and the
     alternative -- trying to determine "provably executed" -- reopens
     exactly the evasion this rule exists to close.

ALLOWLIST -- what's on it and why (issue: "enumerate current grants in
supabase/migrations and justify each allowlisted role")
------------------------------------------------------------------------
    grep -rhoE '\bGRANT\b[^;]*\bTO\b\s+[A-Za-z0-9_", ]+' supabase/migrations/
      | grep -oE 'TO\s+[A-Za-z0-9_", ]+' | sed 's/[",]//g' | tr -s ' ' | sort -u
  -> TO PUBLIC / TO anon / TO anon authenticated / TO authenticated /
     TO service_role
Exactly ONE role, besides the three this ratchet exists to gate
(anon/PUBLIC/authenticated), is ever granted anything in this repo's
migration history: `service_role`, confirmed at two call sites
(20260501004321_v65_d199_bid_can_submit.sql:93,
20260905044823_gh1531_cron_vault_resync.sql:62) plus three RLS policies in
the v000 baseline schema -- Supabase's own backend/webhook/cron role, never
reachable from a client request. ALLOWLISTED_GRANT_ROLES is therefore
`{"service_role"}` and nothing else; anon/PUBLIC/authenticated are
deliberately never added to it -- that would defeat the entire ratchet. Any
role this repo has NEVER granted anything to (a typo, a new custom role
nobody has reviewed) is conservatively treated the same as anon/PUBLIC/
authenticated -- not on the allowlist, so it fails rule 1 too -- per this
repo's stated preference (detector-negative-control-check.py's own
docstring) for failing toward a visible gap rather than silently widening
what counts as safe.

BYPASS -- the `permissions-ratchet: reviewed` label
-----------------------------------------------------
A human who has actually read the diff and wants it to ship anyway labels
the PR `permissions-ratchet: reviewed`. This is read from the `pull_request`
event's label list in the workflow (`github.event.pull_request.labels`,
passed to this script as `--labels`), never re-derived by this script from
any other source. A bypass NEVER makes a violation vanish quietly: every
bypassed finding is still printed, prefixed `BYPASSED`, inside a loud banner,
and the run's own summary line says how many were bypassed. This applies
uniformly to all three rules -- the issue's "What to build" section states
the label bypass once, in general "ratchet semantics" terms, not scoped to
rule 1 only.

SCOPE NOTE -- supabase/migrations/** literal, migrations_drafts/ and
migrations_rollbacks/ excluded, deliberately
-------------------------------------------------------------------------
The issue body says "A CI check over `supabase/migrations/**`" verbatim.
`supabase/migrations_drafts/` and `supabase/migrations_rollbacks/` are SIBLING
directories of `supabase/migrations/` (confirmed: `find supabase -maxdepth 1
-type d` lists migrations, migrations_drafts, migrations_rollbacks as three
separate top-level entries, not one nested under another) -- `supabase/
migrations/**` does not glob-match either of them, and this script's
MIGRATIONS_PATH_RE below matches only the literal `supabase/migrations/`
prefix, so they are out of scope by construction, not merely by omission.
This is also the correct call on the merits, not just the literal text:
supabase/migrations/README.md documents that migrations_drafts/ holds SQL
"not applied in production (Tier 3 approval pending or abandoned)" and
migrations_rollbacks/ holds "rollback scripts ... to run manually if a
migration needs to be reverted" -- an emergency-use GRANT-to-anon rollback
(exactly #1634's rollback half) living in migrations_rollbacks/ is supposed
to look like a violation if it were ever replayed forward, but it is
reference material, never replayed by the Supabase CLI's forward-only chain
(see the README's own warning: renaming a rollback into a CLI-parseable
timestamp and moving it into migrations/ IS the defect class #385 documents).
Gating those two directories the same way as migrations/ would either spam
every draft/rollback file with findings nobody can act on (drafts are
pre-review by definition; rollbacks are intentionally the mirror image of a
REVOKE), or require a second, different rule set for "reference SQL" that
this issue does not ask for. Flagged here as a real, disclosed scope
boundary rather than silently dropped: if a draft SQL file is ever promoted
into supabase/migrations/ with its real applied timestamp (the README's own
required workflow), THAT commit is exactly the one this ratchet inspects.

USAGE
    python scripts/permissions-ratchet.py --self-test
    python scripts/permissions-ratchet.py --base <ref> --head <ref> [--root PATH] [--labels "a,b"] [--json]
    python scripts/permissions-ratchet.py --check-file PATH [PATH ...] [--labels "a,b"] [--json]

EXIT
    0  GATE: PASS -- no un-bypassed violation among the added statements inspected.
    1  GATE: FAIL -- at least one un-bypassed violation (see printed findings).
    2  Usage error (bad arguments, unreadable ref/file).
"""
import argparse
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent

# ---------------------------------------------------------------------------
# Scope / allowlist / bypass configuration -- see module docstring for the
# enumeration and justification behind each of these.
# ---------------------------------------------------------------------------
MIGRATIONS_PATH_RE = re.compile(r"^supabase/migrations/[^/]+\.sql$")

ALLOWLISTED_GRANT_ROLES = {"service_role"}
DANGEROUS_ROLES = {"anon", "public", "authenticated"}
BYPASS_LABEL = "permissions-ratchet: reviewed"

# ---------------------------------------------------------------------------
# Comment / string-literal / dollar-quote stripping.
#
# Blanks (space-for-space, preserving every newline so line numbers and
# statement offsets stay valid) the CONTENTS of:
#   - `-- ...` line comments
#   - `/* ... */` block comments, correctly handling Postgres's nested
#     block comments (/* /* */ */ is one comment, not two)
#   - '...' single-quoted string literals, with '' as the escaped quote
#   - $$...$$ / $tag$...$tag$ dollar-quoted strings (function bodies)
# so that `-- GRANT ... TO anon` inside a comment, or a GRANT-shaped string
# literal inside a function body, can never masquerade as a live TOP-LEVEL
# statement for rules 1-3's statement splitter, and so that a semicolon
# inside any of the above can never be mistaken for a statement terminator.
#
# strip_noise_and_collect() does this same walk but additionally records
# the RAW (un-blanked) content and source-line span of every single-quoted
# and dollar-quoted region it passes over (comments are never recorded --
# they are not executable under any circumstance, dynamically or
# otherwise). Rule 4 (dynamic-sql-grant, see module docstring) scans that
# recorded content separately for a GRANT hiding inside a string that gets
# EXECUTE'd -- exactly the content this function blanks out for splitting
# purposes, which is why rule 4 cannot be implemented as a fourth statement
# type in classify_statements() and needs its own pass over the raw spans.
# ---------------------------------------------------------------------------
_DOLLAR_TAG_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")


def strip_noise_and_collect(text: str):
    """Returns (stripped_text, literal_spans) where literal_spans is a list
    of (kind, raw_start, raw_end, content_start, content_end, content) for
    every single-quoted ('single') and dollar-quoted ('dollar') region, in
    ORIGINAL-text offsets. `content` is the raw, un-blanked text between the
    delimiters (callers that want the '' -> ' escape collapsed, single-
    quoted literals only, do that themselves); `raw_start`/`raw_end` are the
    offsets of the delimiters THEMSELVES (opening quote/tag through closing
    quote/tag, inclusive) -- rule 4's concatenation grouping
    (`_group_concatenated_spans`) needs these to tell whether two adjacent
    literals are joined end-to-end by nothing but `||`/whitespace/comments,
    which `content_start`/`content_end` alone (delimiters excluded) cannot
    answer."""
    out = []
    literal_spans = []
    i = 0
    n = len(text)
    while i < n:
        two = text[i : i + 2]
        ch = text[i]

        if two == "--":
            j = i
            while j < n and text[j] != "\n":
                out.append(" ")
                j += 1
            i = j
            continue

        if two == "/*":
            depth = 1
            out.append("  ")
            i += 2
            while i < n and depth > 0:
                if text[i : i + 2] == "/*":
                    depth += 1
                    out.append("  ")
                    i += 2
                elif text[i : i + 2] == "*/":
                    depth -= 1
                    out.append("  ")
                    i += 2
                else:
                    out.append("\n" if text[i] == "\n" else " ")
                    i += 1
            continue

        if ch == "'":
            raw_start = i
            out.append(" ")
            i += 1
            content_start = i
            content_end = i
            closed = False
            while i < n:
                if text[i : i + 2] == "''":
                    out.append("  ")
                    i += 2
                    continue
                if text[i] == "'":
                    out.append(" ")
                    content_end = i
                    i += 1
                    closed = True
                    break
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            if not closed:
                content_end = i
            literal_spans.append(
                ("single", raw_start, i, content_start, content_end, text[content_start:content_end])
            )
            continue

        if ch == "$":
            m = _DOLLAR_TAG_RE.match(text, i)
            if m:
                raw_start = i
                tag = m.group(0)
                out.append(" " * len(tag))
                i += len(tag)
                content_start = i
                end = text.find(tag, i)
                if end == -1:
                    end = n
                content_end = end
                for k in range(i, end):
                    out.append("\n" if text[k] == "\n" else " ")
                i = end
                if end < n:
                    out.append(" " * len(tag))
                    i += len(tag)
                literal_spans.append(
                    ("dollar", raw_start, i, content_start, content_end, text[content_start:content_end])
                )
                continue

        out.append(ch)
        i += 1
    result = "".join(out)
    assert len(result) == len(text)  # offsets/line numbers must stay aligned
    return result, literal_spans


def strip_noise(text: str) -> str:
    stripped, _literal_spans = strip_noise_and_collect(text)
    return stripped


# ---------------------------------------------------------------------------
# Statement splitting -- top-level ';' in the NOISE-STRIPPED text (safe,
# because every ';' that was inside a comment/string/dollar-quote is now a
# blanked space, not a literal ';').
# ---------------------------------------------------------------------------


class Statement:
    __slots__ = ("original", "stripped", "line_no", "start", "end")

    def __init__(self, original, stripped, line_no, start, end):
        self.original = original
        self.stripped = stripped
        self.line_no = line_no
        self.start = start
        self.end = end


def _make_statement(original_text, chunk_start, chunk_end, stripped_text):
    """Builds a Statement whose `.original`/`.stripped` have leading
    whitespace (blank lines between the previous ';' and this statement's
    first real token) TRIMMED OFF, with `line_no` and the trimmed slice
    boundaries adjusted to match. This matters beyond cosmetics: a caller
    computing a statement's END line as `line_no + original.count("\\n")`
    (see `statements_touched_by_diff`) would otherwise double-count those
    leading blank-line newlines on top of the already-lead-adjusted
    `line_no`, inflating a single-line statement's apparent end line past
    its real one and into whatever comes next in the diff -- observed
    concretely: a lone `GRANT ... TO anon;` on line 3 of a 3-blank-line-
    separated file was computed to "end" on line 5, which happened to be a
    genuinely-added line elsewhere in the same file, causing a PRE-EXISTING,
    untouched statement to be wrongly reported as touched by that diff.
    Trimming the leading whitespace out of `.original` here removes the
    double-count at its source instead of requiring every caller to
    remember to re-derive a trimmed span themselves."""
    chunk_stripped = stripped_text[chunk_start:chunk_end]
    lead = len(chunk_stripped) - len(chunk_stripped.lstrip())
    line_no = original_text.count("\n", 0, chunk_start) + 1
    line_no += chunk_stripped[:lead].count("\n")
    real_start = chunk_start + lead
    return Statement(
        original_text[real_start:chunk_end],
        stripped_text[real_start:chunk_end],
        line_no,
        real_start,
        chunk_end,
    )


def split_statements(original_text: str, stripped_text: str):
    statements = []
    start = 0
    n = len(stripped_text)
    for idx, c in enumerate(stripped_text):
        if c == ";":
            if stripped_text[start : idx + 1].strip():
                statements.append(
                    _make_statement(original_text, start, idx + 1, stripped_text)
                )
            start = idx + 1
    if stripped_text[start:n].strip():
        statements.append(_make_statement(original_text, start, n, stripped_text))
    return statements


# ---------------------------------------------------------------------------
# Statement classification
# ---------------------------------------------------------------------------

# UNANCHORED (gh-1767 fix2, PR #1836 comment 5578401122 probe (f)): a
# statement is REVOKE-shaped / GRANT-shaped if the keyword appears ANYWHERE
# in it, not only at statement-start. This is what lets rule 1 catch
# `ALTER DEFAULT PRIVILEGES ... GRANT ... TO anon` (starts with ALTER, not
# GRANT -- the old `^\s*GRANT\b` anchor never even looked at it) while still
# passing `ALTER DEFAULT PRIVILEGES ... REVOKE ... FROM anon` (starts with
# ALTER too, but is REVOKE-shaped) and `REVOKE GRANT OPTION FOR ... FROM
# anon` (contains the word GRANT, but is checked against REVOKE_RE FIRST in
# classify_statements, so it is treated as REVOKE-shaped and never reaches
# the GRANT branch at all). Both regexes operate on `stmt.stripped`, which
# has already had every comment/string/dollar-quote span blanked out by
# strip_noise() before statement-splitting -- so a stray "grant"/"revoke"
# inside a string literal or comment can never trigger either branch here;
# that is rule 4's separate job. \b word boundaries mean an identifier like
# `grant_type` or `revoke_reason` never matches either.
REVOKE_RE = re.compile(r"\bREVOKE\b", re.I)
GRANT_RE = re.compile(r"\bGRANT\b", re.I)
GRANT_TO_RE = re.compile(
    r"\bTO\s+(.+?)(?:\bWITH\s+GRANT\s+OPTION\b|;|\Z)", re.I | re.S
)
ALTER_FUNC_RE = re.compile(r"\bALTER\s+FUNCTION\b", re.I)
CREATE_OR_REPLACE_FUNC_RE = re.compile(r"\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b", re.I)
SECURITY_DEFINER_RE = re.compile(r"\bSECURITY\s+DEFINER\b", re.I)
CREATE_POLICY_RE = re.compile(r"^\s*CREATE\s+POLICY\b", re.I)
USING_TRUE_RE = re.compile(r"\bUSING\s*\(\s*TRUE\s*\)", re.I)
WITH_CHECK_TRUE_RE = re.compile(r"\bWITH\s+CHECK\s*\(\s*TRUE\s*\)", re.I)
ROLE_SPLIT_RE = re.compile(r"[,\s]+")

# Rule 4 (dynamic-sql-grant): matched against the RAW content of a
# single-quoted or dollar-quoted span (see strip_noise_and_collect), never
# against the noise-stripped top-level text. The roles group is restricted
# to a tight identifier/placeholder character class -- letters, digits,
# underscore, comma, whitespace, `%`/`$` (format() placeholders), and `"`
# (quoted identifiers) -- so it naturally stops at the first character that
# cannot be part of a role list (a closing `'`, a `)`, a stray `;`) instead
# of having to separately hunt for that boundary.
DYNAMIC_GRANT_RE = re.compile(
    r"\bGRANT\b.*?\bTO\s+(?P<roles>[A-Za-z0-9_%$,\s\"]+)", re.I | re.S
)
# format()-style placeholders: %I, %L, %s, and the positional %1$I form.
FORMAT_PLACEHOLDER_RE = re.compile(r"%\d*\$?[A-Za-z]")
_ROLE_STRIP_CHARS = "'\";"

# gh-1767 fix2 (PR #1836 comment 5578401122, probes (a)/(e)/quote_ident):
# concatenation-awareness for rule 4. Two distinct mechanisms, because a
# GRANT split by `||` shows up in two structurally different ways:
#
#   (1) TOP-LEVEL concatenation -- `EXECUTE 'GRANT ... TO ' || 'anon';` --
#       strip_noise_and_collect() records this as TWO SEPARATE literal_spans
#       (each single-quoted region is its own span, delimiters excluded from
#       `content`). `_group_concatenated_spans` merges adjacent spans whose
#       ONLY separation is `\s*\|\|\s*` (comments in between are already
#       blanked to whitespace by strip_noise) into one logical string by
#       concatenating their `.content` fields directly -- no stray quote
#       characters to clean up, since delimiters were never part of either
#       span's content.
#   (2) NESTED concatenation -- the far more realistic real-world shape,
#       `CREATE FUNCTION ... AS $$ ... EXECUTE '...' || quote_ident(r); ...
#       $$` -- the whole function body is ONE dollar-quoted span (dollar-
#       quoted content is raw and is never re-parsed for quotes nested
#       inside it), so the inner `'...'` literal is never split out as its
#       own span at all; its quote characters are just ordinary characters
#       inside that one span's raw `content`. `_collapse_literal_concat`
#       handles the case where BOTH sides of a `||` are string literals
#       (collapses the `'...  ||  '` glue to nothing, joining the two
#       segments); `_UNRESOLVED_CONCAT_RE` catches the case where the LEFT
#       side is a literal ending in an incomplete GRANT...TO clause and the
#       RIGHT side is NOT a literal (a function call, a variable) -- the
#       role "arrives from elsewhere" and can never be read statically off
#       the migration text, so this fails closed as dynamic-sql-grant-
#       unknown-role rather than silently passing for lack of a match.
_CONCAT_BETWEEN_RE = re.compile(r"\A\s*\|\|\s*\Z", re.S)
_CONCAT_GLUE_RE = re.compile(r"'\s*\|\|\s*'", re.S)
# GRANT ... TO immediately hitting a live string-literal boundary that then
# continues via `||` into something NOT re-collapsed above (because it
# wasn't `'...'`) -- e.g. `'GRANT ... TO ' || quote_ident(r)`. Also covers
# the plain "ends bare right at/after TO, nothing further in this span at
# all" shape (`\Z`), which is the trailing-whitespace-swallowed-the-whole-
# roles-group case DYNAMIC_GRANT_RE's own `if not roles:` branch below
# already handles for MOST trailing-whitespace amounts, but not the exact-
# one-trailing-space case (`\s+` and the roles group can't both claim the
# same single character, so DYNAMIC_GRANT_RE fails to match at all there).
_UNRESOLVED_CONCAT_RE = re.compile(r"\bGRANT\b.*?\bTO\b(?:\s*\Z|\s*'\s*\|\|)", re.I | re.S)


def extract_roles(stmt: Statement):
    m = GRANT_TO_RE.search(stmt.stripped)
    if not m:
        return []
    raw = m.group(1)
    roles = []
    for tok in ROLE_SPLIT_RE.split(raw):
        tok = tok.strip().strip('"').strip()
        if tok:
            roles.append(tok)
    return roles


class Finding:
    def __init__(self, rule, severity, file, line, message, bypassable=True):
        self.rule = rule
        self.severity = severity  # "FAIL" or "BYPASSED"
        self.file = file
        self.line = line
        self.message = message
        self.bypassable = bypassable

    def render(self):
        return "%s  [%s] %s:%d -- %s" % (
            self.severity,
            self.rule,
            self.file,
            self.line,
            self.message,
        )


def classify_statements(file_rel: str, statements):
    """Returns (findings: list[Finding], pass_notes: list[str],
    has_security_definer_alter: bool -- used by the caller to feed rule 2)."""
    findings = []
    pass_notes = []
    security_definer_stmts = []
    grant_stmts = []

    for stmt in statements:
        if REVOKE_RE.search(stmt.stripped):
            pass_notes.append(
                "PASS  [revoke-always-ok] %s:%d -- REVOKE always passes"
                % (file_rel, stmt.line_no)
            )
            continue

        if GRANT_RE.search(stmt.stripped):
            grant_stmts.append(stmt)
            roles = extract_roles(stmt)
            bad_roles = [r for r in roles if r.lower() not in ALLOWLISTED_GRANT_ROLES]
            if not roles:
                findings.append(
                    Finding(
                        "grant-unparsed-roles",
                        "FAIL",
                        file_rel,
                        stmt.line_no,
                        "GRANT statement's TO clause could not be parsed -- "
                        "treated as a violation rather than silently passing: %s"
                        % stmt.original.strip()[:160],
                    )
                )
            elif bad_roles:
                findings.append(
                    Finding(
                        "grant-to-disallowed-role",
                        "FAIL",
                        file_rel,
                        stmt.line_no,
                        "GRANT names role(s) not on the allowlist (%s): %s -- %s"
                        % (
                            ", ".join(sorted(ALLOWLISTED_GRANT_ROLES)),
                            ", ".join(bad_roles),
                            stmt.original.strip()[:160],
                        ),
                    )
                )
            else:
                pass_notes.append(
                    "PASS  [grant-allowlisted-role] %s:%d -- GRANT names only "
                    "allowlisted role(s): %s" % (file_rel, stmt.line_no, ", ".join(roles))
                )
            continue

        if (ALTER_FUNC_RE.search(stmt.stripped) or CREATE_OR_REPLACE_FUNC_RE.search(stmt.stripped)) and SECURITY_DEFINER_RE.search(
            stmt.stripped
        ):
            security_definer_stmts.append(stmt)
            continue

        if CREATE_POLICY_RE.match(stmt.stripped):
            if USING_TRUE_RE.search(stmt.stripped) or WITH_CHECK_TRUE_RE.search(
                stmt.stripped
            ):
                clause = "USING (true)" if USING_TRUE_RE.search(stmt.stripped) else "WITH CHECK (true)"
                findings.append(
                    Finding(
                        "policy-widened-to-true",
                        "FAIL",
                        file_rel,
                        stmt.line_no,
                        "CREATE POLICY sets %s -- unconditional widening: %s"
                        % (clause, stmt.original.strip()[:160]),
                    )
                )
            else:
                pass_notes.append(
                    "PASS  [policy-not-widened] %s:%d -- CREATE POLICY does not "
                    "collapse USING/WITH CHECK to true" % (file_rel, stmt.line_no)
                )

    # Rule 2: ALTER/CREATE OR REPLACE ... SECURITY DEFINER combined with a
    # grant to any non-allowlisted role, evaluated across this file's own
    # added statements (both sides must be present in the SAME file's diff).
    if security_definer_stmts:
        offending_grants = []
        for gstmt in grant_stmts:
            roles = extract_roles(gstmt)
            if any(r.lower() not in ALLOWLISTED_GRANT_ROLES for r in roles):
                offending_grants.append(gstmt)
        if offending_grants:
            for sd_stmt in security_definer_stmts:
                for g_stmt in offending_grants:
                    findings.append(
                        Finding(
                            "security-definer-plus-broad-grant",
                            "FAIL",
                            file_rel,
                            sd_stmt.line_no,
                            "sets SECURITY DEFINER (line %d) in the same diff as a "
                            "GRANT to a non-service role at line %d: %s"
                            % (
                                sd_stmt.line_no,
                                g_stmt.line_no,
                                g_stmt.original.strip()[:160],
                            ),
                        )
                    )
        else:
            pass_notes.append(
                "PASS  [security-definer-no-broad-grant] %s -- SECURITY DEFINER "
                "statement(s) present but no accompanying grant to a "
                "non-service role in this diff" % file_rel
            )

    return findings, pass_notes


def _dynamic_roles(roles_text: str):
    """Splits a rule-4 `roles` capture (already restricted to a tight
    identifier/placeholder character class by DYNAMIC_GRANT_RE) into role
    tokens, mirroring extract_roles()'s comma/whitespace splitting and
    stray-quote/semicolon stripping so a trailing `'` or `;` that leaked in
    from the surrounding quoted text (e.g. `TO anon'` before the string's
    closing quote) never becomes part of the role name itself."""
    m = re.search(r"\bWITH\s+GRANT\s+OPTION\b", roles_text, re.I)
    if m:
        roles_text = roles_text[: m.start()]
    roles = []
    for tok in ROLE_SPLIT_RE.split(roles_text):
        tok = tok.strip().strip(_ROLE_STRIP_CHARS).strip()
        if tok:
            roles.append(tok)
    return roles


def _group_concatenated_spans(stripped: str, literal_spans):
    """Groups the INDICES of adjacent literal_spans that are joined
    end-to-end by a bare `||` (see _CONCAT_BETWEEN_RE) into lists. Compares
    the STRIPPED text between one span's raw delimiter-end and the next
    span's raw delimiter-start, so any comment sitting in that gap (already
    blanked to whitespace by strip_noise) is correctly ignored rather than
    blocking the merge."""
    groups = []
    current = [0]
    for idx in range(1, len(literal_spans)):
        prev_raw_end = literal_spans[idx - 1][2]
        cur_raw_start = literal_spans[idx][1]
        between = stripped[prev_raw_end:cur_raw_start]
        if _CONCAT_BETWEEN_RE.match(between):
            current.append(idx)
        else:
            groups.append(current)
            current = [idx]
    groups.append(current)
    return groups


def _collapse_literal_concat(raw: str) -> str:
    """Collapses `'...' || '...'` glue (closing quote, optional whitespace,
    `||`, optional whitespace, opening quote) to nothing, WITHIN a single
    span's raw content, so two or more literal segments concatenated
    together INSIDE a larger dollar-quoted body (e.g. a `CREATE FUNCTION
    ... AS $$ ... $$` whose body contains `'a' || 'b'`) read as one
    continuous string for scanning. Looped to handle 3+ segments
    (`'a' || 'b' || 'c'`)."""
    prev = None
    while raw != prev:
        prev = raw
        raw = _CONCAT_GLUE_RE.sub("", raw)
    return raw


def find_dynamic_sql_grant_findings(file_rel: str, new_text: str, added_lines: set):
    """Rule 4: a GRANT ... TO <role> hiding inside a single-quoted or
    dollar-quoted span that intersects an added line -- see the module
    docstring's DYNAMIC SQL / RULE 4 section for the full rationale, the
    concatenation-awareness added in gh-1767 fix2, and the accepted
    false-positive tradeoff. Runs independently of
    classify_statements()/statements_touched_by_diff() because it needs the
    RAW content strip_noise() blanks out, not the noise-stripped statement
    text."""
    findings = []
    stripped, literal_spans = strip_noise_and_collect(new_text)
    if not literal_spans:
        return findings

    for group in _group_concatenated_spans(stripped, literal_spans):
        spans = [literal_spans[i] for i in group]
        raw_merged = "".join(s[5] for s in spans)  # s[5] == content
        if not raw_merged.strip():
            continue

        start_line = new_text.count("\n", 0, spans[0][3]) + 1  # s[3] == content_start
        end_line = new_text.count("\n", 0, spans[-1][4]) + 1  # s[4] == content_end
        if not any(ln in added_lines for ln in range(start_line, end_line + 1)):
            continue

        content = _collapse_literal_concat(raw_merged)
        kind = spans[0][0] if len(spans) == 1 else "%s(x%d, concatenated)" % (spans[0][0], len(spans))

        matched_any = False
        for m in DYNAMIC_GRANT_RE.finditer(content):
            matched_any = True
            roles_text = m.group("roles")
            match_line = start_line + content[: m.start()].count("\n")
            excerpt = content[m.start() : m.end()].strip()[:160]
            if FORMAT_PLACEHOLDER_RE.search(roles_text):
                findings.append(
                    Finding(
                        "dynamic-sql-grant-unknown-role",
                        "FAIL",
                        file_rel,
                        match_line,
                        "%s-quoted literal, once EXECUTE'd, would run a GRANT ... TO "
                        "<parameter> whose role is a format()-style placeholder and "
                        "cannot be statically determined -- treated as a violation "
                        "rather than passed for lack of a matchable role name: %s"
                        % (kind, excerpt),
                    )
                )
                continue
            roles = _dynamic_roles(roles_text)
            if not roles:
                findings.append(
                    Finding(
                        "dynamic-sql-grant-unknown-role",
                        "FAIL",
                        file_rel,
                        match_line,
                        "%s-quoted literal contains a GRANT ... TO clause whose role "
                        "could not be statically resolved (the TO clause has no "
                        "matchable role text -- likely completed by string "
                        "concatenation or a separate expression) -- treated as a "
                        "violation rather than passed for lack of a matchable role "
                        "name: %s" % (kind, excerpt),
                    )
                )
                continue
            bad_roles = [r for r in roles if r.lower() not in ALLOWLISTED_GRANT_ROLES]
            if bad_roles:
                findings.append(
                    Finding(
                        "dynamic-sql-grant",
                        "FAIL",
                        file_rel,
                        match_line,
                        "%s-quoted literal contains a GRANT to role(s) not on the "
                        "allowlist (%s): %s -- %s"
                        % (
                            kind,
                            ", ".join(sorted(ALLOWLISTED_GRANT_ROLES)),
                            ", ".join(bad_roles),
                            excerpt,
                        ),
                    )
                )

        if not matched_any:
            # DYNAMIC_GRANT_RE's tight role character class (deliberately
            # excludes quote/pipe characters) never even attempted a match
            # here -- either the span/group ends bare right at "TO" with
            # nothing after it at all, or "TO" immediately hits a live
            # string-literal boundary that continues via `||` into
            # something _collapse_literal_concat couldn't resolve (not
            # another string literal -- a function call, a variable). Same
            # unresolved-role posture as the `if not roles:` branch above,
            # reached via a different shape.
            m2 = _UNRESOLVED_CONCAT_RE.search(content)
            if m2:
                match_line = start_line + content[: m2.start()].count("\n")
                excerpt = content[m2.start() : m2.end()].strip()[:160]
                findings.append(
                    Finding(
                        "dynamic-sql-grant-unknown-role",
                        "FAIL",
                        file_rel,
                        match_line,
                        "%s-quoted literal contains an unresolved GRANT ... TO "
                        "clause -- the role is either missing entirely or supplied "
                        "by concatenation with a non-literal expression, and cannot "
                        "be statically determined -- treated as a violation rather "
                        "than passed for lack of a matchable role name: %s"
                        % (kind, excerpt),
                    )
                )

    return findings


# ---------------------------------------------------------------------------
# Diff plumbing
# ---------------------------------------------------------------------------


def run_git(args, root: Path):
    proc = subprocess.run(
        ["git"] + args, cwd=str(root), capture_output=True, text=True
    )
    return proc.returncode, proc.stdout, proc.stderr


def git_show(root: Path, ref: str, path: str):
    code, out, _err = run_git(["show", "%s:%s" % (ref, path)], root)
    if code != 0:
        return None  # file did not exist at this ref
    return out


def changed_migration_files(root: Path, base: str, head: str):
    code, out, err = run_git(
        ["diff", "--name-only", "%s...%s" % (base, head), "--", "supabase/migrations"],
        root,
    )
    if code != 0:
        raise RuntimeError("git diff --name-only failed: %s" % err)
    files = [
        f.strip().replace("\\", "/")
        for f in out.splitlines()
        if f.strip() and MIGRATIONS_PATH_RE.match(f.strip().replace("\\", "/"))
    ]
    return files


def diff_added_line_numbers(old_text: str, new_text: str):
    """Line numbers (1-based, in NEW file) that difflib considers added
    relative to old_text. old_text == '' (brand-new file) marks every line
    added."""
    old_lines = old_text.splitlines(keepends=True) if old_text else []
    new_lines = new_text.splitlines(keepends=True)
    added = set()
    sm = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
    for tag, _i1, _i2, j1, j2 in sm.get_opcodes():
        if tag in ("insert", "replace"):
            for ln in range(j1 + 1, j2 + 1):
                added.add(ln)
    return added


def statements_touched_by_diff(new_text: str, added_lines: set):
    stripped = strip_noise(new_text)
    statements = split_statements(new_text, stripped)
    touched = []
    for stmt in statements:
        stmt_start_line = stmt.line_no
        stmt_end_line = stmt_start_line + stmt.original.count("\n")
        if any(ln in added_lines for ln in range(stmt_start_line, stmt_end_line + 1)):
            touched.append(stmt)
    return touched


def evaluate_file(file_rel: str, old_text: str, new_text: str):
    added_lines = diff_added_line_numbers(old_text or "", new_text)
    if not added_lines:
        return [], []
    touched = statements_touched_by_diff(new_text, added_lines)
    findings, pass_notes = classify_statements(file_rel, touched)
    # Rule 4 runs over raw quoted/dollar-quoted spans directly, not over the
    # statements rules 1-3 see -- a GRANT hiding inside a string that gets
    # EXECUTE'd is exactly the content strip_noise() blanks out for those
    # rules' statement splitter. See find_dynamic_sql_grant_findings().
    findings = findings + find_dynamic_sql_grant_findings(file_rel, new_text, added_lines)
    return findings, pass_notes


def apply_bypass(findings, labels):
    bypass_active = BYPASS_LABEL in (labels or [])
    if bypass_active:
        for f in findings:
            if f.bypassable:
                f.severity = "BYPASSED"
    return bypass_active


# ---------------------------------------------------------------------------
# Modes: git diff base..head, or --check-file (whole file treated as added)
# ---------------------------------------------------------------------------


def run_diff_mode(root: Path, base: str, head: str, labels):
    files = changed_migration_files(root, base, head)
    all_findings = []
    all_pass_notes = []
    files_inspected = []
    for f in files:
        old_text = git_show(root, base, f) or ""
        new_text = git_show(root, head, f)
        if new_text is None:
            continue  # file deleted -- deletions are not this ratchet's job
        files_inspected.append(f)
        findings, pass_notes = evaluate_file(f, old_text, new_text)
        all_findings.extend(findings)
        all_pass_notes.extend(pass_notes)
    bypass_active = apply_bypass(all_findings, labels)
    return all_findings, all_pass_notes, files_inspected, bypass_active


def run_check_file_mode(paths, labels):
    all_findings = []
    all_pass_notes = []
    files_inspected = []
    for p in paths:
        path = Path(p)
        text = path.read_text(encoding="utf-8")
        rel = path.name
        files_inspected.append(rel)
        findings, pass_notes = evaluate_file(rel, "", text)
        all_findings.extend(findings)
        all_pass_notes.extend(pass_notes)
    bypass_active = apply_bypass(all_findings, labels)
    return all_findings, all_pass_notes, files_inspected, bypass_active


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def build_result(findings, pass_notes, files_inspected, bypass_active):
    hard_fails = [f for f in findings if f.severity == "FAIL"]
    bypassed = [f for f in findings if f.severity == "BYPASSED"]
    verdict = "FAIL" if hard_fails else "PASS"
    code = 1 if hard_fails else 0
    return {
        "verdict": verdict,
        "code": code,
        "files_inspected": files_inspected,
        "bypass_label_present": bypass_active,
        "hard_fail_count": len(hard_fails),
        "bypassed_count": len(bypassed),
        "findings": [f.render() for f in findings],
        "pass_notes": pass_notes,
    }


def print_report(result: dict):
    print("=" * 78)
    print("permissions-ratchet (gh-1767) -- GRANT-to-anon/PUBLIC/authenticated,")
    print("SECURITY DEFINER + broad grant, and USING(true) policy widenings")
    print("=" * 78)
    print("files inspected: %d -- %s" % (
        len(result["files_inspected"]), ", ".join(result["files_inspected"]) or "(none)"
    ))
    for line in result["pass_notes"]:
        print(line)
    if result["findings"]:
        print("-" * 78)
        for line in result["findings"]:
            print(line)
    if result["bypassed_count"]:
        print("!" * 78)
        print(
            ">> BYPASS USED: %d finding(s) labeled BYPASSED because this PR carries "
            "the '%s' label. They are printed above, not hidden. <<"
            % (result["bypassed_count"], BYPASS_LABEL)
        )
        print("!" * 78)
    print("-" * 78)
    print(
        "hard_fail_count=%d bypassed_count=%d bypass_label_present=%s"
        % (
            result["hard_fail_count"],
            result["bypassed_count"],
            result["bypass_label_present"],
        )
    )
    print("GATE: %s" % result["verdict"])


# ---------------------------------------------------------------------------
# --self-test
# ---------------------------------------------------------------------------

FIXTURES_DIR = HERE / "permissions-ratchet-fixtures"
FIXTURE_META_RE = re.compile(
    r"^--\s*RATCHET-FIXTURE:\s*EXPECT=(PASS|FAIL)(?:\s+LABELS=(.*))?\s*$", re.M
)


def load_fixture(path: Path):
    text = path.read_text(encoding="utf-8")
    m = FIXTURE_META_RE.search(text)
    if not m:
        raise ValueError(
            "%s missing a '-- RATCHET-FIXTURE: EXPECT=PASS|FAIL' marker line" % path
        )
    expect = m.group(1)
    labels = [s.strip() for s in (m.group(2) or "").split("|") if s.strip()]
    return expect, labels, text


def self_test():
    if not FIXTURES_DIR.is_dir():
        print("FAIL  no fixtures directory found at %s" % FIXTURES_DIR)
        return 1

    total = 0
    failures = 0
    for path in sorted(FIXTURES_DIR.glob("*.sql")):
        total += 1
        try:
            expect, labels, text = load_fixture(path)
        except ValueError as exc:
            print("FAIL  %s" % exc)
            failures += 1
            continue

        findings, _pass_notes = evaluate_file(path.name, "", text)
        bypass_active = apply_bypass(findings, labels)
        hard_fails = [f for f in findings if f.severity == "FAIL"]
        actual = "FAIL" if hard_fails else "PASS"

        if actual == expect:
            print(
                "PASS  %-55s expected=%s actual=%s (labels=%s, bypass_active=%s, "
                "findings=%d)"
                % (path.name, expect, actual, labels or "none", bypass_active, len(findings))
            )
        else:
            failures += 1
            print(
                "FAIL  %-55s expected=%s actual=%s (labels=%s, bypass_active=%s) -- "
                "self-test mismatch:" % (path.name, expect, actual, labels or "none", bypass_active)
            )
            for f in findings:
                print("      " + f.render())

    print("-" * 78)
    print("self-test: %d fixture(s), %d mismatch(es)" % (total, failures))
    print("GATE: %s" % ("FAIL" if failures or total == 0 else "PASS"))
    return 1 if (failures or total == 0) else 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--check-file", nargs="+", default=None)
    parser.add_argument("--labels", default="")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    labels = [s.strip() for s in args.labels.split(",") if s.strip()]

    if args.check_file:
        findings, pass_notes, files_inspected, bypass_active = run_check_file_mode(
            args.check_file, labels
        )
    elif args.base and args.head:
        root = Path(args.root).resolve()
        findings, pass_notes, files_inspected, bypass_active = run_diff_mode(
            root, args.base, args.head, labels
        )
    else:
        parser.error("must pass either --self-test, --check-file PATH..., or --base REF --head REF")
        return 2

    result = build_result(findings, pass_notes, files_inspected, bypass_active)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_report(result)
    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
