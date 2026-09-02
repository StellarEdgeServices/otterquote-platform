#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/credential-sweep.py (gh-1528).

Covers the three blind-spot closures gh-1528 asked for:
  1. --paths mode -- secret-by-convention filename enumeration, independent
     of content shape.
  2. --stores mode -- Doppler otterquote/prd field NAME/VALUE shape-mismatch
     audit, with the secret-discipline invariant that no value (or any
     prefix of one) is ever printed.
  3. Checkpointing -- a directory-granularity resume mechanism so a process
     kill loses at most one directory of progress.

No network access and no real credentials required -- every Doppler-API-
adjacent path is exercised by monkeypatching urllib.request's `urlopen` so
it never leaves this machine, following the importlib-load pattern this repo
already uses for hyphenated script filenames in
scripts/drift-detector-age.test.py and scripts/edge-function-drift-check.test.py.
Every fixture value below is an OBVIOUSLY FAKE placeholder -- never a real
secret shape lifted from a live store.

Run: python credential-sweep.test.py
"""

import importlib.util
import io
import json
import pathlib
import shutil
import sys
import tempfile
import urllib.error

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("sweep", HERE / "credential-sweep.py")
sweep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sweep)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def check_true(label, cond):
    check(label, bool(cond), True)


def check_false(label, cond):
    check(label, bool(cond), False)


class _FakeResponse:
    """Minimal context-manager stand-in for urllib.request.urlopen's return value."""

    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def main():
    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="credsweep-test-"))
    try:
        run_all(tmp_root)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("credential-sweep: all assertions passed.")
    return 0


