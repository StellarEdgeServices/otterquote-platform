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
    (d / name).parent.mkdir(parents=True, exist_ok=True)
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
    # gh-1295 (RUN 62): verify.ts is IMPORTED by index.ts here, as in production, so the
    # bundler dropping it is real drift. (Before RUN 62 this fixture's index.ts did not
    # import it, which the detector could not tell apart from an unreferenced file.)
    wh = "import { verify } from './verify.ts'\nverify()\n"
    write(repo, "docusign-webhook", "index.ts", wh)
    write(deployed, "docusign-webhook", "index.ts", wh)
    write(repo, "docusign-webhook", "verify.ts", "export const verify = () => true;\n")

    # --- 9. transitive: index -> used.ts -> deep.ts, deep.ts dropped from the deploy = real drift
    imp = "import { a } from './used.ts'\na()\n"
    write(repo, "transitive-drop", "index.ts", imp)
    write(deployed, "transitive-drop", "index.ts", imp)
    write(repo, "transitive-drop", "used.ts", "import { d } from './deep.ts'\nexport const a = d\n")
    write(deployed, "transitive-drop", "used.ts", "import { d } from './deep.ts'\nexport const a = d\n")
    write(repo, "transitive-drop", "deep.ts", "export const d = () => 2\n")
    # no entrypoint at all: nothing may be excused
    write(repo, "no-entry", "a.ts", "export const a = 1\n")
    write(deployed, "no-entry", "b.ts", "export const b = 1\n")
    # a file that is not imported by anything but is NOT on the allowlist is DRIFTED (gh-1295 RUN 63)
    write(repo, "unlisted-orphan", "index.ts", same)
    write(deployed, "unlisted-orphan", "index.ts", same)
    write(repo, "unlisted-orphan", "email-footer.ts", "export const f = 'x'\n")
    write(repo, "unlisted-orphan", "email-footer.test.ts", "import { f } from './email-footer.ts'\n")
    # an unlisted file that EXISTS in the deploy but differs is `differs`
    write(repo, "unref-differs", "index.ts", same)
    write(deployed, "unref-differs", "index.ts", same)
    write(repo, "unref-differs", "orphan.ts", "export const o = 1\n")
    write(deployed, "unref-differs", "orphan.ts", "export const o = 2\n")


# The exact set of repo paths the checked-in allowlist may name. Changing the allowlist means
# changing this set in the same reviewed diff; a line added to the allowlist alone fails
# pinned_allowlist_cases (gh-1295, CTO RUN 63).
PINNED_ALLOWLIST = {
    "supabase/functions/meta-leadgen-webhook/email-footer.ts",
    "supabase/functions/send-partner-onboarding/claim-stage-sql-proof.ts",
    "supabase/functions/validate-contract-template/__fixtures__/otterquote-v3-reference-roofing-retail.pdf",
}

REPO_ROOT = HERE.parent


def make_root(tmp: pathlib.Path):
    """(root, functions dir, deployed dir) with the real layout, so out-of-tree and allowlist
    checks see the same relative paths production does."""
    root = tmp / "root"
    funcs = root / "supabase" / "functions"
    funcs.mkdir(parents=True)
    deployed = tmp / "deployed"
    deployed.mkdir()
    return root, funcs, deployed


