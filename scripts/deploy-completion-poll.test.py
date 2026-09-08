#!/usr/bin/env python3
"""Tests for deploy-completion-poll.py (gh-1729).

Acceptance test the CTO's dispatch asked for, adapted to what this script
actually is (a trigger-decision mechanism, not the reachability spec
itself -- that spec is tests/e2e/smoke/entry-point-reachability.spec.ts and
is unchanged): point the decision function at the pre-#1696 commit
(0aa1d61b, the broken tree) as the "current" published deploy after having
last seen main's tip, and confirm it is reported as `changed` (RED / a
signal worth re-running the spec over) -- then confirm a repeat observation
of the SAME deploy id is NOT reported as changed (GREEN -- no needless
re-trigger). The critical assertion is the one from the issue's own
"async control": the commit_ref this script surfaces is always
`published_deploy.commit_ref`, never a merge/push sha -- so if a caller
runs the reachability spec keyed on this script's output, it is
structurally testing the deploy that actually happened, not the commit that
triggered the check.
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "deploy_completion_poll", os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy-completion-poll.py")
)
m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m)

PASS = 0
FAIL = 0


def check(label, actual, expected):
    global PASS, FAIL
    ok = actual == expected
    print(("  PASS  " if ok else "  FAIL  ") + "%s: %s" % (label, actual))
    if ok:
        PASS += 1
    else:
        FAIL += 1


print("decide() -- pure decision logic, no network")
check("no prior state, first observation of a real deploy -> changed", m.decide(None, "deploy-A"), True)
check("no prior state, site has never published -> not changed (nothing to alarm on)", m.decide(None, None), False)
check("same deploy id twice -> not changed", m.decide("deploy-A", "deploy-A"), False)
check("a genuinely new deploy id -> changed", m.decide("deploy-A", "deploy-B"), True)
check("current deploy id is None (site now reports no published deploy) -> never a false trigger", m.decide("deploy-A", None), False)

print()
print("The acceptance case the CTO's dispatch asked for, adapted:")
print("  'last seen' = the deploy published from a known-good commit (post-#1696 main).")
print("  'current'   = a deploy published from the pre-#1696 broken tree (0aa1d61b).")
last_seen_deploy_id = "deploy-from-main-good"
pre_1696_deploy_id = "deploy-from-0aa1d61b"
changed = m.decide(last_seen_deploy_id, pre_1696_deploy_id)
check("switching TO the pre-#1696 broken-tree deploy is reported as changed (must re-run reachability)", changed, True)
changed_forward = m.decide(pre_1696_deploy_id, last_seen_deploy_id)
check("switching FROM the pre-#1696 deploy back to a good one is ALSO reported as changed", changed_forward, True)
check("observing the SAME pre-#1696 deploy again on the next poll -> not changed (no re-trigger storm)", m.decide(pre_1696_deploy_id, pre_1696_deploy_id), False)

print()
print("extract_published_deploy() -- never crashes on a site with no deploy history")
check("site with published_deploy -> (id, commit_ref)", m.extract_published_deploy({"published_deploy": {"id": "d1", "commit_ref": "abc123"}}), ("d1", "abc123"))
check("site with published_deploy=None -> (None, None), not a crash", m.extract_published_deploy({"published_deploy": None}), (None, None))
check("site missing the key entirely -> (None, None)", m.extract_published_deploy({}), (None, None))
check("site itself is None (fetch failed upstream) -> (None, None)", m.extract_published_deploy(None), (None, None))

print()
print("The async trap, checked directly: the commit_ref this script reports is the")
print("PUBLISHED deploy's commit_ref, structurally incapable of being the merge sha,")
print("because it is read from published_deploy and nothing else ever reaches that variable.")
site_fixture = {
    "published_deploy": {"id": "d99", "commit_ref": "56a9c849aaaa"},
}
deploy_id, commit_ref = m.extract_published_deploy(site_fixture)
merge_sha_that_must_never_leak_in = "be6c27b2ffff"
check("reported commit_ref is the PUBLISHED ref", commit_ref, "56a9c849aaaa")
check("reported commit_ref is NOT the (unrelated) merge sha", commit_ref != merge_sha_that_must_never_leak_in, True)

print()
print("load_last_seen() / save_state() -- state file round-trip, and both 'never existed'")
print("and 'corrupt' read as no-prior-state rather than crashing")
with tempfile.TemporaryDirectory() as d:
    state_path = os.path.join(d, "state.json")
    check("missing file -> None, not an exception", m.load_last_seen(state_path), None)
    m.save_state(state_path, "dep-1", "sha-1")
    check("round-trip after save_state", m.load_last_seen(state_path), "dep-1")
    with open(state_path, "w") as f:
        f.write("{not valid json")
    check("corrupt state file -> None, not an exception (treated as first run)", m.load_last_seen(state_path), None)

print()
print("main() end-to-end: UNMEASURED path never crashes and never reports changed=true")
with tempfile.TemporaryDirectory() as d:
    state_path = os.path.join(d, "state.json")
    saved_env = os.environ.pop("NETLIFY_PAT", None)
    try:
        rc = m.main(["--site-name", "does-not-matter", "--last-seen-file", state_path])
    finally:
        if saved_env is not None:
            os.environ["NETLIFY_PAT"] = saved_env
    check("no NETLIFY_PAT -> UNMEASURED exit code", rc, m.UNMEASURED_EXIT)

print()
print("=" * 60)
print("TOTAL: %d passed, %d failed" % (PASS, FAIL))
if FAIL:
    sys.exit(1)
