#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/check-mailgun-footer-coverage.py (gh-1824).

gh-1824 PR #2197's independent review (comment 5839071861, finding 2) proved
the first version of this detector false-PASSed on exactly the regression it
claimed to catch: it matched `POSTAL_ADDRESS` or the street text appearing
ANYWHERE in a function's directory, so removing the actual footer call from
the email builder, or blanking the constant's value, both left the guard
green. This test is the negative control that finding demanded, run against
a fixture directory (mod.FUNCTIONS_DIR is monkeypatched, mirroring
scripts/check-credential-claims.py's mod.REPO pattern) so it never touches
the real repo:

  (a) delete the footer call from the email builder -> must FAIL
  (b) blank the POSTAL_ADDRESS constant's value      -> must FAIL
  (c) delete email-footer.ts entirely                -> must FAIL
  (d) restore                                        -> must PASS

A test that only ever fed the detector a compliant fixture would prove
nothing (the exact class this file exists to close); (a)-(c) are the
negative controls, (d) is the confirmation the fixture itself is sound.

Run: python scripts/check-mailgun-footer-coverage.test.py
"""
import contextlib
import importlib.util
import io
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "check_mailgun_footer_coverage", HERE / "check-mailgun-footer-coverage.py"
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


ADDRESS = "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224"

INDEX_TS = f"""
const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
import {{ footerPostalAddressHtml, footerPostalAddressText }} from "./email-footer.ts";

async function sendIt() {{
  await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {{
    method: "POST",
  }});
}}

const html = `<p>Hi</p>${{footerPostalAddressHtml()}}`;
const text = "Hi\\n\\n" + footerPostalAddressText();
"""

INDEX_TS_NO_CALL = f"""
const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
import {{ footerPostalAddressHtml, footerPostalAddressText }} from "./email-footer.ts";

async function sendIt() {{
  await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {{
    method: "POST",
  }});
}}

const html = `<p>Hi</p>`;
const text = "Hi";
"""

EMAIL_FOOTER_TS = f"""
export const POSTAL_ADDRESS: string =
  "{ADDRESS}";

export function footerPostalAddressText(): string {{
  return POSTAL_ADDRESS;
}}

export function footerPostalAddressHtml(): string {{
  if (POSTAL_ADDRESS === "") return "";
  return `<div>${{POSTAL_ADDRESS}}</div>`;
}}
"""

EMAIL_FOOTER_TS_BLANK = """
export const POSTAL_ADDRESS: string = "";

export function footerPostalAddressText(): string {
  return POSTAL_ADDRESS;
}

export function footerPostalAddressHtml(): string {
  if (POSTAL_ADDRESS === "") return "";
  return `<div>${POSTAL_ADDRESS}</div>`;
}
"""


def write_fixture(root, index_ts=INDEX_TS, email_footer_ts=EMAIL_FOOTER_TS):
    fn_dir = root / "fake-sender"
    fn_dir.mkdir(parents=True, exist_ok=True)
    (fn_dir / "index.ts").write_text(index_ts, encoding="utf-8")
    if email_footer_ts is not None:
        (fn_dir / "email-footer.ts").write_text(email_footer_ts, encoding="utf-8")
    else:
        footer_path = fn_dir / "email-footer.ts"
        if footer_path.exists():
            footer_path.unlink()


def run_guard():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = mod.main()
    return code, buf.getvalue()


def main():
    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="mailgun-footer-guard-test-"))
    original_functions_dir = mod.FUNCTIONS_DIR
    original_required = mod.REQUIRED_FOOTER
    try:
        mod.FUNCTIONS_DIR = str(tmp_root)
        mod.REQUIRED_FOOTER = {"fake-sender"}

        print("setup: a compliant fixture function (Mode A -- wrapper + real call)")
        write_fixture(tmp_root)
        code, out = run_guard()
        check("baseline exit code (PASS)", code, 0)
        check(
            "baseline reports PASS banner",
            out.strip().splitlines()[-1].startswith("PASS: check-mailgun-footer-coverage"),
            True,
        )

        print()
        print("(a) negative control: remove the footer call from the email builder")
        write_fixture(tmp_root, index_ts=INDEX_TS_NO_CALL)
        code, out = run_guard()
        check("(a) call-removed exit code (FAIL)", code, 1)
        check("(a) call-removed names fake-sender", "fake-sender" in out, True)

        print()
        print("(b) negative control: blank the POSTAL_ADDRESS constant's value")
        write_fixture(tmp_root, email_footer_ts=EMAIL_FOOTER_TS_BLANK)
        code, out = run_guard()
        check("(b) blanked-constant exit code (FAIL)", code, 1)
        check("(b) blanked-constant names fake-sender", "fake-sender" in out, True)

        print()
        print("(c) negative control: delete email-footer.ts entirely")
        write_fixture(tmp_root, email_footer_ts=EMAIL_FOOTER_TS)  # restore index.ts + footer first
        (tmp_root / "fake-sender" / "email-footer.ts").unlink()
        code, out = run_guard()
        check("(c) deleted-file exit code (FAIL)", code, 1)
        check("(c) deleted-file names fake-sender", "fake-sender" in out, True)

        print()
        print("(d) restore: guard passes again")
        write_fixture(tmp_root)
        code, out = run_guard()
        check("(d) restored exit code (PASS)", code, 0)

    finally:
        mod.FUNCTIONS_DIR = original_functions_dir
        mod.REQUIRED_FOOTER = original_required
        shutil.rmtree(tmp_root, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print(
        "check-mailgun-footer-coverage: all assertions passed (negative controls "
        "(a)/(b)/(c) observed FAILING; baseline and restore observed PASSING)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
