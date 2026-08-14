#!/usr/bin/env python3
"""
Stage 5 prevention for the cookie-storage/config.js load-order cluster (#601, 2026-08-06).

`js/config.js` synchronously reads `window.OtterQuoteCookieStorage` to build the
Supabase client:

    sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON,
      { auth: { storage: window.OtterQuoteCookieStorage } });

If `js/cookie-storage.js` hasn't run yet, `storage` is `undefined` and Supabase
silently falls back to plain localStorage -- breaking D-212 cross-subdomain
cookie SSO and PKCE code-verifier lookups. This defect shipped on 9 pages for
seven weeks (aec4253, 2026-06-17) before a Forge sweep caught it on
2026-08-02 -- this script exists so the next instance is a CI failure on the
introducing PR, not a weeks-later Forge finding.

Every HTML file that loads `js/config.js` must:
  1. Also load `js/cookie-storage.js` (config.js has no cookie-storage-free use).
  2. Load `js/cookie-storage.js` strictly before the FIRST `js/config.js` load.
  3. Load `js/config.js` exactly once (a duplicate load races a second,
     differently-configured Supabase client into existence even when the
     duplicate itself is correctly ordered).

Exit codes:
  0 -- no violations
  1 -- one or more violations
"""
from __future__ import annotations
import pathlib, re, sys

REPO = pathlib.Path(__file__).resolve().parent.parent
COOKIE_STORAGE_RE = re.compile(r'src=["\']js/cookie-storage\.js["\']')
CONFIG_RE = re.compile(r'src=["\']js/config\.js["\']')

def check_file(path: pathlib.Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    cookie_storage_lines = [i + 1 for i, l in enumerate(lines) if COOKIE_STORAGE_RE.search(l)]
    config_lines = [i + 1 for i, l in enumerate(lines) if CONFIG_RE.search(l)]

    if not config_lines:
        return []  # page doesn't use config.js / the Supabase client at all

    errors: list[str] = []

    if not cookie_storage_lines:
        errors.append(
            f"loads js/config.js (line {config_lines[0]}) but never loads js/cookie-storage.js -- "
            f"Supabase client will be constructed with storage:undefined"
        )
        return errors

    if len(config_lines) > 1:
        errors.append(
            f"loads js/config.js {len(config_lines)} times (lines {config_lines}) -- "
            f"remove the duplicate; a second createClient() call races a second, "
            f"possibly differently-configured Supabase client into existence"
        )

    if cookie_storage_lines[0] > config_lines[0]:
        errors.append(
            f"js/config.js (line {config_lines[0]}) loads before js/cookie-storage.js "
            f"(first at line {cookie_storage_lines[0]}) -- move cookie-storage.js earlier"
        )

    return errors

def main() -> int:
    failures = 0
    files_scanned = 0
    for path in sorted(REPO.glob("*.html")):
        files_scanned += 1
        errors = check_file(path)
        if not errors:
            continue
        failures += 1
        print(f"FAIL: {path.name}")
        for err in errors:
            print(f"  {err}")

    if failures:
        print()
        print(f"{failures} HTML file(s) have cookie-storage.js/config.js load-order violations.")
        print("Reference: #601 (login.html, get-started.html + 7 partner/ref pages fixed in the "
              "#601/#602/#643/#504 P0 batch, 2026-08-06).")
        return 1

    print(f"check-script-load-order: {files_scanned} HTML files scanned, no violations.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
