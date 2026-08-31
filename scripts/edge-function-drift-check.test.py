#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/edge-function-drift-check.py (gh-1295 step 2).

Every fixture below is a real drift shape taken from the three manual measurements
on gh-1295 — not invented cases. The point is to prove the detector's verdict logic
is right, and in particular that it does NOT quietly normalize its way past the
differences the manual channel could not resolve.

The load-bearing case is `parse-hover-measurements`. Its live defect is that the
deployed source reads

    fullText.replace(/ /g, " ")        <- plain U+0020, a no-op

where `main` reads

    fullText.replace(/ /g, " ")   <- the real U+00A0 NBSP

Those two lines are visually identical and differ by one codepoint. Any comparison
that decodes, normalizes Unicode, or collapses whitespace calls them the same and
reports a live production defect as IN SYNC. Raw byte comparison catches it. If
someone ever "improves" this script with a normalization step, this test fails.

Run: python3 scripts/edge-function-drift-check.test.py
No network access and no credentials required — this test drives the pure
comparison layer only.
"""

import importlib.util
import os
import pathlib
import shutil
import stat
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("drift", HERE / "edge-function-drift-check.py")
drift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def write(root: pathlib.Path, slug: str, name: str, content: str):
    d = root / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(content, encoding="utf-8")


def build_fixtures(repo: pathlib.Path, deployed: pathlib.Path):
    # --- 1. IDENTICAL -------------------------------------------------------
    same = "import { serve } from './deps.ts'\nserve(() => new Response('ok'))\n"
    write(repo, "stripe-webhook", "index.ts", same)
    write(deployed, "stripe-webhook", "index.ts", same)

    # --- 2. parse-hover-measurements — the NBSP no-op (gh-1295, 2026-08-28) --
    # main: real U+00A0. deployed: plain space, so the normalisation never runs.
    write(repo, "parse-hover-measurements", "index.ts",
          'const t = fullText.replace(/ /g, " ");\n')
    write(deployed, "parse-hover-measurements", "index.ts",
          'const t = fullText.replace(/ /g, " ");\n')

    # --- 3. notify-admin-new-contractor — comment-only drift -----------------
    # Deployed source corresponds to no commit in 1,319; the only difference is
    # 17 comment/blank lines. Runtime behaviour is identical. It is still DRIFT:
    # repo and prod are not the same artifact, and that is the thing being checked.
    write(repo, "notify-admin-new-contractor", "index.ts",
          "// ── build the admin notification ──\n// Non-fatal — email already sent\nsend();\n")
    write(deployed, "notify-admin-new-contractor", "index.ts", "send();\n")

    # --- 4. The comment-ruler class the manual sweeps could not settle -------
    # 10 functions were left unresolved because reading source back through a
    # model's context cannot reproduce U+2500 runs at exact length. On disk this
    # is just a byte difference and must be reported as such.
    write(repo, "record-attestation", "index.ts", "// " + "─" * 60 + "\nok();\n")
    write(deployed, "record-attestation", "index.ts", "// " + "─" * 58 + "\nok();\n")

    # --- 5. A sibling file drifts while index.ts matches --------------------
    # gh-1295 escape-class item 5: "a drifted templates.ts would not appear here."
    write(repo, "send-partner-status-email", "index.ts", same)
    write(deployed, "send-partner-status-email", "index.ts", same)
    write(repo, "send-partner-status-email", "templates.ts", "export const GATE = true; // D-303\n")
    write(deployed, "send-partner-status-email", "templates.ts", "export const GATE = false;\n")

    # --- 6. DEPLOYED_NOT_IN_REPO — the junk-function class ------------------
    # debug-boldsign-poll-1244 and ad18-delivery-test were live on production
    # with no matching path at any commit.
    write(deployed, "debug-boldsign-poll-1244", "index.ts", "console.log('scratch')\n")

    # --- 7. IN_REPO_NEVER_DEPLOYED ------------------------------------------
    write(repo, "brand-new-function", "index.ts", "serve(() => new Response('new'))\n")

    # --- 8. A file present in main but absent from the deploy ---------------
    write(repo, "docusign-webhook", "index.ts", same)
    write(deployed, "docusign-webhook", "index.ts", same)
    write(repo, "docusign-webhook", "verify.ts", "export const verify = () => true;\n")


def verdicts_of(report):
    return {row["slug"]: row["verdict"] for row in report["functions"]}


def main():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-test-"))
    try:
        repo, deployed = tmp / "repo", tmp / "deployed"
        repo.mkdir()
        deployed.mkdir()
        build_fixtures(repo, deployed)

        deployed_slugs = sorted(p.name for p in deployed.iterdir() if p.is_dir())
        report = drift.build_report(repo, deployed, deployed_slugs)
        v = verdicts_of(report)

        print("\nVerdicts")
        check("stripe-webhook (byte-identical)", v["stripe-webhook"], drift.IDENTICAL)
        check("parse-hover-measurements (U+00A0 vs U+0020 — the normalization trap)",
              v["parse-hover-measurements"], drift.DRIFTED)
        check("notify-admin-new-contractor (comment-only)",
              v["notify-admin-new-contractor"], drift.DRIFTED)
        check("record-attestation (U+2500 ruler length)", v["record-attestation"], drift.DRIFTED)
        check("send-partner-status-email (sibling templates.ts drifted)",
              v["send-partner-status-email"], drift.DRIFTED)
        check("debug-boldsign-poll-1244 (deployed, not in repo)",
              v["debug-boldsign-poll-1244"], drift.DEPLOYED_NOT_IN_REPO)
        check("brand-new-function (in repo, never deployed)",
              v["brand-new-function"], drift.IN_REPO_NEVER_DEPLOYED)
        check("docusign-webhook (verify.ts missing from deploy)",
              v["docusign-webhook"], drift.DRIFTED)

        print("\nPer-file detail")
        row = next(r for r in report["functions"] if r["slug"] == "send-partner-status-email")
        statuses = {f["path"]: f["status"] for f in row["files"]}
        check("send-partner-status-email index.ts unchanged", statuses["index.ts"], "same")
        check("send-partner-status-email templates.ts flagged", statuses["templates.ts"], "differs")

        row = next(r for r in report["functions"] if r["slug"] == "docusign-webhook")
        statuses = {f["path"]: f["status"] for f in row["files"]}
        check("docusign-webhook verify.ts missing_in_deploy",
              statuses["verify.ts"], "missing_in_deploy")

        print("\nExit codes")
        check("drift present -> exit 1", drift.report_exit_code(report), 1)

        clean = drift.build_report(repo, deployed, ["stripe-webhook"], repo_slugs=["stripe-webhook"])
        check("all identical -> exit 0", drift.report_exit_code(clean), 0)

        # An empty result set is a failure to measure, never a clean run. Without
        # this, pointing the detector at the wrong directory (or a credential that
        # silently returns nothing) reports PASSED while checking zero functions --
        # the exact fail-quiet shape gh-1295 exists to close.
        empty = drift.build_report(repo, deployed, [], repo_slugs=[])
        check("zero functions measured -> exit 2 (not 0)", drift.report_exit_code(empty), 2)

        # A function merged to `main` but never deployed IS "a merge is not a deploy".
        undeployed = drift.build_report(repo, deployed, ["stripe-webhook"],
                                        repo_slugs=["stripe-webhook", "brand-new-function"])
        check("in-repo-never-deployed -> exit 1 by default",
              drift.report_exit_code(undeployed), 1)
        check("in-repo-never-deployed -> exit 0 with --allow-undeployed",
              drift.report_exit_code(undeployed, allow_undeployed=True), 0)

        # A fetch failure must outrank a clean result AND a drift result: a run
        # that could not measure everything never reports a complete answer.
        blind = drift.build_report(repo, deployed, ["stripe-webhook"], repo_slugs=["stripe-webhook"])
        blind["functions"].append({"slug": "send-sms", "verdict": drift.FETCH_FAILED, "files": []})
        check("fetch failure outranks clean -> exit 2", drift.report_exit_code(blind), 2)

        mixed = drift.build_report(repo, deployed, deployed_slugs)
        mixed["functions"].append({"slug": "send-sms", "verdict": drift.FETCH_FAILED, "files": []})
        check("fetch failure outranks drift -> exit 2", drift.report_exit_code(mixed), 2)

        print("\nMarkdown rendering")
        md = drift.render_markdown(report)
        check("names a drifted function", "`parse-hover-measurements`" in md, True)
        check("omits clean functions from the table", "| `stripe-webhook` |" not in md, True)
        check("carries the do-not-redeploy-everything warning",
              "Do not fix drift by redeploying everything" in md, True)

        print("\nReclaiming a read-only download tree (gh-1295 live-run crash, 2026-08-31)")
        # `supabase functions download` shells out to Docker; on the hosted runner
        # the produced tree came back read-only (and, separately, root-owned --
        # that half needs sudo and isn't reproducible in this unprivileged test).
        # shutil.move's rename-or-copy+rmtree fallback died with EPERM/EACCES.
        # The FIRST version of this fix reclaimed only the leaf slug directory
        # and still failed live, second run: removing/renaming a directory entry
        # needs write permission on its PARENT, not on the entry itself, and the
        # parent chain (`scratch/supabase/`, `scratch/supabase/functions/`) was
        # still read-only. This fixture mirrors that real shape -- read-only
        # ancestors, not just the leaf -- and reclaims from the scratch-root
        # equivalent, same as `download_function` now does.
        scratch_root = tmp / "readonly-download"
        readonly_root = scratch_root / "supabase" / "functions" / "some-function"
        readonly_root.mkdir(parents=True)
        readonly_file = readonly_root / "index.ts"
        readonly_file.write_text("export default 1;\n", encoding="utf-8")
        os.chmod(readonly_file, stat.S_IRUSR)
        os.chmod(readonly_root, stat.S_IRUSR | stat.S_IXUSR)
        os.chmod(scratch_root / "supabase" / "functions", stat.S_IRUSR | stat.S_IXUSR)
        os.chmod(scratch_root / "supabase", stat.S_IRUSR | stat.S_IXUSR)
        drift._reclaim_tree(scratch_root)
        removable = True
        try:
            shutil.rmtree(scratch_root)
        except OSError:
            removable = False
        check("read-only download tree (incl. ancestors) removable after _reclaim_tree",
              removable, True)

        print()
        if FAILURES:
            print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
            return 1
        print("Edge Function drift detector: all assertions passed.")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
