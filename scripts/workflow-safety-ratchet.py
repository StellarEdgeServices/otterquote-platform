#!/usr/bin/env python3
r"""
workflow-safety-ratchet.py -- gh-1651 CI gate: fail a PR that introduces a
`pull_request_target` workflow which can execute, or hand a token to,
fork-controlled input.

WHY THIS EXISTS (gh-1651)
-------------------------
#1651's body recorded, as its single most important negative result:

    "No workflow in this repository uses `pull_request_target`. All 13 read;
     zero occurrences ... it must keep appearing nowhere."

That was written 2026-09-04T20:16:10Z. Commit c1b0afb7 landed
`r120-signed-review.yml` -- which used `pull_request_target` -- at 22:09:24Z
the same evening, and nothing noticed for two days (#1651 comment
5561638561). The invariant was prose, and prose cannot fail a build.

`pull_request_target` runs in BASE-branch context: the job gets the
repository's secrets and a write-scoped `GITHUB_TOKEN`, on an event a
stranger triggers by opening a pull request. That is safe only while the
workflow never executes, and never interpolates, anything the PR head
controls.

WHAT THE FIRST VERSION GOT WRONG, AND WHY THIS ONE IS SHAPED THIS WAY
---------------------------------------------------------------------
A fresh-context refuter broke the first version three ways at head
381597a5 (PR #1857 comment 5584425701), and every one of those attacks is
now a fixture in scripts/workflow-safety-fixtures/ carrying the reviewer's
own file:

  1. TRIGGER PARSING. Detection was three anchored regexes over lines. A
     valid flow-mapping trigger -- `on: {pull_request_target: {types: [...]}}`
     -- matched none of them, so a complete pwn workflow (head checkout, PR
     title into `run:`, a named secret) was reported "skipped, not
     PRT-triggered" with zero findings. Triggers are now read from PARSED
     YAML. (Note the YAML 1.1 "Norway problem" in reverse: `on:` parses as
     the boolean key `True`, which is why _trigger_node checks both.)
     Fixture: prt_flow_mapping_pwn_bad.yml.
  2. INDIRECTION AND SINKS. `ref: ${{ env.PR_HEAD }}` defeated rule 1,
     because rule 1 pattern-matched the literal text of the `ref:` line --
     and `env:` indirection is the very shape this file's own docstring
     teaches as safe for the `run:` rule, so a reader was actively
     encouraged to write it. And `actions/github-script`'s `script:` input,
     the other canonical injection sink, was never walked at all. Env values
     defined anywhere in the file are now RESOLVED before rule 1 judges a
     ref, an unresolvable `env.` reference in a ref FAILS CLOSED, and every
     `with:` input (including `script:`) is walked for untrusted
     expressions. Fixture: prt_env_indirection_checkout_bad.yml.
  3. UNMEASURED-AS-PASS. An empty or wrong `--root` printed PASS and exited
     0. scripts/detector-negative-control-check.py, in this same tree, rules
     on that verbatim: "UNMEASURED IS NOT A PASS (gh-1419 precedent:
     backup-age.py / drift-detector-age.py -- unmeasured must fail as loudly
     as stale)." Zero workflow files is now UNMEASURED and exits 3, on
     drift-detector-age.py's convention.

WHAT IT IS NOT
--------------
It is not a YAML linter and it does not police `pull_request` workflows: a
fork's `pull_request` run gets no secrets and a read-only token, which is the
whole reason `pull_request_target` is the dangerous trigger and the ordinary
one is not. Files that do not trigger on it are reported `skipped` and can
never fail this check.

THE RULES (each with a fixture observed failing on the bad shape and passing
on the safe one -- run `--self-test`)
---------------------------------------------------------------------------
  1. HEAD_CHECKOUT      a `ref:`/`sha:`/`commit:` input that resolves -- after
                        expanding `env:` values defined in the same file --
                        to PR-head-controlled state
                        (`github.event.pull_request.head.*`,
                        `merge_commit_sha`, `github.head_ref`, `refs/pull/`).
  1b. UNRESOLVED_REF    a ref whose `${{ env.X }}` cannot be resolved from the
                        file. Fails CLOSED: an unreadable ref on a
                        stranger-triggered checkout is not evidence of safety.
  2. UNTRUSTED_SINK     an untrusted `${{ github.event.* }}` / `${{ github.head_ref }}`
                        expression reaching a code sink: a `run:` body, or any
                        `with:` input (`script:` above all -- github-script
                        takes the same attacker-authored strings a shell
                        does). The `env:`-indirection form stays UNFLAGGED for
                        these sinks; that remains the documented safe shape,
                        and rule 1 is what covers the ref case it used to hide.
  3. SECRETS_IN_PRT     any `secrets.<NAME>` other than `GITHUB_TOKEN`
                        referenced by a pull_request_target workflow.

Allowlisted as structurally non-injectable scalars: see SAFE_EVENT_EXPRS.
`github.event.pull_request.head.sha` is deliberately NOT allowlisted -- it is
attacker-chosen even though it is hex, and checking it out is rule 1's
business.

PARSING
-------
PyYAML when importable (accurate); a conservative line-based fallback when
not. The fallback FAILS SAFE -- it treats the token appearing anywhere
outside a `name:` value as a trigger -- and says loudly that it is degraded.
`--require-yaml` (what CI passes) turns degraded parsing into UNMEASURED
exit 3 rather than a quiet second-class pass.

EXIT CODES
----------
  0  PASS        workflows read, no findings
  1  FAIL        findings
  3  UNMEASURED  nothing was read, or --require-yaml with no YAML parser

Usage:
  python3 scripts/workflow-safety-ratchet.py --root . --require-yaml   # CI gate
  python3 scripts/workflow-safety-ratchet.py --self-test               # rule self-test
"""
import argparse
import re
import sys
from pathlib import Path

