#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/workflow-step-unrun-check.py (gh-1840
control 2). Thin wrapper around that script's own --self-test (which already
runs against scripts/fixtures/workflow-step-crash.job.json / workflow-step-
clean.job.json and prints PASS/FAIL lines in this repo's convention) so it
is discovered and run by scripts/detector-negative-control-check.py's CHECK
1 the same way every other detector's <name>.test.py is.

Also exercises find_unrun_steps() directly against a handful of boundary
shapes the self-test's two fixtures don't individually isolate: a job with
no failure at all (silence, independent of any "skipped" steps being
present for unrelated reasons), a job where the failure is the very LAST
step (nothing after it to report), and the jobs-list wrapper shape
(`{"jobs": [...]}`) as opposed to the single-job shape both fixtures use.

Run: python workflow-step-unrun-check.test.py
"""
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

spec = importlib.util.spec_from_file_location("unrun", HERE / "workflow-step-unrun-check.py")
unrun = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unrun)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def main():
    print("=" * 78)
    print("scripts/workflow-step-unrun-check.py -- self-test delegation")
    print("=" * 78)
    code = unrun.self_test(ROOT)
    check("self_test(ROOT) exit code", code, 0)

    print()
    print("=" * 78)
    print("scripts/workflow-step-unrun-check.py -- boundary shapes")
    print("=" * 78)

    no_failure_job = {
        "name": "clean-with-a-skip",
        "steps": [
            {"name": "checkout", "conclusion": "success"},
            # Skipped by its OWN if: condition, not by any crash -- no
            # failure precedes it in this job, so this must NOT be UNRUN.
            {"name": "deploy-only-on-tag", "conclusion": "skipped"},
            {"name": "notify", "conclusion": "success"},
        ],
    }
    check(
        "a 'skipped' step with NO earlier failure in the job is never UNRUN "
        "(a legitimately-conditional step, not a casualty)",
        unrun.find_unrun_steps(no_failure_job),
        [],
    )

    failure_is_last_job = {
        "name": "fails-at-the-end",
        "steps": [
            {"name": "checkout", "conclusion": "success"},
            {"name": "build", "conclusion": "success"},
            {"name": "deploy", "conclusion": "failure"},
        ],
    }
    check(
        "a failure as the LAST step reports nothing (no step exists after it "
        "to be UNRUN)",
        unrun.find_unrun_steps(failure_is_last_job),
        [],
    )

    jobs_list_wrapper = {
        "jobs": [
            {
                "name": "job-a",
                "steps": [
                    {"name": "setup", "conclusion": "success"},
                    {"name": "boom", "conclusion": "failure"},
                    {"name": "later-check", "conclusion": "skipped"},
                ],
            },
            {
                "name": "job-b",
                "steps": [{"name": "unrelated", "conclusion": "success"}],
            },
        ]
    }
    violations = []
    for job_name, job in unrun._iter_jobs(jobs_list_wrapper, "inline-fixture"):
        for step_name in unrun.find_unrun_steps(job):
            violations.append((job_name, step_name))
    check(
        "the jobs-list wrapper shape ({'jobs': [...]}) is walked correctly, "
        "flagging only job-a's casualty step",
        violations,
        [("job-a", "later-check")],
    )

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("workflow-step-unrun-check.test.py: all assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
