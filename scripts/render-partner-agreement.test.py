#!/usr/bin/env python3
"""Self-test for scripts/render-partner-agreement.py (gh-3239, #3238).

The renderer's --check mode is a detector: it must exit 0 when partner-agreement.html holds exactly the rendering of
docs/legal/partner-agreement-v4-2026-10.md, and exit 1 (OUT_OF_DATE) when the page's legal text differs from the source.
Negative controls: a one-word edit to the page, a one-word edit to the source, a removed marker, a source whose title no
longer matches the page hero, and a source missing the Section 14(a) cross-reference must each be REJECTED.
Run: python3 scripts/render-partner-agreement.test.py
"""
import contextlib
import importlib.util
import io
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("render_partner_agreement", HERE / "render-partner-agreement.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

passed = failed = 0


def check(label, cond):
    global passed, failed
    if cond:
        passed += 1
        print("PASS  " + label)
    else:
        failed += 1
        print("FAIL  " + label)


def run_check(src_text, page_text, argv=("--check",)):
    """Run main() against temp copies; returns (exit_code, written_page_text)."""
    with tempfile.TemporaryDirectory() as d:
        src = pathlib.Path(d) / "src.md"
        page = pathlib.Path(d) / "page.html"
        src.write_text(src_text, encoding="utf-8")
        page.write_text(page_text, encoding="utf-8")
        old = (mod.SRC, mod.PAGE, mod.ROOT, sys.argv)
        mod.SRC, mod.PAGE, mod.ROOT = src, page, pathlib.Path(d)
        sys.argv = ["render-partner-agreement.py", *argv]
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    code = mod.main()
                except SystemExit as e:  # render() refuses a malformed source
                    code = "REFUSED"
        finally:
            mod.SRC, mod.PAGE, mod.ROOT, sys.argv = old
        return code, page.read_text(encoding="utf-8")


SRC_TEXT = mod.SRC.read_text(encoding="utf-8")
PAGE_TEXT = mod.PAGE.read_text(encoding="utf-8")

# positive control: the committed pair is in sync
code, _ = run_check(SRC_TEXT, PAGE_TEXT)
check("committed partner-agreement.html matches its docs/legal source (--check exit 0)", code == 0)

# negative controls: each must be REJECTED with OUT_OF_DATE (exit 1) or REFUSED
code, _ = run_check(SRC_TEXT, PAGE_TEXT.replace("earns no Measurement Referral Fee", "earns no Measurement Fee", 1))
check("NEGATIVE CONTROL page edited by one word -> OUT_OF_DATE REJECTED (exit 1)", code == 1)

code, _ = run_check(SRC_TEXT.replace("Venmo or PayPal", "Venmo, PayPal or check", 1), PAGE_TEXT)
check("NEGATIVE CONTROL source edited, page not re-rendered -> OUT_OF_DATE REJECTED (exit 1)", code == 1)

code, _ = run_check(SRC_TEXT, PAGE_TEXT.replace(mod.END, "", 1))
check("NEGATIVE CONTROL END marker removed -> MARKER_MISSING REJECTED (exit 2)", code == 2)

code, _ = run_check(SRC_TEXT.replace("# Partner Referral Agreement", "# Partner Agreement", 1), PAGE_TEXT)
check("NEGATIVE CONTROL source title no longer matches the page hero -> REFUSED REJECTED", code == "REFUSED")

code, _ = run_check(SRC_TEXT.replace("including the representation in Section 7", "including Section 7", 1), PAGE_TEXT)
check("NEGATIVE CONTROL Section 14(a) cross-reference missing -> REFUSED REJECTED", code == "REFUSED")

# a write run repairs a stale page, and the repaired page then passes --check
code, repaired = run_check(SRC_TEXT, PAGE_TEXT.replace("earns no Measurement Referral Fee", "earns no Measurement Fee", 1), argv=())
code2, _ = run_check(SRC_TEXT, repaired)
check("write mode re-renders a stale page and the result passes --check", code == 0 and code2 == 0 and repaired == PAGE_TEXT)

# rendering keeps the inspector-track hide on the same four elements as v3
block = mod.render(SRC_TEXT)
check("render marks exactly four inspector-hide elements (fee block, 4.1, Section 7, 14(a) span)", block.count("inspector-hide") == 4)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