try:
    import yaml  # type: ignore
    HAVE_YAML = True
except Exception:  # pragma: no cover - exercised only on a host without PyYAML
    HAVE_YAML = False

WORKFLOW_DIR = ".github/workflows"
FIXTURE_DIR = "scripts/workflow-safety-fixtures"

EXIT_PASS, EXIT_FAIL, EXIT_UNMEASURED = 0, 1, 3

TRIGGER = "pull_request_target"

# State a fork controls the value of, on a pull_request_target event.
HEAD_REF_PATTERNS = [
    r"github\.event\.pull_request\.head\.",
    r"github\.event\.pull_request\.merge_commit_sha",
    r"github\.head_ref",
    r"refs/pull/",
]

# Expressions whose CONTENT a fork cannot author.
SAFE_EVENT_EXPRS = {
    "github.event.pull_request.number",
    "github.event.number",
    "github.event.repository.default_branch",
    "github.event.pull_request.base.sha",
    "github.event.pull_request.base.ref",
    "github.event.pull_request.state",
    "github.event.action",
}

REF_KEYS = {"ref", "sha", "commit"}

EXPR_RE = re.compile(r"\$\{\{([^}]*)\}\}")
ENV_EXPR_RE = re.compile(r"\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
SECRET_RE = re.compile(r"secrets\.([A-Za-z_][A-Za-z0-9_]*)")
NAME_VALUE_RE = re.compile(r"^\s*(?:-\s*)?name\s*:")


class Finding:
    def __init__(self, rule, file, where, message):
        self.rule, self.file, self.where, self.message = rule, file, where, message

    def render(self):
        return f"  [{self.rule}] {self.file} :: {self.where} -- {self.message}"


# ── shared helpers ───────────────────────────────────────────────────────────

def strip_comments(text: str) -> str:
    """Drop full-line comments; strip inline `#` comments outside quotes."""
    out = []
    for line in text.split("\n"):
        if line.lstrip().startswith("#"):
            out.append("")
            continue
        cleaned, quote = [], None
        for ch in line:
            if quote:
                cleaned.append(ch)
                if ch == quote:
                    quote = None
            elif ch in "'\"":
                quote = ch
                cleaned.append(ch)
            elif ch == "#" and (not cleaned or cleaned[-1] in " \t"):
                break
            else:
                cleaned.append(ch)
        out.append("".join(cleaned).rstrip())
    return "\n".join(out)


def untrusted_exprs(fragment: str):
    """Untrusted `${{ ... }}` expressions inside a string."""
    found = []
    for m in EXPR_RE.finditer(str(fragment)):
        bare = m.group(1).strip().strip("() ")
        if bare in SAFE_EVENT_EXPRS:
            continue
        if bare.startswith("github.event.") or bare == "github.head_ref":
            found.append(bare)
        elif "github.event." in bare or "github.head_ref" in bare:
            inner = re.findall(r"github\.(?:event\.[A-Za-z0-9_.]+|head_ref)", bare)
            found.extend(i for i in inner if i not in SAFE_EVENT_EXPRS)
    return found


def head_controlled(value: str):
    for pat in HEAD_REF_PATTERNS:
        if re.search(pat, str(value)):
            return pat
    return None


def secret_findings(file_rel: str, text: str):
    out = []
    for n, line in enumerate(strip_comments(text).split("\n"), 1):
        for m in SECRET_RE.finditer(line):
            if m.group(1) == "GITHUB_TOKEN":
                continue
            out.append(Finding(
                "SECRETS_IN_PRT", file_rel, f"line {n}",
                f"`secrets.{m.group(1)}` referenced in a pull_request_target workflow -- "
                "a stranger-triggered job must not hold a named repository secret",
            ))
    return out


# ── YAML mode ────────────────────────────────────────────────────────────────

def _trigger_node(doc):
    """`on:` -- which PyYAML hands back as the boolean key True under YAML 1.1."""
    if not isinstance(doc, dict):
        return None
    for key in (True, "on", "On", "ON"):
        if key in doc:
            return doc[key]
    return None


def triggers_prt_yaml(doc) -> bool:
    node = _trigger_node(doc)
    if node is None:
        return False
    if isinstance(node, str):
        return node.strip() == TRIGGER
    if isinstance(node, list):
        return any(str(i).strip() == TRIGGER for i in node)
    if isinstance(node, dict):
        return any(str(k).strip() == TRIGGER for k in node)
    return False


def collect_env(doc):
    """Every `env:` mapping in the file, flattened.

    Deliberately file-wide rather than scope-accurate: a ref resolved through
    ANY env key in the file is judged, so a workflow cannot hide an unsafe
    value by defining it one scope over. Over-inclusive on purpose -- this
    direction produces false FAILs, never false PASSes.
    """
    env = {}

    def walk(node):
        if isinstance(node, dict):
            e = node.get("env")
            if isinstance(e, dict):
                for k, v in e.items():
                    if isinstance(v, (str, int, float, bool)):
                        env[str(k)] = str(v)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(doc)
    return env


def resolve(value: str, env: dict, depth: int = 0):
    """Expand `${{ env.X }}` from the file's own env. Returns (resolved, unresolved_names)."""
    text = str(value)
    unresolved = []
    for _ in range(5):  # bounded: env values may themselves reference env
        names = ENV_EXPR_RE.findall(text)
        if not names:
            break
        progressed = False
        for n in names:
            if n in env:
                text = ENV_EXPR_RE.sub(lambda m: env[m.group(1)] if m.group(1) in env else m.group(0), text)
                progressed = True
            else:
                unresolved.append(n)
        if not progressed:
            break
    return text, sorted(set(unresolved))


def iter_steps(doc):
    jobs = doc.get("jobs") if isinstance(doc, dict) else None
    if not isinstance(jobs, dict):
        return
    for job_name, job in jobs.items():
        if not isinstance(job, dict):
            continue
        steps = job.get("steps")
        if not isinstance(steps, list):
            continue
        for i, step in enumerate(steps):
            if isinstance(step, dict):
                yield str(job_name), i, step


def evaluate_yaml(file_rel: str, text: str, doc):
    findings = []
    env = collect_env(doc)

    for job_name, i, step in iter_steps(doc):
        where = f"jobs.{job_name}.steps[{i}]"
        with_block = step.get("with") if isinstance(step.get("with"), dict) else {}

        # Rule 1 / 1b -- the checkout ref, AFTER env expansion.
        for key, value in with_block.items():
            if str(key).lower() not in REF_KEYS:
                continue
            resolved, unresolved = resolve(value, env)
            pat = head_controlled(resolved)
            if pat:
                via = "" if str(resolved) == str(value) else f" (via env: `{value}` -> `{resolved}`)"
                findings.append(Finding(
                    "HEAD_CHECKOUT", file_rel, f"{where}.with.{key}",
                    f"resolves to PR-head-controlled state ({pat!r}){via} in a "
                    "pull_request_target workflow: base-context secrets would run the fork's tree",
                ))
            elif unresolved:
                findings.append(Finding(
                    "UNRESOLVED_REF", file_rel, f"{where}.with.{key}",
                    f"`{value}` references env {unresolved} that this file does not define, so the "
                    "checkout target cannot be read. Fails closed: an unreadable ref on a "
                    "stranger-triggered checkout is not evidence of safety",
                ))

        # Rule 2 -- untrusted expressions reaching a code sink.
        sinks = []
        if isinstance(step.get("run"), str):
            sinks.append(("run", step["run"]))
        for key, value in with_block.items():
            if str(key).lower() in REF_KEYS:
                continue  # rule 1 owns these; do not double-report
            if isinstance(value, str):
                sinks.append((f"with.{key}", value))
        for sink_name, value in sinks:
            bad = untrusted_exprs(value)
            if bad:
                findings.append(Finding(
                    "UNTRUSTED_SINK", file_rel, f"{where}.{sink_name}",
                    "attacker-authored expression(s) interpolated into a code sink: "
                    + ", ".join(sorted(set(bad)))
                    + " -- pass them through `env:` and reference the variable instead",
                ))

    findings.extend(secret_findings(file_rel, text))
    return findings


# ── degraded (no PyYAML) mode ────────────────────────────────────────────────

def triggers_prt_degraded(text: str) -> bool:
    """Fail-safe: the token anywhere outside a `name:` value counts as a trigger.

    Over-inclusive by design. The first version was UNDER-inclusive (three
    anchored spellings) and a flow-mapping trigger walked straight past it.
    """
    for line in strip_comments(text).split("\n"):
        if TRIGGER not in line:
            continue
        if NAME_VALUE_RE.match(line):
            continue
        return True
    return False


def evaluate_degraded(file_rel: str, text: str):
    findings = []
    lines = strip_comments(text).split("\n")
    for n, line in enumerate(lines, 1):
        m = re.match(r"^\s*(?:-\s*)?(ref|sha|commit)\s*:\s*(.+?)\s*$", line)
        if m:
            pat = head_controlled(m.group(2))
            if pat:
                findings.append(Finding("HEAD_CHECKOUT", file_rel, f"line {n}",
                                        f"`{m.group(1)}:` resolves to PR-head-controlled state ({pat!r})"))
            elif ENV_EXPR_RE.search(m.group(2)):
                findings.append(Finding("UNRESOLVED_REF", file_rel, f"line {n}",
                                        f"`{m.group(1)}: {m.group(2)}` uses env indirection that the "
                                        "degraded parser cannot resolve -- fails closed"))
        if re.search(r"^\s*(?:-\s*)?(run|script)\s*:", line) or "${{" in line:
            bad = untrusted_exprs(line)
            if bad and not NAME_VALUE_RE.match(line):
                findings.append(Finding("UNTRUSTED_SINK", file_rel, f"line {n}",
                                        "attacker-authored expression(s) near a code sink: "
                                        + ", ".join(sorted(set(bad)))))
    findings.extend(secret_findings(file_rel, text))
    return findings


# ── driver ───────────────────────────────────────────────────────────────────

def evaluate(file_rel: str, text: str):
    """Return (findings, is_prt_triggered)."""
    if HAVE_YAML:
        try:
            doc = yaml.safe_load(text)
        except Exception as exc:
            # An unparseable workflow is not a pass either.
            return [Finding("UNPARSEABLE", file_rel, "file",
                            f"YAML could not be parsed ({exc.__class__.__name__}); "
                            "cannot judge it, so it fails closed")], True
        if not triggers_prt_yaml(doc):
            return [], False
        return evaluate_yaml(file_rel, text, doc), True
    if not triggers_prt_degraded(text):
        return [], False
    return evaluate_degraded(file_rel, text), True


def scan_root(root: Path):
    wf_dir = root / WORKFLOW_DIR
    files = sorted(list(wf_dir.glob("*.yml")) + list(wf_dir.glob("*.yaml"))) if wf_dir.is_dir() else []
    findings, applicable, skipped = [], [], []
    for p in files:
        rel = str(p.relative_to(root))
        f, is_prt = evaluate(rel, p.read_text(encoding="utf-8", errors="replace"))
        (applicable if is_prt else skipped).append(rel)
        findings.extend(f)
    return findings, applicable, skipped, files


def self_test(root: Path):
    """Every rule, on a fixture observed failing bad and passing good."""
    fx = root / FIXTURE_DIR
    expectations = [
        ("prt_head_checkout_bad.yml", "HEAD_CHECKOUT"),
        ("prt_base_checkout_good.yml", None),
        ("prt_untrusted_run_bad.yml", "UNTRUSTED_SINK"),
        ("prt_env_indirection_good.yml", None),
        ("prt_named_secret_bad.yml", "SECRETS_IN_PRT"),
        ("prt_github_token_only_good.yml", None),
        ("plain_pull_request_head_checkout_good.yml", None),
        ("name_mentions_prt_good.yml", None),
        ("prt_flow_sequence_trigger_bad.yml", "HEAD_CHECKOUT"),
        # The three attacks from PR #1857's REVIEW: FAIL (comment 5584425701),
        # carried verbatim so the refutation stays refuted.
        ("prt_flow_mapping_pwn_bad.yml", "HEAD_CHECKOUT"),
        ("prt_env_indirection_checkout_bad.yml", "HEAD_CHECKOUT"),
        ("prt_github_script_sink_bad.yml", "UNTRUSTED_SINK"),
        ("prt_unresolvable_env_ref_bad.yml", "UNRESOLVED_REF"),
    ]
    failures = 0
    print(f"SELF-TEST -- each rule beside its negative control  (parser: {'yaml' if HAVE_YAML else 'DEGRADED line-based'})")
    for name, expect in expectations:
        p = fx / name
        if not p.exists():
            print(f"  FAIL  MISSING FIXTURE {name}")
            failures += 1
            continue
        found, _ = evaluate(name, p.read_text(encoding="utf-8"))
        rules = sorted({f.rule for f in found})
        if expect is None:
            ok = not found
            detail = "no findings" if ok else f"UNEXPECTED {rules}"
        else:
            ok = expect in rules
            detail = f"{rules}" if ok else f"expected {expect}, got {rules or 'none'}"
        print(f"  {'PASS' if ok else 'FAIL'}  {name:44s} {detail}")
        if not ok:
            failures += 1

    # UNMEASURED must fail as loudly as a finding (gh-1419 precedent).
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        code = main(["--root", tmp, "--quiet"])
    ok = code == EXIT_UNMEASURED
    print(f"  {'PASS' if ok else 'FAIL'}  empty root exits {EXIT_UNMEASURED} (UNMEASURED), not 0: got {code}")
    if not ok:
        failures += 1

    print(f"self-test: {len(expectations) + 1 - failures} passed | {failures} failed")
    return EXIT_FAIL if failures else EXIT_PASS


def main(argv=None):
    ap = argparse.ArgumentParser(description="gh-1651 pull_request_target safety ratchet")
    ap.add_argument("--root", default=".")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--require-yaml", action="store_true",
                    help="treat a missing YAML parser as UNMEASURED (exit 3) rather than "
                         "silently accepting the degraded line-based fallback")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    root = Path(args.root).resolve()

    if args.self_test:
        return self_test(root)

    say = (lambda *a: None) if args.quiet else print

    if args.require_yaml and not HAVE_YAML:
        say("UNMEASURED -- --require-yaml was passed and PyYAML is not importable. "
            "The degraded line-based parser is not accepted as a pass here "
            "(gh-1419: unmeasured must fail as loudly as a finding).")
        return EXIT_UNMEASURED

    findings, applicable, skipped, files = scan_root(root)
    say(f"workflow-safety-ratchet (gh-1651) -- root {root}")
    say(f"  parser                        : {'PyYAML' if HAVE_YAML else 'DEGRADED line-based (fail-safe)'}")
    say(f"  workflow files read           : {len(files)}")
    say(f"  pull_request_target workflows : {len(applicable)} {applicable}")
    say(f"  skipped (not PRT-triggered)   : {len(skipped)}")

    if not files:
        say(f"UNMEASURED -- no workflow files were read under {root / WORKFLOW_DIR}. "
            "Nothing was checked, so nothing passed (gh-1419 precedent: "
            "unmeasured must fail as loudly as a finding).")
        return EXIT_UNMEASURED

    if not findings:
        say("PASS -- no pull_request_target workflow checks out fork-controlled state, "
            "interpolates it into a code sink, or holds a named secret.")
        return EXIT_PASS

    say(f"FAIL -- {len(findings)} finding(s):")
    for f in findings:
        say(f.render())
    say("\nSee scripts/workflow-safety-ratchet.py's module docstring for why each rule exists.")
    return EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
