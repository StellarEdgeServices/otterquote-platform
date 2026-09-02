"""live_charge_guard_parity_check - assert the three #1467 guard copies are identical.

WHY THIS EXISTS. `live-charge-guard.ts` is a money predicate and it exists in
THREE copies, one per Edge Function that can charge a platform fee. That is not
a style choice: the Supabase deploy pipeline does not resolve `_shared/` imports
(see supabase/functions/notify-partner-w9/index.ts:69), so a shared module is
not available to these functions.

Three copies of a money predicate that can drift is a hazard in its own right --
the failure mode is one gate quietly disagreeing with the other two, which is
indistinguishable from no gate at all on the path that drifted. This script is
the mechanism that makes drift loud (R-148: a fix ships as a mechanism, not a
rule).

CANONICAL COPY: supabase/functions/docusign-webhook/live-charge-guard.ts
Edit that one, copy it over the others, re-run this.

Exit 0 = identical. Exit 1 = drift, with the differing paths named.

CI WIRING: not yet wired into .github/workflows -- no credential in this
company can edit a workflow file (gh-1461). Until that lands, this runs from
the CTO's every-run sweeps. Stated rather than implied.
"""
from __future__ import annotations

import hashlib
import pathlib
import sys

CANONICAL = "supabase/functions/docusign-webhook/live-charge-guard.ts"
COPIES = [
    "supabase/functions/create-payment-intent/live-charge-guard.ts",
    "supabase/functions/process-dunning/live-charge-guard.ts",
]


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    root = pathlib.Path(__file__).resolve().parent.parent
    canonical = root / CANONICAL
    if not canonical.is_file():
        print(f"FAIL: canonical guard missing at {CANONICAL}")
        return 1
    want = sha256(canonical)
    print(f"canonical {CANONICAL}\n          sha256 {want}")

    drift = []
    for rel in COPIES:
        p = root / rel
        if not p.is_file():
            print(f"  MISSING  {rel}")
            drift.append(rel)
            continue
        got = sha256(p)
        mark = "ok " if got == want else "DRIFT"
        print(f"  {mark}      {rel}  sha256 {got}")
        if got != want:
            drift.append(rel)

    if drift:
        print(f"\nFAIL: {len(drift)} copy/copies differ from the canonical guard: {', '.join(drift)}")
        print("Fix: copy the canonical file over each one, then re-run.")
        return 1
    print(f"\nOK: {len(COPIES)} copies identical to the canonical guard.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
