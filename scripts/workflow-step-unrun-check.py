#!/usr/bin/env python3
"""
workflow-step-unrun-check.py -- gh-1840 control 2 (severed from #1738): given
a workflow JOB's real result data (the GitHub Actions API "get a job for a
workflow run" shape), report every step that never ran because an EARLIER
step in the same job crashed -- as UNRUN, not as silently absent.

WHY THIS EXISTS
----------------
PR #1737 added a new step, "Self-test the remote-project detector
(otter-crm)", ahead of the job's existing "Install Supabase CLI" step. At
the time (commit dd05d10 on wm/gh1700-crm-ef-drift-hthf, caught by review
before merge -- see edge-function-drift.yml's own "gh-1737 review" comment)
that new step's self-test called the real `require_cli()`, which crashed for
lack of the CLI -- and GitHub Actions auto-skips every subsequent step in a
job by default once one step fails. "Check deployed Edge Functions against
main" -- a real, pre-existing detector, unrelated to the new step -- never
ran. The job still went red, but red only pointed at the NEW step; nothing
said the OLD check was silently skipped rather than genuinely passing or
even genuinely running at all. See scripts/fixtures/workflow-step-crash.yml
/ .job.json for a minimal, deliberately-stubbed reproduction of this exact
shape.

Per #1738's amended closes-on (quoted on gh-1840): "a job-ordering /
fail-open-vs-fail-closed property of a workflow's step sequence, not a
declared-input mismatch. CHECK 2's reconciliation logic [in
scripts/detector-negative-control-check.py] does not model step ordering or
step-to-step data flow within a job." This script is the mechanism that
does.

WHAT THIS DOES AND DOES NOT DO
--------------------------------
This is a POST-HOC triage tool, not a live per-push gate: a step's real
`conclusion` (success / failure / skipped / cancelled) only exists once a
run has actually executed and GitHub has recorded it. There is no way to
know, from a workflow's YAML alone, which steps a given run will skip --
that is exactly the "fail-open, and nothing says so" gap this exists to
close, and static analysis of the YAML (as scripts/detector-negative-control
-check.py's CHECK 2 already does for `push.paths` reconciliation) cannot
see it. This script therefore reads a JOB RESULT, not a workflow definition:
either the direct output of `GET /repos/{owner}/{repo}/actions/jobs/{job_id}`
(a single job object with a "steps" list), or `GET .../actions/runs/{run_id}
/jobs` (a "jobs" list of that same shape) -- an operator downloads that JSON
(e.g. via `gh api` or curl) after a suspicious run and feeds it here, or a
committed fixture reproduces a known past incident for regression testing
(see scripts/fixtures/*.job.json).

DETECTION LOGIC
----------------
Per job, walk `steps` in the order given (GitHub already orders them by
execution order, and each carries its own `number`). The first step whose
`conclusion == "failure"` marks everything after it in that same job as
"downstream of a crash." Any step at or after that point whose own
`conclusion == "skipped"` is reported:

    UNRUN: <step name> (job=<job name>)

A step's own `conclusion` can also be "skipped" for a reason having NOTHING
to do with an earlier crash -- an explicit `if:` condition gating it on a
branch name, an input, or a prior job's output. This script cannot tell
those apart from the JSON alone (the Actions API does not expose *why* a
step was skipped) -- see LIMITATIONS. "Skipped, and something upstream in
this same job failed first" is the signal it reports; it is a proxy, not a
certainty, and is deliberately named UNRUN (something that did not run)
rather than a stronger claim like BLOCKED or CAUSED-BY.

A job with no `failure`-concluded step anywhere in its `steps` list produces
no UNRUN lines for that job -- silence, matching a clean run.

LIMITATIONS -- read before trusting this as complete
--------------------------------------------------------
  - False positives are possible: a step legitimately gated by its own `if:`
    condition (unrelated to any failure) that happens to be skipped in a run
    where an EARLIER, unrelated step also failed will be reported as UNRUN
    even though it was never going to run anyway. The Actions API's job JSON
    does not carry each step's `if:` expression, only its `steps[].conclusion`
    -- resolving this would require also fetching and parsing the workflow
    YAML that produced the run and cross-referencing conditions, which this
    script does not do. Accepted per this issue's own instruction: ambiguity
    resolves to a visible (over-)report, never to silence.
  - Cannot distinguish "skipped because THIS SPECIFIC earlier step failed"
    from "skipped because SOME earlier step failed" -- it reports every
    skipped step after the FIRST failure in the job, not a precise causal
    chain to one crash. For a job with multiple failures this can over-report
    which specific failure is "responsible," though every reported step is
    still genuinely UNRUN.
  - Operates on exactly the job-result JSON it is given. It does not fetch
    anything over the network itself and has no default target -- there is
    no static, in-repo source of "this run's own step results" to discover
    (see WHAT THIS DOES above), so normal-mode invocation always requires an
    explicit PATH argument (or --self-test against the committed fixtures).
  - A `cancelled` step (a run-level cancel, not a step failure) is not
    treated as a trigger for UNRUN reporting on the steps after it --  only
    `failure` is. A cancelled run's downstream `skipped` steps are a
    different, already-visible shape (the whole run shows cancelled) and are
    out of scope here.

USAGE
    python scripts/workflow-step-unrun-check.py PATH [PATH ...]
        Each PATH is a job-result JSON file: either a single job object
        (has a top-level "steps" key) or a jobs-list wrapper (has a
        top-level "jobs" key, a list of job objects).
    python scripts/workflow-step-unrun-check.py --self-test
        Run against scripts/fixtures/workflow-step-crash.job.json (must
        report >=1 UNRUN) and scripts/fixtures/workflow-step-clean.job.json
        (must be silent).
    python scripts/workflow-step-unrun-check.py --json PATH [PATH ...]

EXIT
    0  clean -- no UNRUN step found in any given job
    1  UNRUN found -- one or more pre-existing steps never ran
    2  usage error (no PATH given, a PATH does not exist, or a file did not
       parse as JSON / job-result shape)
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent

VERDICT_TOKEN = "UNRUN"


def _iter_jobs(doc, source_label: str):
    """Yields (job_name, job_dict) from a parsed job-result JSON document,
    accepting both the single-job shape (GET .../actions/jobs/{id}, a dict
    with a top-level "steps" key) and the jobs-list shape (GET
    .../actions/runs/{id}/jobs, a dict with a top-level "jobs" list)."""
    if isinstance(doc, dict) and "steps" in doc:
        yield doc.get("name", source_label), doc
    elif isinstance(doc, dict) and isinstance(doc.get("jobs"), list):
        for job in doc["jobs"]:
            if isinstance(job, dict):
                yield job.get("name", source_label), job
    else:
        raise ValueError(
            "%s: not a recognized job-result shape (expected a dict with a "
            "top-level 'steps' key, or a top-level 'jobs' list)" % source_label
        )


def find_unrun_steps(job: dict):
    """Returns the list of step names in `job['steps']` that are 'skipped'
    at or after the first 'failure'-concluded step in the same list."""
    steps = job.get("steps") or []
    failed_seen = False
    unrun = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        conclusion = step.get("conclusion")
        name = step.get("name", "<unnamed step>")
        if failed_seen and conclusion == "skipped":
            unrun.append(name)
        if conclusion == "failure":
            failed_seen = True
    return unrun


def scan_source(path: Path, root: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("%s: could not parse as JSON (%s)" % (path, exc)) from exc

    try:
        rel_path = str(path.resolve().relative_to(root)).replace("\\", "/")
    except ValueError:
        rel_path = str(path)

    violations = []
    jobs_scanned = 0
    for job_name, job in _iter_jobs(doc, rel_path):
        jobs_scanned += 1
        for step_name in find_unrun_steps(job):
            violations.append(
                "%s: %s job=%s step=\"%s\" -- an earlier step in this job "
                "failed, and GitHub Actions auto-skipped this pre-existing "
                "step rather than running it. Reported as UNRUN, not as "
                "absent (PR #1737 shape)." % (VERDICT_TOKEN, rel_path, job_name, step_name)
            )
    return violations, jobs_scanned


def run(paths, root: Path):
    all_violations = []
    jobs_scanned = 0
    files_scanned = 0
    for p in paths:
        v, jobs = scan_source(p, root)
        files_scanned += 1
        jobs_scanned += jobs
        all_violations.extend(v)
    return {
        "verdict": "FAIL" if all_violations else "PASS",
        "code": 1 if all_violations else 0,
        "violations": all_violations,
        "files_scanned": files_scanned,
        "jobs_scanned": jobs_scanned,
    }


def print_report(result: dict):
    print("=" * 78)
    print("workflow-step-unrun-check (gh-1840 control 2)")
    print("=" * 78)
    print(
        "files_scanned=%d  jobs_scanned=%d"
        % (result["files_scanned"], result["jobs_scanned"])
    )
    for line in result["violations"]:
        print(line)
    print("-" * 78)
    print("VIOLATIONS: %d" % len(result["violations"]))
    print("GATE: %s" % result["verdict"])


def self_test(root: Path) -> int:
    fixtures = root / "scripts" / "fixtures"
    bad = fixtures / "workflow-step-crash.job.json"
    good = fixtures / "workflow-step-clean.job.json"

    failures = []

    bad_result = run([bad], root)
    bad_tokens = [v for v in bad_result["violations"] if v.startswith(VERDICT_TOKEN + ":")]
    if bad_result["code"] != 0 and bad_tokens:
        print(
            "PASS  bad fixture (%s) reported %d %s line(s), exit code %d"
            % (bad.name, len(bad_tokens), VERDICT_TOKEN, bad_result["code"])
        )
    else:
        print(
            "FAIL  bad fixture (%s) was expected to report a %s line but did not "
            "(exit=%d, violations=%d) -- the detector cannot see the crash it "
            "exists to catch" % (bad.name, VERDICT_TOKEN, bad_result["code"], len(bad_result["violations"]))
        )
        failures.append("bad-fixture-not-flagged")

    unrun_names = [v for v in bad_tokens if 'step="Check deployed Edge Functions against main"' in v]
    if unrun_names:
        print(
            "PASS  bad fixture's UNRUN line names the real pre-existing step "
            "(\"Check deployed Edge Functions against main\"), not just \"something\""
        )
    else:
        print(
            "FAIL  bad fixture was flagged but not for the specific pre-existing "
            "step this incident actually lost -- verdict text: %s" % bad_tokens
        )
        failures.append("wrong-step-named")

    good_result = run([good], root)
    if good_result["code"] == 0 and not good_result["violations"]:
        print("PASS  good fixture (%s) is silent, exit code 0" % good.name)
    else:
        print(
            "FAIL  good fixture (%s) was expected to be silent but got %d violation(s): %s"
            % (good.name, len(good_result["violations"]), good_result["violations"])
        )
        failures.append("good-fixture-flagged")

    # Known-bad-expectation inversion, same shape as spec-spy-order-check.py's
    # self-test: deliberately assert the WRONG thing (that the crash fixture
    # is silent) and confirm THAT assertion is the one that fails, proving
    # this harness can distinguish a wrong expectation from a right one
    # rather than rubber-stamping every input as PASS.
    inverted_is_correct = (good_result["code"] == 0) and (bad_result["code"] != 0)
    wrongly_expect_bad_is_silent = bad_result["code"] == 0
    if wrongly_expect_bad_is_silent:
        print(
            "FAIL  [inverted check, EXPECTED to fail] crash fixture was wrongly silent -- "
            "if you are reading this as a PASS, the self-test harness itself is broken"
        )
        failures.append("inverted-check-did-not-fail")
    else:
        print(
            "PASS  inverted check correctly failed to find the crash fixture silent "
            "(proves this self-test can distinguish a wrong expectation from a right one)"
        )
    if not inverted_is_correct:
        failures.append("fixtures-not-distinguishable")

    print()
    if failures:
        print("FAILED -- %d assertion(s): %s" % (len(failures), ", ".join(failures)))
        return 1
    print("workflow-step-unrun-check self-test: all assertions passed.")
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--root", default=None)
    args = parser.parse_args(argv)

    root = Path(args.root).resolve() if args.root else DEFAULT_ROOT

    if args.self_test:
        return self_test(root)

    if not args.paths:
        print(
            "ERROR: no PATH given. This script has no default target -- pass one or "
            "more job-result JSON files (or use --self-test). See its module "
            "docstring's USAGE section.",
            file=sys.stderr,
        )
        return 2

    paths = [Path(p) for p in args.paths]
    missing = [str(p) for p in paths if not p.exists()]
    if missing:
        print("ERROR: file(s) not found: %s" % ", ".join(missing), file=sys.stderr)
        return 2

    try:
        result = run(paths, root)
    except ValueError as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_report(result)
    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