def allowlist_cases():
    """The excuse is an exact path on a checked-in list, nothing else."""
    print("\nAllowlist: only exact listed paths are excused")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-allow-"))
    try:
        root, funcs, deployed = make_root(tmp)
        idx = "import { a } from './used.ts'\na()\n"
        for slug in ("fn", "other"):
            for r in (funcs, deployed):
                write(r, slug, "index.ts", idx)
                write(r, slug, "used.ts", "export const a = () => 1\n")
            write(funcs, slug, "email-footer.ts", "export const f = 'x'\n")  # in repo, absent from deploy
        write(funcs, "fn", "email-footer.test.ts", "import { f } from './email-footer.ts'\n")
        write(funcs, "fn", "__fixtures__/ref.pdf", "%PDF\n")
        listed = {
            "supabase/functions/fn/email-footer.ts": "test-only helper",
            "supabase/functions/fn/__fixtures__/ref.pdf": "test-only fixture",
        }

        def run(allow):
            return drift.build_report(funcs, deployed, ["fn", "other"], repo_slugs=["fn", "other"],
                                      repo_root=root, allowlist=allow)

        none = run({})
        v = verdicts_of(none)
        check("no allowlist: unreferenced email-footer.ts is DRIFTED (nothing is recognised)", v["fn"], drift.DRIFTED)
        statuses = {f["path"]: f["status"] for f in none["functions"][0]["files"]}
        check("no allowlist: statuses", (statuses["email-footer.ts"], statuses["__fixtures__/ref.pdf"]),
              ("missing_in_deploy", "missing_in_deploy"))

        rep = run(listed)
        v = verdicts_of(rep)
        check("listed: fn is IDENTICAL", v["fn"], drift.IDENTICAL)
        check("listed: the same file name in ANOTHER function is still DRIFTED (exact path only)", v["other"], drift.DRIFTED)
        check("listed: report names exactly the two excused files",
              sorted((e["slug"], e["path"]) for e in rep["excused"]),
              [("fn", "supabase/functions/fn/__fixtures__/ref.pdf"), ("fn", "supabase/functions/fn/email-footer.ts")])
        check("listed: each excused file carries its reason", all(e["reason"] for e in rep["excused"]), True)
        check("listed: no violations, no stale entries", (rep["allowlist_violations"], rep["allowlist_stale"]), ({}, []))
        md = drift.render_markdown(rep)
        check("excused files are printed in the summary (reason included)", "supabase/functions/fn/email-footer.ts" in md and "test-only helper" in md, True)
        check("exit code with the unlisted function present -> 1", drift.report_exit_code(rep), 1)

        # A listed file that IS deployed and differs is `differs`; being listed excuses absence only.
        write(deployed, "fn", "email-footer.ts", "export const f = 'CHANGED'\n")
        rep = run(listed)
        st = {f["path"]: f["status"] for f in rep["functions"][0]["files"]}
        check("listed but deployed and different -> differs", (st["email-footer.ts"], verdicts_of(rep)["fn"]), ("differs", drift.DRIFTED))
        (deployed / "fn" / "email-footer.ts").unlink()

        # Stale entry (names no file) is reported, never silently kept.
        rep = drift.build_report(funcs, deployed, ["fn"], repo_slugs=["fn"], repo_root=root,
                                 allowlist={**listed, "supabase/functions/fn/gone.ts": "was deleted"})
        check("stale entry reported", rep["allowlist_stale"], ["supabase/functions/fn/gone.ts"])
        check("stale entry printed", "supabase/functions/fn/gone.ts" in drift.render_markdown(rep), True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nAllowlist file format")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-allowfmt-"))
    try:
        def load(text):
            f = tmp / "a.txt"
            f.write_text(text, encoding="utf-8")
            try:
                return drift.load_allowlist(f)
            except drift.AllowlistError as exc:
                return "ERR"
        good = "supabase/functions/a/b.ts :: because\n"
        check("good line parses", load("# c\n\n" + good), {"supabase/functions/a/b.ts": "because"})
        for label, text in (
            ("glob", "supabase/functions/a/*.ts :: x\n"),
            ("directory", "supabase/functions/a/ :: x\n"),
            ("no reason", "supabase/functions/a/b.ts\n"),
            ("empty reason", "supabase/functions/a/b.ts :: \n"),
            ("outside supabase/functions", "react-app/app/lib/t.ts :: x\n"),
            ("path traversal", "supabase/functions/a/../b/c.ts :: x\n"),
            ("duplicate", good + good),
        ):
            check(f"rejected: {label}", load(text), "ERR")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# Shapes that earlier attempts tried to recognise (PR #2600 reviews 1-3). None is recognised
# any more, so every one must read DRIFTED when the needed file is missing from the deploy and
# not on the allowlist. The point is not these twenty shapes; it is that no shape can excuse.
SHAPES = {
    "B1 comment with apostrophe inside import braces": b"import {\n  a, // don't drop this\n} from './need.ts'\n",
    "B3 import{a}from'./need.ts'": b"import{a}from'./need.ts'\n",
    "B4 dynamic import with trailing comma": b"await import(\n  './need.ts',\n)\n",
    "B5 dynamic import via template literal": b"await import(`./need.ts`)\n",
    "B6 import-map alias": b"import { a } from '@/need.ts'\n",
    "B8 Deno.readTextFile": b"await Deno.readTextFile(new URL('./need.ts', import.meta.url))\n",
    "B9 Worker URL": b"new Worker(new URL('./need.ts', import.meta.url).href, { type: 'module' })\n",
    "B11 extensionless specifier": b"import { a } from './need'\n",
    "B12 createRequire": b"createRequire(import.meta.url)('./need.ts')\n",
    "R1 Latin-1 byte in index.ts": b"// caf\xe9\nimport './need.ts'\n",
    "R6 index.ts saved as UTF-16": "import './need.ts'\n".encode("utf-16"),
    "R2 computed import (concatenation)": b"await import('./' + 'need' + '.ts')\n",
    "R3 computed import (template literal)": b"const k = 'need'\nawait import(`./${k}.ts`)\n",
    "A5d block comment before computed import": b"/* c */ const m: any = await import('./' + k + '.ts')\n",
    "A5e continuation line starting with *": b"const v = 2\n  * (await import('./' + k + '.ts')).n\n",
    "A5f comment between import and paren": b"await import /* dyn */ ('./' + k + '.ts')\n",
    "N1 computed Worker URL": b"new Worker(new URL('./' + name + '.ts', import.meta.url).href)\n",
    "N2 computed readTextFile": b"Deno.readTextFile(new URL(`./${name}.ts`, import.meta.url))\n",
    "N10 computed createRequire": b"createRequire(import.meta.url)('./' + kind)\n",
    "N3 directory import": b"import { a } from './need'\n",
    "no reference at all": b"console.log('hello')\n",
}


