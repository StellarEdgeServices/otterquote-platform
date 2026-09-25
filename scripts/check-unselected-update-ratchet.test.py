#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/check-unselected-update-ratchet.py
(gh-2105, added on review of PR #2199 -- finding B1: a new detector-shaped
script shipped with no self-test, and the repo's own Detector Negative
Control Gate (scripts/detector-negative-control-check.py, gh-1738) failed
on it for exactly that reason.

Each assertion below is paired with the mutation it exists to catch, per
that gate's own requirement ("a firing self-test... must exit 0 and print
at least one self-reported PASS/FAIL assertion line").

No network, no repo tree mutation -- every fixture is a tempfile.

Run: python3 scripts/check-unselected-update-ratchet.test.py
"""
import importlib.util
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ratchet", HERE / "check-unselected-update-ratchet.py")
ratchet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ratchet)

failures: list[str] = []


def check(name, got, want):
    if got != want:
        failures.append(f"{name}: got {got!r}, want {want!r}")
        print(f"FAIL  {name}: got {got!r}, want {want!r}")
    else:
        print(f"PASS  {name}")


def violations_for(text: str, suffix: str = ".ts") -> list[int]:
    with tempfile.TemporaryDirectory() as tmp:
        p = pathlib.Path(tmp) / f"f{suffix}"
        p.write_text(text)
        return ratchet.find_violations(p)


print("gh-2105 check-unselected-update-ratchet proof of detection")

# 1. The base case this whole detector exists for: an .update() with no
#    .select() anywhere nearby must be flagged.
check(
    "an .update() with no .select() at all is a violation",
    violations_for("await supabase.from('claims').update({a: 1}).eq('id', x);\n"),
    [1],
)

# 2. A real fix -- .select() chained onto the SAME statement -- must clear it,
#    including when the chain spans several lines (the #2103 pattern this
#    detector is meant to enforce).
check(
    "multi-line .update()...select() chain is NOT a violation",
    violations_for(
        "await supabase\n"
        "  .from('claims')\n"
        "  .update({a: 1})\n"
        "  .eq('id', x)\n"
        "  .select('id');\n"
    ),
    [],
)

# 3. REVIEW: FAIL on PR #2199, finding B2 -- the reviewer's exact negative-
#    control case. The scan window used to terminate on `";" in lines[j] and
#    j > i`, so a `;` on the .update() TRIGGER line itself (a complete
#    one-line statement) never ended the scan; the window ran on into the
#    NEXT, unrelated statement, and its .select() hid the violation. This is
#    the mutation B2 asked to be used as the negative-control fixture.
check(
    "REVIEW B2: a one-line .update() with no .select(), followed by an "
    "UNRELATED statement that does call .select(), is still a violation",
    violations_for(
        "await supabase.from('claims').update({a: 1}).eq('id', x);\n"
        "const {data} = await supabase.from('quotes').select('id');\n"
    ),
    [1],
)

# 4. Companion negative control: a one-line .update() with no .select() and
#    nothing else in the file must still be caught (guards against a fix to
#    #3 that only works when a following statement exists).
check(
    "a one-line .update() with no .select(), alone in the file, is a violation",
    violations_for("await supabase.from('claims').update({a: 1}).eq('id', x);\n"),
    [1],
)

# 5. The `update-no-select-ok:` escape hatch (decision b sites) must actually
#    suppress the finding, both inline and on the line directly above.
check(
    "an inline update-no-select-ok annotation suppresses the violation",
    violations_for(
        "await supabase.from('claims').update({a: 1}).eq('id', x); // update-no-select-ok: idempotent re-send\n"
    ),
    [],
)
check(
    "an update-no-select-ok annotation on the line ABOVE also suppresses it",
    violations_for(
        "// update-no-select-ok: idempotent re-send\n"
        "await supabase.from('claims').update({a: 1}).eq('id', x);\n"
    ),
    [],
)

# 6. The ratchet's main() fires in both directions -- a NEW violation over
#    baseline fails, and staying at or under baseline passes -- driven
#    through the real module logic (BASELINE dict), not just find_violations
#    in isolation.
import contextlib
import io


def run_main_against(monkey_root: pathlib.Path, baseline: dict[str, int]) -> tuple[int, str]:
    old_repo = ratchet.REPO
    old_baseline = dict(ratchet.BASELINE)
    ratchet.REPO = monkey_root
    ratchet.BASELINE = baseline
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            code = ratchet.main()
    finally:
        ratchet.REPO = old_repo
        ratchet.BASELINE = old_baseline
    return code, buf.getvalue()


with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    (root / "js").mkdir()
    (root / "js" / "widget.js").write_text(
        "await supabase.from('claims').update({a: 1}).eq('id', x);\n"
    )
    code, out = run_main_against(root, {"js/widget.js": 1})
    check("a file AT its baseline passes the gate", code, 0)
    check("... and reports GATE: PASS-shaped output", "no file exceeds its baseline" in out, True)

    code, out = run_main_against(root, {"js/widget.js": 0})
    check("a file with a NEW violation over baseline fails the gate", code, 1)
    check("... and names the file in the failure output", "js/widget.js" in out, True)

    (root / "js" / "widget.js").write_text(
        "await supabase.from('claims').update({a: 1}).eq('id', x).select('id');\n"
    )
    code, out = run_main_against(root, {"js/widget.js": 1})
    check("a file that DROPS below its baseline (fixed) still passes", code, 0)
    check("... and is reported as IMPROVED", "IMPROVED" in out, True)

if failures:
    print(f"\n{len(failures)} assertion(s) failed")
    sys.exit(1)
print("\nall assertions passed")