def run_all(tmp_root: pathlib.Path):
    # -------------------------------------------------------------------------------
    print("--paths mode: path_matches_convention against the eight glob classes")
    # -------------------------------------------------------------------------------
    positives = [
        ".env", ".env.local", ".env.production",
        "server.pem", "id_rsa.pem",
        "server.key", "private.key",
        "my-credentials-backup.json", ".backup-credentials",
        "client_secret.json", "secrets.yaml",
        "access-token-cache.json", "TOKEN.JSON",
        "client-cert.p12",
        "id_rsa", "id_rsa.pub", "id_rsa_old",
    ]
    for fname in positives:
        check_true(f"path_matches_convention({fname!r}) -> True", sweep.path_matches_convention(fname))

    negatives = [
        "README.md", "index.ts", "schema-secret-lint.py",  # "secret" substring but has .py ext, still matches *secret* actually
        "package.json", "config.js", "notes.txt",
    ]
    # schema-secret-lint.py DOES match *secret* by design (path mode is
    # content-blind and glob-only) -- verify that explicitly instead of
    # asserting it as a negative.
    check_true(
        "path_matches_convention('schema-secret-lint.py') -> True (glob-only, no content awareness)",
        sweep.path_matches_convention("schema-secret-lint.py"),
    )
    for fname in ("README.md", "index.ts", "package.json", "config.js", "notes.txt"):
        check_false(f"path_matches_convention({fname!r}) -> False", sweep.path_matches_convention(fname))

    # -------------------------------------------------------------------------------
    print("\n--paths mode: --paths listing a secret-by-convention file regardless of content shape")
    # -------------------------------------------------------------------------------
    # Reconstructs gh-1528's motivating example: an archived .env with several
    # plaintext creds that the shape scan mostly cannot see, but whose PATH
    # alone is a finding. Every value below is an obviously fake placeholder.
    demo_root = tmp_root / "paths-demo"
    otterquote_v2 = demo_root / "OtterQuote-v2"
    otterquote_v2.mkdir(parents=True)
    # Every KEY/VALUE pair is built from separate short pieces, joined at
    # runtime, rather than a single "KEY=value" literal -- so the SOURCE of
    # this test file never contains a contiguous secret-shaped or
    # password-assignment-shaped run for a secret scanner (GitHub push
    # protection, GitGuardian, or credential-sweep.py's own source-level
    # shape scan of this repo) to trip on. The joined runtime VALUE still
    # exercises scan_file()'s regex correctly below, which is the thing
    # actually under test. Every piece is an obviously-fake placeholder,
    # never real key material.
    fake_stripe_shaped_value = "sk_live_" + "FAKETESTKEYDONOTUSE1234567890"
    demo_env_pairs = [
        ("DB_" + "PASSWORD", "fake-plaintext-pw-not-real"),
        ("ADMIN_" + "PASSWORD", "fake-correcthorsebatterystaple"),
        ("API_SECRET", "fakeshort1"),
        ("SESSION_SECRET", "fake-plaintext-session-value"),
        ("STRIPE_TEST_KEY", fake_stripe_shaped_value),
    ]
    demo_env_content = "".join(k + "=" + v + "\n" for k, v in demo_env_pairs)
    (otterquote_v2 / ".env").write_text(demo_env_content, encoding="utf-8")

    shape_allowlist = sweep.Allowlist()
    shape_findings = []
    scanned = 0
    rel = ".env"
    src = (otterquote_v2 / ".env").read_text(encoding="utf-8")
    sweep.scan_file("OtterQuote-v2/.env", src, shape_allowlist, shape_findings)
    check(
        "shape scan on the reconstructed archive flags only the shape-matching line "
        "(1 of 5 real creds, same under-detection gh-1528 was filed over)",
        len(shape_findings), 1,
    )

    paths_checkpoint = sweep.Checkpoint(demo_root / ".checkpoint.json", "test-sig")
    path_findings, path_files_scanned = sweep.run_paths_mode(demo_root, paths_checkpoint)
    check("path mode flags exactly one file (the .env itself)", len(path_findings), 1)
    check("path mode's finding is the .env, path is content-blind", path_findings[0]["path"], "OtterQuote-v2/.env")
    check_true("path mode records a byte size", isinstance(path_findings[0]["bytes"], int) and path_findings[0]["bytes"] > 0)
    check_true("path mode records an mtime string", isinstance(path_findings[0]["mtime"], str))

    # -------------------------------------------------------------------------------
    print("\ngitignore_coverage: best-effort True/False via git check-ignore, never raises")
    # -------------------------------------------------------------------------------
    # No git repo here -- must degrade to False for every path, not crash and
    # not silently suppress the finding.
    coverage = sweep.gitignore_coverage(demo_root, ["OtterQuote-v2/.env"])
    check("gitignore_coverage outside a git repo degrades to False, not a crash", coverage.get("OtterQuote-v2/.env"), False)
    check("gitignore_coverage on an empty path list returns {}", sweep.gitignore_coverage(demo_root, []), {})

    # -------------------------------------------------------------------------------
    print("\n--stores mode: classify_field_name (SECRET_LIKE wins ties; UNCLASSIFIED for neither)")
    # -------------------------------------------------------------------------------
    check("classify_field_name('STRIPE_API_KEY')", sweep.classify_field_name("STRIPE_API_KEY"), "SECRET_LIKE_NAME")
    check("classify_field_name('HOVER_CLIENT_ID')", sweep.classify_field_name("HOVER_CLIENT_ID"), "ID_URL_EMAIL_LIKE_NAME")
    check("classify_field_name('WEBHOOK_URL')", sweep.classify_field_name("WEBHOOK_URL"), "ID_URL_EMAIL_LIKE_NAME")
    check("classify_field_name('SUPPORT_EMAIL')", sweep.classify_field_name("SUPPORT_EMAIL"), "ID_URL_EMAIL_LIKE_NAME")
    check("classify_field_name('MAX_RETRY_COUNT') -> UNCLASSIFIED_NAME", sweep.classify_field_name("MAX_RETRY_COUNT"), "UNCLASSIFIED_NAME")
    check(
        "classify_field_name('SECRET_ID') -> SECRET_LIKE wins the tie (both token lists hit)",
        sweep.classify_field_name("SECRET_ID"), "SECRET_LIKE_NAME",
    )

    # -------------------------------------------------------------------------------
    print("\n--stores mode: classify_value_shape across every shape class")
    # -------------------------------------------------------------------------------
    check("classify_value_shape('') -> EMPTY", sweep.classify_value_shape(""), "EMPTY")
    check("classify_value_shape('   ') -> EMPTY", sweep.classify_value_shape("   "), "EMPTY")
    check(
        "classify_value_shape(PEM block) -> PRIVATE_KEY_PEM",
        sweep.classify_value_shape("-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END PRIVATE KEY-----"),
        "PRIVATE_KEY_PEM",
    )
    check(
        "classify_value_shape(JSON blob) -> JSON_BLOB",
        sweep.classify_value_shape('{"type": "service_account", "note": "fake-fixture"}'),
        "JSON_BLOB",
    )
    # Built from three separately-declared segments joined at runtime, not a
    # single contiguous literal -- same rationale as the Stripe-shaped and
    # password-shaped fixtures above: no full 3-segment JWT-shaped run
    # appears anywhere in this file's committed source for a secret scanner
    # to trip on, while the joined runtime value still exercises the JWT
    # regex correctly. A synthetic fixture, never a real token.
    _fake_jwt_header = "eyJhbGciOiJIUzI1NiIs" + "InR5cCI6IkpXVCJ9"
    _fake_jwt_payload = "eyJmYWtl" + "Ijp0cnVlfQ"
    _fake_jwt_signature = "fake" * 6
    fake_jwt_shaped_value = _fake_jwt_header + "." + _fake_jwt_payload + "." + _fake_jwt_signature
    check(
        "classify_value_shape(JWT-shaped) -> JWT_SHAPED",
        sweep.classify_value_shape(fake_jwt_shaped_value),
        "JWT_SHAPED",
    )
    check("classify_value_shape(url) -> URL_LIKE", sweep.classify_value_shape("https://example.com/webhook"), "URL_LIKE")
    check("classify_value_shape(email) -> EMAIL_LIKE", sweep.classify_value_shape("ops@example.com"), "EMAIL_LIKE")
    check(
        "classify_value_shape(uuid) -> UUID_LIKE",
        sweep.classify_value_shape("123e4567-e89b-12d3-a456-426614174000"),
        "UUID_LIKE",
    )
    check(
        "classify_value_shape(short plain word) -> SHORT_LOW_ENTROPY",
        sweep.classify_value_shape("hoverclientname"),
        "SHORT_LOW_ENTROPY",
    )
    check(
        "classify_value_shape(declared 36-char sorted alphabet) -> GENERIC_BASE64_HIGH_ENTROPY: "
        "this is the SAME known false positive credential-sweep-allowlist.txt documents needing "
        "a value: entry for (entropy log2(36)~=5.17 bits/char clears the 4.7 threshold even though "
        "it's a declared alphabet, not a secret) -- --stores mode has no equivalent allowlist, so "
        "this consistency is expected, not a bug",
        sweep.classify_value_shape("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
        "GENERIC_BASE64_HIGH_ENTROPY",
    )
    check_true(
        "classify_value_shape(40 fake hex chars) -> HEX_RUN_20 (a secret-shaped class)",
        sweep.classify_value_shape("deadbeef" * 5) == "HEX_RUN_20",
    )

    # -------------------------------------------------------------------------------
    print("\n--stores mode: stores_mismatches -- both mismatch directions, non-mismatches excluded")
    # -------------------------------------------------------------------------------
    fake_secrets = {
        # Direction 1: benign-looking name, secret-shaped value (dangerous — a
        # real secret hiding under an innocuous name; gh-1528's motivating
        # #1388 GA4-key-mislabelling case).
        "GA4_SERVICE_ACCOUNT_JSON": "-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END PRIVATE KEY-----",
        # Direction 2: secret-looking name, benign-shaped value.
        "SOME_API_KEY": "https://example.com/not-a-secret",
        # Correctly labelled secret -- must NOT be flagged (only a NAME/VALUE
        # shape disagreement is a finding, not "has a secret" by itself).
        "STRIPE_API_KEY": "sk_live_" + ("A" * 30),
        # Correctly labelled non-secret -- must NOT be flagged.
        "SUPPORT_EMAIL": "ops@example.com",
        # UNCLASSIFIED_NAME -- must NOT be flagged either way.
        "MAX_RETRY_COUNT": "5",
    }
    mismatches = sweep.stores_mismatches(fake_secrets)
    by_field = {m["field"]: m for m in mismatches}
    check("stores_mismatches finds exactly 2 mismatches", len(mismatches), 2)
    check(
        "GA4_SERVICE_ACCOUNT_JSON direction",
        by_field.get("GA4_SERVICE_ACCOUNT_JSON", {}).get("direction"),
        "NAME_LOOKS_BENIGN_VALUE_LOOKS_SECRET",
    )
    check(
        "SOME_API_KEY direction",
        by_field.get("SOME_API_KEY", {}).get("direction"),
        "NAME_LOOKS_SECRET_VALUE_LOOKS_BENIGN",
    )
    check_false("correctly-labelled secret STRIPE_API_KEY is not flagged", "STRIPE_API_KEY" in by_field)
    check_false("correctly-labelled non-secret SUPPORT_EMAIL is not flagged", "SUPPORT_EMAIL" in by_field)
    check_false("UNCLASSIFIED_NAME field is never flagged either way", "MAX_RETRY_COUNT" in by_field)
    for m in mismatches:
        check_true(f"finding for {m['field']} carries a length, not a value", "length" in m and "value" not in m)

    # -------------------------------------------------------------------------------
    print("\n--stores mode: fetch_doppler_secrets -- UNMEASURED paths never raise, never fake FRESH")
    # -------------------------------------------------------------------------------
    secrets, reason = sweep.fetch_doppler_secrets(token=None)
    check("fetch with token=None -> secrets is None", secrets, None)
    check_true("fetch with token=None -> reason mentions the missing token env var", "OTTERQUOTE_PRD_TOKEN" in reason)

    real_urlopen = sweep.urllib.request.urlopen

    def _raise_network_error(req, timeout=20):
        raise urllib.error.URLError("[Errno -2] Name or service not known")

    sweep.urllib.request.urlopen = _raise_network_error
    try:
        secrets, reason = sweep.fetch_doppler_secrets(token="fake-token-not-real")
        check("fetch with unreachable API -> secrets is None", secrets, None)
        check_true("fetch with unreachable API -> reason names the failure", "URLError" in reason or "Name or service" in reason)
    finally:
        sweep.urllib.request.urlopen = real_urlopen

    def _raise_http_401(req, timeout=20):
        raise urllib.error.HTTPError(url="https://api.doppler.com/x", code=401, msg="Unauthorized", hdrs=None, fp=None)

    sweep.urllib.request.urlopen = _raise_http_401
    try:
        secrets, reason = sweep.fetch_doppler_secrets(token="fake-token-not-real")
        check("fetch with HTTP 401 -> secrets is None", secrets, None)
        check_true("fetch with HTTP 401 -> reason names the status code", "401" in reason)
    finally:
        sweep.urllib.request.urlopen = real_urlopen

    def _empty_secrets(req, timeout=20):
        body = json.dumps({"secrets": {}}).encode("utf-8")
        return _FakeResponse(body)

    sweep.urllib.request.urlopen = _empty_secrets
    try:
        secrets, reason = sweep.fetch_doppler_secrets(token="fake-token-not-real")
        check("fetch with zero secrets -> secrets is None (UNMEASURED, not an empty pass)", secrets, None)
        check_true("fetch with zero secrets -> reason says so", "zero secrets" in reason)
    finally:
        sweep.urllib.request.urlopen = real_urlopen

    def _doppler_style_response(req, timeout=20):
        # Mirrors Doppler v3's actual {"secrets": {NAME: {"raw": ..., "computed": ...}}}
        # shape. Every value below is an obviously fake fixture.
        body = json.dumps({
            "secrets": {
                "GA4_SERVICE_ACCOUNT_JSON": {
                    "raw": "-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END PRIVATE KEY-----",
                    "computed": "-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END PRIVATE KEY-----",
                },
                "SUPPORT_EMAIL": {"raw": "ops@example.com", "computed": "ops@example.com"},
            }
        }).encode("utf-8")
        return _FakeResponse(body)

    sweep.urllib.request.urlopen = _doppler_style_response
    try:
        secrets, reason = sweep.fetch_doppler_secrets(token="fake-token-not-real")
        check_true("fetch with a real response -> secrets is a dict", isinstance(secrets, dict))
        check("fetch extracts the 'raw' field per secret", secrets.get("SUPPORT_EMAIL"), "ops@example.com")
        check_true("fetch reason names the field count", "2 field" in reason)
    finally:
        sweep.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\nrun_stores_mode: end-to-end, and NO VALUE ever appears in printed output")
    # -------------------------------------------------------------------------------
    secret_canary = "-----BEGIN PRIVATE KEY-----FAKECANARYVALUE-----END PRIVATE KEY-----"
    email_canary = "ops@example.com"

    def _canary_response(req, timeout=20):
        body = json.dumps({
            "secrets": {
                "GA4_SERVICE_ACCOUNT_JSON": {"raw": secret_canary},
                "SUPPORT_EMAIL": {"raw": email_canary},
            }
        }).encode("utf-8")
        return _FakeResponse(body)

    real_stdout = sys.stdout
    sweep.urllib.request.urlopen = _canary_response
    sweep.os.environ["OTTERQUOTE_PRD_TOKEN"] = "fake-token-not-real"
    captured = io.StringIO()
    sys.stdout = captured
    try:
        code = sweep.run_stores_mode()
    finally:
        sys.stdout = real_stdout
        sweep.urllib.request.urlopen = real_urlopen
        sweep.os.environ.pop("OTTERQUOTE_PRD_TOKEN", None)

    output = captured.getvalue()
    check("run_stores_mode exit code is 2 (a mismatch was found)", code, 2)
    check_true("run_stores_mode output names the mismatched field", "GA4_SERVICE_ACCOUNT_JSON" in output)
    check_false("run_stores_mode output NEVER contains the secret value", secret_canary in output)
    check_false("run_stores_mode output NEVER contains even a fragment of the secret value", "FAKECANARYVALUE" in output)
    check_true("run_stores_mode output carries VALUE REDACTED", "VALUE REDACTED" in output)

    # -------------------------------------------------------------------------------
    print("\nCheckpoint: load_or_new, signature mismatch, mark_dir_done round-trip, clear")
    # -------------------------------------------------------------------------------
    ckpt_path = tmp_root / "ckpt.json"
    cp = sweep.Checkpoint.load_or_new(ckpt_path, "sig-a")
    check("fresh checkpoint (no file yet) -> resumed_dirs is 0", cp.resumed_dirs, 0)
    check("fresh checkpoint -> completed_dirs is empty", len(cp.completed_dirs), 0)

    cp.mark_dir_done("dirA", [{"file": "dirA/x", "line": 1, "class": "HEX_RUN_20", "length": 20}], 3)
    check_true("checkpoint file exists on disk after mark_dir_done", ckpt_path.exists())

    cp2 = sweep.Checkpoint.load_or_new(ckpt_path, "sig-a")
    check("reloaded checkpoint (same signature) -> resumed_dirs reflects prior progress", cp2.resumed_dirs, 1)
    check("reloaded checkpoint -> is_done('dirA') True", cp2.is_done("dirA"), True)
    check("reloaded checkpoint -> is_done('dirB') False (never marked)", cp2.is_done("dirB"), False)
    check("reloaded checkpoint -> files_scanned carried over", cp2.files_scanned, 3)
    check("reloaded checkpoint -> findings carried over", len(cp2.findings), 1)

    cp3 = sweep.Checkpoint.load_or_new(ckpt_path, "sig-b-different")
    check(
        "a DIFFERENT signature (e.g. allowlist edited) discards the old checkpoint, starts clean",
        cp3.resumed_dirs, 0,
    )

    cp2.clear()
    check_false("clear() removes the checkpoint file", ckpt_path.exists())
    cp4 = sweep.Checkpoint.load_or_new(ckpt_path, "sig-a")
    check("clear() on a missing file is a no-op, never raises; reload after clear is fresh", cp4.resumed_dirs, 0)
    # clear() itself must also never raise when the file is already gone.
    cp4.clear()

    # -------------------------------------------------------------------------------
    print("\ncompute_signature: changes with mode, root, and allowlist content")
    # -------------------------------------------------------------------------------
    al_a = tmp_root / "allow-a.txt"
    al_b = tmp_root / "allow-b.txt"
    al_a.write_text("path:*.lock\n", encoding="utf-8")
    al_b.write_text("path:*.lock\npath:*.log\n", encoding="utf-8")

    sig1 = sweep.compute_signature("shape", tmp_root, al_a)
    sig2 = sweep.compute_signature("paths", tmp_root, al_a)
    sig3 = sweep.compute_signature("shape", tmp_root / "other-root", al_a)
    sig4 = sweep.compute_signature("shape", tmp_root, al_b)
    sig5 = sweep.compute_signature("shape", tmp_root, al_a)
    check_false("signature differs when mode differs", sig1 == sig2)
    check_false("signature differs when root differs", sig1 == sig3)
    check_false("signature differs when allowlist content differs", sig1 == sig4)
    check("signature is stable for identical (mode, root, allowlist content)", sig5, sig1)

    # -------------------------------------------------------------------------------
    print("\nCheckpointing end-to-end: kill-and-resume simulation on a real directory walk")
    # -------------------------------------------------------------------------------
    # Two subdirectories, each with one distinct shape-matching fixture value
    # (fake, obviously not real credentials).
    walk_root = tmp_root / "walk-demo"
    dir_a = walk_root / "a"
    dir_b = walk_root / "b"
    dir_a.mkdir(parents=True)
    dir_b.mkdir(parents=True)
    (dir_a / "one.txt").write_text("fake_hex=" + ("deadbeef" * 3), encoding="utf-8")  # HEX_RUN_20, 24 chars
    (dir_b / "two.txt").write_text("fake_hex=" + ("cafebabe" * 3), encoding="utf-8")  # HEX_RUN_20, 24 chars

    allowlist_empty = sweep.Allowlist()
    ckpt_path2 = tmp_root / "walk-ckpt.json"
    sig = sweep.compute_signature("shape", walk_root, tmp_root / "no-such-allowlist.txt")

    fresh_cp = sweep.Checkpoint.load_or_new(ckpt_path2, sig)
    full_findings, full_files = sweep.run_shape_scan(walk_root, allowlist_empty, fresh_cp)
    check("clean full walk finds both fixture values", len(full_findings), 2)
    check("clean full walk scans both files", full_files, 2)
    fresh_cp.clear()

    # Simulate a kill AFTER directory 'a' finished but BEFORE 'b' started: seed
    # a checkpoint as if mark_dir_done("a", ...) had already run and persisted,
    # exactly what gh-1528's per-directory persistence guarantees survives a
    # kill -- then load it fresh (a new process, same signature) and resume.
    seed_cp = sweep.Checkpoint(ckpt_path2, sig)
    seed_cp.mark_dir_done("a", [{"file": "a/one.txt", "line": 1, "class": "HEX_RUN_20", "length": 24}], 1)

    resumed_cp = sweep.Checkpoint.load_or_new(ckpt_path2, sig)
    check("resumed checkpoint reports 1 directory already completed (N > 0)", resumed_cp.resumed_dirs, 1)

    resumed_findings, resumed_files = sweep.run_shape_scan(walk_root, allowlist_empty, resumed_cp)
    check(
        "resume does not re-scan directory 'a' -- its finding came from the checkpoint, "
        "'b' was scanned fresh, total is still both fixtures",
        len(resumed_findings), 2,
    )
    check("resume's total file count combines seeded + freshly-scanned", resumed_files, 2)
    resumed_cp.clear()
    check_false("checkpoint file is gone after clear()", ckpt_path2.exists())


if __name__ == "__main__":
    sys.exit(main())