def no_shape_cases():
    print("\nNo code shape can excuse a missing file (needed file absent from deploy, not listed -> DRIFTED)")
    for label, index_src in SHAPES.items():
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-shape-"))
        try:
            root, funcs, deployed = make_root(tmp)
            for r in (funcs, deployed):
                write_bytes(r, "fn", "index.ts", index_src)
            write_bytes(funcs, "fn", "need.ts", b"export const a = 1\n")
            rep = drift.build_report(funcs, deployed, ["fn"], repo_slugs=["fn"], repo_root=root, allowlist={})
            st = {f["path"]: f["status"] for f in rep["functions"][0]["files"]}
            check(f"{label}", (rep["functions"][0]["verdict"], st["need.ts"]), (drift.DRIFTED, "missing_in_deploy"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def write_bytes(root: pathlib.Path, slug: str, name: str, data: bytes):
    d = root / slug
    (d / name).parent.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(data)


def pinned_allowlist_cases():
    """The checked-in allowlist cannot silently grow, and no listed file may be imported by
    non-test code."""
    print("\nChecked-in allowlist is pinned")
    path = HERE / drift.ALLOWLIST_FILENAME
    try:
        real = drift.load_allowlist(path)
    except drift.AllowlistError as exc:
        real = {}
        print(f"  FAIL  allowlist unreadable: {exc}")
        FAILURES.append("allowlist unreadable")
    check("allowlist is exactly the pinned set (add a line -> update PINNED_ALLOWLIST in the same reviewed diff)",
          sorted(real), sorted(PINNED_ALLOWLIST))
    check("every entry has a one-line reason", all(r and "\n" not in r for r in real.values()), True)
    check("every entry names a file that exists in the repo", sorted(k for k in real if not (REPO_ROOT / k).is_file()), [])
    check("no listed file is imported or read by non-test code in the real tree",
          drift.allowlist_import_violations(real, REPO_ROOT), {})
    check("no `*.test.*` file is quoted by non-test code in the real tree",
          drift.test_file_import_violations(REPO_ROOT), {})
    check("the real tree has no test-NAMED file that is not `*.test.*` (nothing relied on the old name rule)",
          sorted(str(q.relative_to(REPO_ROOT)) for q in (REPO_ROOT / drift.FUNCTIONS_DIR).rglob("*")
                 if q.is_file() and (q.name.startswith("test_") or q.name.endswith("_test.ts")) and not drift.is_test_path(q.name)),
          [])

    print("\nA listed file that non-test code imports fails loudly")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-viol-"))
    try:
        root, funcs, deployed = make_root(tmp)
        target = "supabase/functions/fn/helper.ts"
        write(funcs, "fn", "helper.ts", "export const h = 1\n")
        write(funcs, "fn", "helper.test.ts", "import { h } from './helper.ts'\n")  # a test importing it is fine
        allow = {target: "test-only"}
        check("only a test imports it -> no violation", drift.allowlist_import_violations(allow, root), {})
        for label, importer, src in (
            ("same-dir relative import", "fn/index.ts", "import { h } from './helper.ts'\n"),
            ("extensionless import", "fn/index.ts", "import { h } from './helper'\n"),
            ("import from another function", "other/index.ts", "import { h } from '../fn/helper.ts'\n"),
            ("_shared re-export", "_shared/x.ts", "export { h } from '../fn/helper.ts'\n"),
            ("dynamic import", "fn/index.ts", "const m = await import('./helper.ts')\n"),
            ("new URL read", "fn/index.ts", "new URL('./helper.ts', import.meta.url)\n"),
            ("alias", "fn/index.ts", "import { h } from '@/lib/helper.ts'\n"),
        ):
            slug, name = importer.split("/", 1)
            write(funcs, slug, name, src)
            got = drift.allowlist_import_violations(allow, root)
            check(f"{label} -> violation", got, {target: f"supabase/functions/{importer}"})
            (funcs / slug / name).unlink()
        rep = drift.build_report(funcs, deployed, [], repo_slugs=["fn"], repo_root=root, allowlist=allow)
        check("no violation, nothing deployed -> exit 2 (zero measured)", drift.report_exit_code(rep), 2)
        write(funcs, "fn", "index.ts", "import { h } from './helper.ts'\n")
        for r in (deployed,):
            write(r, "fn", "index.ts", "import { h } from './helper.ts'\n")
        rep = drift.build_report(funcs, deployed, ["fn"], repo_slugs=["fn"], repo_root=root, allowlist=allow)
        st = {f["path"]: f["status"] for f in rep["functions"][0]["files"]}
        check("imported + listed + missing from deploy: entry NOT applied -> missing_in_deploy / DRIFTED",
              (st["helper.ts"], rep["functions"][0]["verdict"]), ("missing_in_deploy", drift.DRIFTED))
        check("imported + listed: violation reported and exit 2", (list(rep["allowlist_violations"]), drift.report_exit_code(rep)), ([target], 2))
        check("imported + listed: summary says ALLOWLIST INVALID", "ALLOWLIST INVALID" in drift.render_markdown(rep), True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_name_cases():
    """CTO RUN 63 (PR #2600 review 6051654612): a file is excused by NAME only if it is
    `*.test.*` and no non-test code quotes it. `test_*` and `*_test.ts` are ordinary names."""
    print("\nTest-named files: only an un-imported `*.test.*` file is excused by name")
    for name, want in (
        ("a.test.ts", True), ("a.test.js", True), ("a.test.tsx", True), ("a/b/c.test.mjs", True),
        ("test_mode.ts", False), ("util_test.ts", False), ("test_helpers.ts", False),
        ("latest.ts", False), (".test.ts", False), ("a.test.", False), ("a.tests.ts", False),
    ):
        check(f"is_test_path({name!r})", drift.is_test_path(name), want)

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-testname-"))
    try:
        root, funcs, deployed = make_root(tmp)

        def fresh(index_src, extra):
            """One function `fn`: index.ts (same in repo and deploy) plus `extra` repo files that
            are absent from the deploy."""
            shutil.rmtree(funcs, ignore_errors=True)
            shutil.rmtree(deployed, ignore_errors=True)
            funcs.mkdir(parents=True)
            deployed.mkdir()
            write(funcs, "fn", "index.ts", index_src)
            write(deployed, "fn", "index.ts", index_src)
            for name, src in extra.items():
                write(funcs, "fn", name, src)

        def run(allow=None):
            return drift.build_report(funcs, deployed, ["fn"], repo_slugs=["fn"], repo_root=root, allowlist=allow or {})

        def st(rep):
            return {f["path"]: f["status"] for f in rep["functions"][0]["files"]}

        # C2 / C3: production files whose names merely look like tests, imported by index.ts.
        for label, fname in (("C2 ./test_mode.ts", "test_mode.ts"), ("C3 ./util_test.ts", "util_test.ts")):
            fresh(f"import {{ m }} from './{fname}'\nm()\n", {fname: "export const m = () => 1\n"})
            rep = run()
            check(f"{label} imported by index.ts, missing from deploy -> missing_in_deploy / DRIFTED / exit 1",
                  (st(rep)[fname], verdicts_of(rep)["fn"], drift.report_exit_code(rep)),
                  ("missing_in_deploy", drift.DRIFTED, 1))
            check(f"{label} is not printed as excused", rep["excused"], [])
        # The same names with NOTHING importing them are not excused either: only `*.test.*` is.
        for fname in ("test_mode.ts", "util_test.ts"):
            fresh("console.log('hi')\n", {fname: "export const m = 1\n"})
            rep = run()
            check(f"{fname} not imported, missing from deploy -> still DRIFTED (not a `*.test.*` name)",
                  (st(rep)[fname], verdicts_of(rep)["fn"]), ("missing_in_deploy", drift.DRIFTED))

        # C5: a test-NAMED importer that is not `*.test.*` cannot hide an import of a listed file.
        target = "supabase/functions/fn/email-footer.ts"
        fresh("import { h } from './test_helpers.ts'\nh()\n",
              {"test_helpers.ts": "import { f } from './email-footer.ts'\nexport const h = () => f\n",
               "email-footer.ts": "export const f = 'x'\n"})
        rep = run({target: "test-only"})
        check("C5 test_helpers.ts (not *.test.*) imports a listed file -> violation names it",
              rep["allowlist_violations"], {target: "supabase/functions/fn/test_helpers.ts"})
        check("C5 -> entry not applied, exit 2",
              (st(rep)["email-footer.ts"], st(rep)["test_helpers.ts"], drift.report_exit_code(rep)),
              ("missing_in_deploy", "missing_in_deploy", 2))
        check("C5 -> summary says ALLOWLIST INVALID", "ALLOWLIST INVALID" in drift.render_markdown(rep), True)
        # ...but a `*.test.*` importer of a listed file is still fine (the listed files' real shape).
        fresh("console.log('hi')\n",
              {"email-footer.test.ts": "import { f } from './email-footer.ts'\n", "email-footer.ts": "export const f = 'x'\n"})
        rep = run({target: "test-only"})
        check("a `*.test.*` importer of a listed file -> no violation, IDENTICAL, exit 0",
              (rep["allowlist_violations"], rep["test_name_violations"], verdicts_of(rep)["fn"], drift.report_exit_code(rep)),
              ({}, {}, drift.IDENTICAL, 0))

        # A `*.test.*` file that nothing imports: excused by name, as before.
        fresh("console.log('hi')\n", {"a.test.ts": "import { x } from './a.ts'\n"})
        rep = run()
        check("un-imported a.test.ts missing from deploy -> test_not_bundled / IDENTICAL / exit 0",
              (st(rep)["a.test.ts"], verdicts_of(rep)["fn"], drift.report_exit_code(rep)),
              ("test_not_bundled", drift.IDENTICAL, 0))
        # ...and one that a test-named helper or another test imports is still excused.
        fresh("console.log('hi')\n", {"a.test.ts": "export const t = 1\n", "b.test.ts": "import { t } from './a.test.ts'\n"})
        rep = run()
        check("a.test.ts imported only by b.test.ts -> still test_not_bundled",
              (st(rep)["a.test.ts"], rep["test_name_violations"]), ("test_not_bundled", {}))

        # A `*.test.*` file that non-test code imports is NOT excused, and the run exits 2.
        for label, src in (("relative", "import { t } from './a.test.ts'\n"),
                           ("extensionless", "import { t } from './a.test'\n"),
                           ("alias", "import { t } from '@/lib/a.test.ts'\n")):
            fresh(src, {"a.test.ts": "export const t = 1\n"})
            rep = run()
            check(f"{label} import of a.test.ts by index.ts -> missing_in_deploy / DRIFTED",
                  (st(rep)["a.test.ts"], verdicts_of(rep)["fn"]), ("missing_in_deploy", drift.DRIFTED))
            check(f"{label} import of a.test.ts -> test_name_violations, exit 2, summary says so",
                  (rep["test_name_violations"], drift.report_exit_code(rep),
                   "TEST-NAMED FILE IS IMPORTED" in drift.render_markdown(rep)),
                  ({"supabase/functions/fn/a.test.ts": "supabase/functions/fn/index.ts"}, 2, True))
        # An imported `*.test.*` file that the deploy DOES carry is compared normally.
        fresh("import { t } from './a.test.ts'\n", {"a.test.ts": "export const t = 1\n"})
        write(deployed, "fn", "a.test.ts", "export const t = 2\n")
        rep = run()
        check("imported a.test.ts deployed with different bytes -> differs", st(rep)["a.test.ts"], "differs")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def out_of_tree_cases():
    """PR #2600 review 3, finding 1: files the deploy carries from outside supabase/functions/
    must never read IDENTICAL unless they were actually compared."""
    print("\nOut-of-tree files are compared, or reported missing; never skipped")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-oot2-"))
    try:
        root, funcs, deployed = make_root(tmp)
        write(funcs, "fn", "index.ts", "import '../../../app/lib/types.ts'\n")
        write(deployed, "fn", "index.ts", "import '../../../app/lib/types.ts'\n")
        oot = deployed / drift.OUT_OF_TREE_DIR / "fn" / "app/lib"
        oot.mkdir(parents=True)
        (oot / "types.ts").write_bytes(b"export const T = 'STALE'\n")
        rep = drift.build_report(funcs, deployed, ["fn"], repo_slugs=["fn"])  # no repo_root
        check("no repo_root: out-of-tree file is NOT skipped -> DRIFTED", rep["functions"][0]["verdict"], drift.DRIFTED)
        (root / "app/lib").mkdir(parents=True)
        (root / "app/lib/types.ts").write_bytes(b"export const T = 'main'\n")
        rep = drift.build_report(funcs, deployed, ["fn"], repo_slugs=["fn"], repo_root=root)
        check("repo_root given, bytes differ -> DRIFTED", rep["functions"][0]["verdict"], drift.DRIFTED)
        (root / "app/lib/types.ts").write_bytes(b"export const T = 'STALE'\n")
        rep = drift.build_report(funcs, deployed, ["fn"], repo_slugs=["fn"], repo_root=root)
        check("repo_root given, bytes equal -> IDENTICAL", rep["functions"][0]["verdict"], drift.IDENTICAL)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def fetch_failed_cases():
    """PR #2600 review 3, finding 3: a fetch-failed function appears ONCE, as COULD NOT MEASURE."""
    print("\nA fetch-failed function is one FETCH_FAILED row, never also 'never deployed' or 'failing'")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-ff-"))
    try:
        root, funcs, deployed = make_root(tmp)
        for slug in ("alpha", "beta"):
            write(funcs, slug, "index.ts", "ok()\n")
        write(deployed, "alpha", "index.ts", "ok()\n")
        rep = drift.build_report(funcs, deployed, ["alpha"], repo_slugs=["alpha", "beta"], repo_root=root,
                                 fetch_failed={"beta": "CLI: exit 1: boom; Management API: URLError"})
        rows = [r for r in rep["functions"] if r["slug"] == "beta"]
        check("beta has exactly one row", [r["verdict"] for r in rows], [drift.FETCH_FAILED])
        check("counts: no IN_REPO_NEVER_DEPLOYED", rep["counts"], {drift.IDENTICAL: 1, drift.FETCH_FAILED: 1})
        md = drift.render_markdown(rep)
        check("banner: COULD NOT MEASURE 1, with the reason", "COULD NOT MEASURE 1 function(s)" in md and "URLError" in md, True)
        check("banner: not counted as 'measured and failing'", "measured and failing" not in md, True)
        check("table: beta appears once", md.count("| `beta` |"), 1)
        check("exit code stays 2", drift.report_exit_code(rep), 2)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main_fetch_branch_selftest():
    """End to end through the real main() and the real fetch branch, with a fake `supabase`
    executable on PATH and the Management API stubbed to refuse. Catches main() losing the
    FETCH_FAILED rows (the wiring unit tests on build_report cannot see). PR #2600 review 3."""
    import contextlib
    import io
    import json

    print("\nmain() through the fetch branch (fake supabase CLI, API down)")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-main-"))
    saved = (os.environ.get("PATH"), os.environ.get("SUPABASE_ACCESS_TOKEN"), sys.argv[:], drift._reclaim_tree,
             drift.RETRY_BACKOFF_SECONDS, drift.urllib.request.urlopen)
    try:
        root, funcs, _ = make_root(tmp)
        body = "export const handler = () => new Response('ok')\n"
        for slug in ("alpha", "beta"):
            write(funcs, slug, "index.ts", body)
        write(funcs, "alpha", "excused.ts", "export const x = 1\n")  # in repo, never deployed, listed below
        allow = tmp / "allow.txt"
        allow.write_text("supabase/functions/alpha/excused.ts :: planted, listed on purpose\n", encoding="utf-8")
        bindir = tmp / "bin"
        bindir.mkdir()
        fake = bindir / "supabase"
        fake.write_text(
            f"#!{sys.executable}\n"
            "import json, os, pathlib, sys\n"
            "a = sys.argv[1:]\n"
            "slugs = os.environ['FAKE_SLUGS'].split(',')\n"
            "if a[:2] == ['functions', 'list']:\n"
            "    print(json.dumps([{'slug': s} for s in slugs])); sys.exit(0)\n"
            "if a[:2] == ['functions', 'download']:\n"
            "    slug = a[2]\n"
            "    if slug in os.environ.get('FAKE_FAIL', '').split(','):\n"
            "        sys.stderr.write('a real error line\\nTry rerunning the command with --debug to troubleshoot the error.\\n'); sys.exit(1)\n"
            "    d = pathlib.Path('supabase/functions') / slug; d.mkdir(parents=True)\n"
            "    (d / 'index.ts').write_text(os.environ['FAKE_BODY']); sys.exit(0)\n"
            "sys.exit(9)\n",
            encoding="utf-8",
        )
        fake.chmod(0o755)

        def refuse(*_a, **_k):
            raise drift.urllib.error.URLError("connection refused")

        def run(fail):
            out_md, out_json = tmp / "r.md", tmp / "r.json"
            os.environ["PATH"] = str(bindir) + os.pathsep + saved[0]
            os.environ["SUPABASE_ACCESS_TOKEN"] = "sbp_fake_marker_value"
            os.environ.update(FAKE_SLUGS="alpha,beta", FAKE_FAIL=fail, FAKE_BODY=body)
            sys.argv = ["drift", "--repo-root", str(root), "--project-ref", "ref", "--allowlist", str(allow),
                        "--markdown-out", str(out_md), "--json-out", str(out_json)]
            drift._reclaim_tree = lambda p: None  # no sudo in a unit test
            drift.RETRY_BACKOFF_SECONDS = (0, 0)
            drift.urllib.request.urlopen = refuse
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = drift.main()
            return code, out.getvalue(), err.getvalue(), out_md.read_text(encoding="utf-8"), json.loads(out_json.read_text(encoding="utf-8"))

        code, out, err, md, js = run(fail="")
        check("all fetched, allowlisted file excused -> exit 0", code, 0)
        check("excused file printed to stdout and the markdown report",
              "supabase/functions/alpha/excused.ts" in out and "supabase/functions/alpha/excused.ts" in md, True)

        code, out, err, md, js = run(fail="beta")
        check("beta fetch fails on every route -> exit 2", code, 2)
        rows = [r for r in js["functions"] if r["slug"] == "beta"]
        check("JSON: beta is ONE FETCH_FAILED row", [r["verdict"] for r in rows], [drift.FETCH_FAILED])
        check("JSON: counts", js["counts"], {drift.IDENTICAL: 1, drift.FETCH_FAILED: 1})
        check("markdown: beta appears once in the table and is FETCH_FAILED",
              [ln for ln in md.splitlines() if ln.startswith("| `beta` |")] and
              len([ln for ln in md.splitlines() if ln.startswith("| `beta` |")]) == 1 and "FETCH_FAILED" in md, True)
        check("markdown: never says beta was never deployed", "IN_REPO_NEVER_DEPLOYED" not in md, True)
        check("markdown: not counted as measured and failing", "measured and failing" not in md, True)
        check("markdown: reason is the real error line, not the CLI boilerplate",
              "a real error line" in md and "could not measure: CLI: exit 1: a real error line" in md, True)
        check("token value never appears in stdout, stderr or the report",
              any("sbp_fake_marker_value" in t for t in (out, err, md, json.dumps(js))), False)
    finally:
        (os.environ.__setitem__("PATH", saved[0]))
        for k in ("FAKE_SLUGS", "FAKE_FAIL", "FAKE_BODY"):
            os.environ.pop(k, None)
        if saved[1] is None:
            os.environ.pop("SUPABASE_ACCESS_TOKEN", None)
        else:
            os.environ["SUPABASE_ACCESS_TOKEN"] = saved[1]
        sys.argv = saved[2]
        drift._reclaim_tree, drift.RETRY_BACKOFF_SECONDS, drift.urllib.request.urlopen = saved[3:]
        shutil.rmtree(tmp, ignore_errors=True)


def planted_drift_selftest():
    """End-to-end negative control through the real CLI entry point (--deployed-dir, no network):
    the detector must PASS (exit 0) when the bytes are equal and FAIL (exit 1) when one byte
    differs. A detector that cannot fail proves nothing."""
    import subprocess
    print("\nPlanted drift, end to end (negative control)")
    script = str(HERE / "edge-function-drift-check.py")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-plant-"))
    try:
        root = tmp / "root"
        funcs = root / "supabase" / "functions"
        deployed = tmp / "deployed"
        body = "export const handler = () => new Response('ok')\n"
        write(funcs, "planted", "index.ts", body)
        write(deployed, "planted", "index.ts", body)

        def run():
            return subprocess.run([sys.executable, script, "--repo-root", str(root), "--deployed-dir", str(deployed)],
                                  capture_output=True, text=True).returncode

        check("equal bytes -> exit 0 (PASS)", run(), 0)
        # one codepoint: U+0020 -> U+00A0 in the deployed copy (invisible to any normalizing diff)
        write(deployed, "planted", "index.ts", body.replace("new Response", "new\u00a0Response"))
        check("one byte differs -> exit 1 (FAIL)", run(), 1)
        write(deployed, "planted", "index.ts", body)
        check("restored -> exit 0 again", run(), 0)
        (funcs / "planted" / "extra.ts").write_text("export const x = 1\n", encoding="utf-8")
        write(funcs, "planted", "index.ts", body + "import './extra.ts'\n")
        write(deployed, "planted", "index.ts", body + "import './extra.ts'\n")
        check("reachable file missing from deploy -> exit 1 (FAIL)", run(), 1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def fetch_policy_cases():
    """Retry / fallback / loud-unmeasured policy of download_function (CTO RUN 63)."""
    print("\nFetch policy: retry with backoff, API fallback, loud COULD NOT MEASURE")
    sleeps = []

    def flaky(fail_times):
        calls = {"n": 0}

        def cli(cli_path, ref, slug, dest):
            calls["n"] += 1
            if calls["n"] <= fail_times:
                return False, "exit 1: connection reset"
            (dest / slug).mkdir(parents=True, exist_ok=True)
            (dest / slug / "index.ts").write_text("x\n", encoding="utf-8")
            return True, ""
        return cli, calls

    def api_must_not_run(ref, slug, dest):
        raise AssertionError("API fallback must not run when a CLI retry settles it")

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-fetch-"))
    try:
        cli, calls = flaky(2)
        ok = drift.download_function("cli", "ref", "fn", tmp, sleep=sleeps.append, api_download=api_must_not_run, cli_download=cli)
        check("transient failure settled on 3rd CLI try -> measured", ok, True)
        check("exactly 3 CLI tries", calls["n"], 3)
        check("backoff between tries (2 sleeps, growing)", sleeps == list(drift.RETRY_BACKOFF_SECONDS[:2]) and sleeps[0] < sleeps[1], True)

        sleeps.clear()
        cli, calls = flaky(99)

        def api_fail(ref, slug, dest):
            raise ValueError("Management API HTTP 503")
        ok = drift.download_function("cli", "ref", "fn2", tmp, sleep=sleeps.append, api_download=api_fail, cli_download=cli)
        check("retry cannot settle it -> FETCH failed (not clean)", ok, False)
        check("3 CLI tries before giving up", calls["n"], 3)
        check("reason recorded with both routes", "CLI:" in drift.FETCH_REASONS["fn2"] and "Management API" in drift.FETCH_REASONS["fn2"], True)
        report = drift.build_report(tmp, tmp, ["fn"], repo_slugs=["fn"])
        report["functions"].append({"slug": "fn2", "verdict": drift.FETCH_FAILED, "files": [], "reason": drift.FETCH_REASONS["fn2"]})
        check("unmeasured function keeps the run RED (exit 2)", drift.report_exit_code(report), 2)
        md = drift.render_markdown(report)
        check("summary says COULD NOT MEASURE and 'NOT a drift finding'", "COULD NOT MEASURE 1 function(s)" in md and "NOT a drift finding" in md, True)
        check("summary names the function and the reason", "`fn2`" in md and "HTTP 503" in md, True)

        sleeps.clear()
        cli_calls = {"n": 0}

        def refuses(cli_path, ref, slug, dest):
            cli_calls["n"] += 1
            return False, "exit 1: refusing to extract Function file outside /x: source/react-app/a.ts"
        api_calls = []
        ok = drift.download_function("cli", "ref", "fn3", tmp, sleep=sleeps.append,
                                     api_download=lambda ref, slug, dest: api_calls.append(slug), cli_download=refuses)
        check("out-of-tree refusal is deterministic: 1 CLI try, no sleeps", (cli_calls["n"], sleeps), (1, []))
        check("out-of-tree refusal falls back to the Management API and measures", (ok, api_calls), (True, ["fn3"]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nManagement API bundle: root conventions and out-of-tree comparison")
    bundle = {"source/supabase/functions/fn/index.ts": b"i", "source/react-app/app/lib/t.ts": b"T",
              "source/supabase/functions/_shared/s.ts": b"s", "source/supabase/functions/other/o.ts": b"o"}
    inside, outside = drift.split_bundle("fn", bundle)
    check("repo-rooted bundle: in-tree", sorted(inside), ["index.ts"])
    check("repo-rooted bundle: out-of-tree", sorted(outside), ["react-app/app/lib/t.ts"])
    inside, outside = drift.split_bundle("fn", {"source/functions/fn/index.ts": b"i", "source/functions/_shared/s.ts": b"s"})
    check("supabase-rooted bundle", (sorted(inside), outside), (["index.ts"], {}))
    inside, outside = drift.split_bundle("fn", {"fn/index.ts": b"i", "fn/lib/a.ts": b"a"})
    check("functions-rooted bundle", (sorted(inside), outside), (["index.ts", "lib/a.ts"], {}))

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ef-drift-oot-"))
    try:
        repo_root = tmp / "root"
        funcs = repo_root / "supabase" / "functions"
        write(funcs, "fn", "index.ts", "import '../../../react-app/app/lib/t.ts'\n")
        (repo_root / "react-app/app/lib").mkdir(parents=True)
        (repo_root / "react-app/app/lib/t.ts").write_bytes(b"T")
        os.environ["SUPABASE_ACCESS_TOKEN"] = "sbp_test_not_real"
        for label, oot_bytes, want in (("out-of-tree equal", b"T", drift.IDENTICAL), ("out-of-tree planted drift", b"U", drift.DRIFTED)):
            deployed = tmp / ("d-" + label.replace(" ", "-"))
            body = {"source/supabase/functions/fn/index.ts": (funcs / "fn/index.ts").read_bytes(),
                    "source/react-app/app/lib/t.ts": oot_bytes}
            drift._api_download("ref", "fn", deployed, read_body=lambda ref, slug, token, b=body: b)
            r = drift.build_report(funcs, deployed, ["fn"], repo_slugs=["fn"], repo_root=repo_root)
            check(f"{label} (notify-admin-new-homeowner shape): verdict", r["functions"][0]["verdict"], want)
    finally:
        os.environ.pop("SUPABASE_ACCESS_TOKEN", None)
        shutil.rmtree(tmp, ignore_errors=True)


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

        check("unlisted-orphan (unreferenced, not on the allowlist -> DRIFTED)", v["unlisted-orphan"], drift.DRIFTED)
        check("transitive-drop (reachable via used.ts, absent from deploy)", v["transitive-drop"], drift.DRIFTED)
        check("no-entry (no entrypoint: excuse nothing)", v["no-entry"], drift.DRIFTED)
        check("unref-differs (deployed and different)", v["unref-differs"], drift.DRIFTED)

        print("\nPer-file detail")
        row = next(r for r in report["functions"] if r["slug"] == "unlisted-orphan")
        statuses = {f["path"]: f["status"] for f in row["files"]}
        check("unlisted-orphan email-footer.ts", statuses["email-footer.ts"], "missing_in_deploy")
        check("unlisted-orphan email-footer.test.ts (test file)", statuses["email-footer.test.ts"], "test_not_bundled")
        row = next(r for r in report["functions"] if r["slug"] == "transitive-drop")
        statuses = {f["path"]: f["status"] for f in row["files"]}
        check("transitive-drop deep.ts", statuses["deep.ts"], "missing_in_deploy")
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

        allowlist_cases()
        no_shape_cases()
        pinned_allowlist_cases()
        test_name_cases()
        out_of_tree_cases()
        fetch_failed_cases()
        planted_drift_selftest()
        main_fetch_branch_selftest()
        fetch_policy_cases()

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
