#!/usr/bin/env python3
"""
gh-2105 -- ratchet guard for the #2103 defect class: a supabase-js
`.from(t).update({...}).eq(...)` call with no `.select(` chained resolves
`{ error: null }` even when RLS or the filter matches ZERO rows. The caller
sees success and nothing was written. #2103 fixed the first instance
(react-app/app/trade-selector/page.tsx + trade-selector.html); gh-2105 fixed
the bid award/decline flow (react-app/app/(homeowner)/bids/actions.ts). The
repo-wide sweep on gh-2105 found ~217 remaining sites across HTML, js/,
react-app/ and supabase/functions/ that still follow this shape -- most are
legitimate (decision b: a zero-row match is an expected outcome there, e.g.
an idempotent re-send) or belong to a server-side/edge-function path that is
a separate class of review, but none has been individually triaged yet.

Rather than block every PR on that full backlog, this is a RATCHET: each
file gets a baseline violation count (BASELINE below, captured the day this
guard was added). CI fails only when a file's current count exceeds its
baseline -- i.e. a NEW un-annotated `.update(` without `.select(` was added
-- never on the pre-existing backlog. Fixing a site (adding `.select(` or
annotating it, see below) lowers that file's live count below its baseline;
BASELINE is not auto-lowered so the improvement is visible, but it never
causes a failure.

A site that legitimately matches zero rows (decision b in gh-2105/#2103's
own triage, e.g. an idempotent re-send) does not need `.select(` -- it can
instead carry a `update-no-select-ok:` comment on the trigger line or the
line directly above it, documenting why, and is excluded from the count
without touching the ratchet baseline.

Exit codes:
  0 -- no file exceeds its baseline
  1 -- one or more files have MORE un-annotated, un-selected `.update(`
       call sites than their recorded baseline
"""
from __future__ import annotations
import json
import os
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
ROOTS = ["js", "react-app", "supabase/functions"]
EXTS = (".html", ".js", ".ts", ".tsx")
EXCLUDE_DIR_PARTS = ("node_modules", ".next", "__tests__")
ANNOTATION = "update-no-select-ok"

# Baseline violation counts per file, captured 2026-09-25 (gh-2105, CTO RUN
# 39) immediately after fixing react-app/app/(homeowner)/bids/actions.ts
# (bid award/decline -- claims.status='awarded', quotes.status='selected'/
# 'declined'). Paths are relative to the repo root, POSIX-separated.
#
# RE-CAPTURED 2026-09-25 (REVIEW: FAIL on PR #2199, finding B2): the scan
# window's terminator was `";" in lines[j] and j > i`, so a `;` on the
# `.update(` trigger line itself (j == i -- a complete one-line statement)
# did not end the scan. The window then ran on into whatever followed, and
# an unrelated `.select(` on a later statement hid the violation. Fixed in
# find_violations() below (the `j > i` guard removed). Re-running the fixed
# scanner against this same tree reproduces the IDENTICAL 217-site/98-file
# total as the original capture -- no real site in this repo currently has
# the one-line-update-then-unrelated-select shape the bug could hide, so
# BASELINE's numbers below are unchanged; only the scanner's correctness on
# a case the repo does not yet contain has changed.
BASELINE: dict[str, int] = {
    "admin-contractors.html": 1,
    "admin-cpa.html": 2,
    "admin-fee-config.html": 1,
    "admin-measurements.html": 3,
    "admin-referrals.html": 4,
    "admin-template-review.html": 2,
    "bids.html": 2,
    "color-selection.html": 1,
    "contract-signing.html": 2,
    "contractor-auto-bids.html": 1,
    "contractor-bid-form.html": 1,
    "contractor-dashboard.html": 4,
    "contractor-pre-approval.html": 2,
    "contractor-profile.html": 1,
    "contractor-settings.html": 9,
    "dashboard.html": 4,
    "help-estimate.html": 1,
    "help-materials.html": 1,
    "help-measurements.html": 1,
    "js/auth.js": 2,
    "js/contract-template-validation.js": 1,
    "js/services.js": 2,
    "js/video-upload-handler.js": 1,
    "project-confirmation.html": 1,
    "project-info-acv.html": 2,
    "project-info-cash.html": 1,
    "project-info-rcv.html": 2,
    "react-app/app/(homeowner)/bids/actions.ts": 1,
    "react-app/app/(homeowner)/color-selection/use-color-selection-data.ts": 1,
    "react-app/app/(homeowner)/contract-signing/use-contract-signing-data.ts": 2,
    "react-app/app/(homeowner)/dashboard/actions.ts": 3,
    "react-app/app/(homeowner)/help-estimate/actions.ts": 1,
    "react-app/app/(homeowner)/help-materials/use-help-materials-data.ts": 1,
    "react-app/app/(homeowner)/help-measurements/use-help-measurements-data.ts": 1,
    "react-app/app/(homeowner)/project-confirmation/use-project-confirmation-data.ts": 1,
    "react-app/app/(homeowner)/repair-intake/use-repair-intake-data.ts": 2,
    "react-app/app/admin/contractors/page.tsx": 1,
    "react-app/app/admin/fee-config/page.tsx": 1,
    "react-app/app/admin/referrals/page.tsx": 6,
    "react-app/app/admin/referrals/utils.ts": 1,
    "react-app/app/admin/template-review/page.tsx": 2,
    "react-app/app/contractor/auto-bids/page.tsx": 1,
    "react-app/app/contractor/bid/[claimId]/bid-form.tsx": 1,
    "react-app/app/contractor/dashboard/page.tsx": 2,
    "react-app/app/contractor/pre-approval/page.tsx": 2,
    "react-app/app/contractor/profile/ContractTemplates.tsx": 2,
    "react-app/app/contractor/profile/PcTemplates.tsx": 1,
    "react-app/app/contractor/profile/d199-validation.tsx": 1,
    "react-app/app/contractor/settings/StripePaymentMethods.tsx": 7,
    "react-app/app/contractor/settings/page.tsx": 1,
    "react-app/app/contractor/settings/utils.ts": 1,
    "react-app/app/hooks/use-notification-count.ts": 1,
    "react-app/app/lib/partner-record.ts": 1,
    "react-app/app/lib/services.ts": 2,
    "react-app/app/trade-selector/page.tsx": 1,
    "repair-intake.html": 2,
    "supabase/functions/admin-contractor-action/index.ts": 6,
    "supabase/functions/approve-warranty-drift/index.ts": 4,
    "supabase/functions/check-rate-limits/index.ts": 1,
    "supabase/functions/check-siding-design-completion/index.ts": 3,
    "supabase/functions/create-docusign-envelope/index.ts": 7,
    "supabase/functions/create-hover-order/index.ts": 2,
    "supabase/functions/create-payment-intent/index.ts": 2,
    "supabase/functions/create-setup-intent/index.ts": 1,
    # gh-2105 batch 3: fixed all 13 real call sites (see the batch-3 PR body
    # for the full grep enumeration + per-site a/b/c decisions). Lowered
    # 13->0, following batches 1-2's own precedent of lowering a file's
    # baseline in the same PR that fixes it (e.g. stripe-webhook 6->0,
    # verify-payment-method 1->0 in PR #2210). NOTE: the pre-fix live count on
    # `main` was actually 14, not 13 -- a comment at the old line 1770
    # ("the .update() call in error handling...") contained the literal
    # scanner-trigger substring and was a false positive the original
    # baseline capture appears to have missed or hand-adjusted for; that
    # comment is reworded in this same PR to stop tripping the scanner.
    "supabase/functions/docusign-webhook/index.ts": 0,
    "supabase/functions/get-hover-pdf/index.ts": 1,
    "supabase/functions/get-hover-siding-data/index.ts": 1,
    "supabase/functions/hover-webhook/index.ts": 4,
    "supabase/functions/lead-next-step-optout/index.ts": 1,
    "supabase/functions/mark-job-complete/index.ts": 2,
    "supabase/functions/mark-loss-sheet-reviewed/index.ts": 2,
    "supabase/functions/mark-payout-paid/index.ts": 2,
    "supabase/functions/notify-admin-new-homeowner/index.ts": 1,
    "supabase/functions/notify-payout-pending/index.ts": 1,
    "supabase/functions/parse-hover-measurements/index.ts": 1,
    "supabase/functions/parse-loss-sheet/index.ts": 1,
    "supabase/functions/partner-email-optout/index.ts": 1,
    "supabase/functions/platform-health-check/index.ts": 2,
    "supabase/functions/process-bid-expirations/index.ts": 4,
    "supabase/functions/process-coi-reminders/index.ts": 5,
    # gh-2105 batch 3: fixed all 15 real call sites (see the batch-3 PR body
    # for the full grep enumeration + per-site a/b/c decisions). Lowered
    # 15->0, following batches 1-2's precedent (see the docusign-webhook
    # entry above for the same note).
    "supabase/functions/process-dunning/index.ts": 0,
    "supabase/functions/process-hover-rebate/index.ts": 1,
    "supabase/functions/process-payout-reminders/index.ts": 2,
    "supabase/functions/record-attestation/index.ts": 1,
    "supabase/functions/record-warranty-upload/index.ts": 1,
    "supabase/functions/reject-warranty-drift/index.ts": 1,
    "supabase/functions/rescind-bid/index.ts": 1,
    "supabase/functions/resend-hover-link/index.ts": 1,
    "supabase/functions/send-adjuster-email/index.ts": 1,
    "supabase/functions/send-home-profile-prompt/index.ts": 2,
    "supabase/functions/send-incomplete-onboarding-reminders/index.ts": 1,
    "supabase/functions/send-partner-onboarding/index.ts": 3,
    "supabase/functions/stripe-webhook/index.ts": 6,
    "supabase/functions/submit-partner-w9/index.ts": 1,
    "supabase/functions/switch-contractor/index.ts": 4,
    "supabase/functions/validate-contract-template/index.ts": 1,
    "supabase/functions/validate-contract-template/revalidate.ts": 1,
    "supabase/functions/verify-payment-method/index.ts": 1,
}


def iter_candidate_files():
    for name in sorted(os.listdir(REPO)):
        if name.endswith(".html"):
            yield REPO / name
    for base in ROOTS:
        base_path = REPO / base
        if not base_path.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base_path):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIR_PARTS]
            for fn in sorted(filenames):
                if fn.endswith(EXTS):
                    yield pathlib.Path(dirpath) / fn


def find_violations(path: pathlib.Path) -> list[int]:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.split("\n")
    violations: list[int] = []
    for i, line in enumerate(lines):
        if ".update(" not in line:
            continue
        window: list[str] = []
        j = i
        while j < len(lines) and j < i + 25:
            window.append(lines[j])
            # gh-2105 REVIEW FAIL (B2): this used to be `";" in lines[j] and j > i`,
            # which let a `;` on the .update( trigger line itself (j == i) fail to
            # end the scan. A one-line `.update(...).eq(...);` statement then kept
            # extending the window into WHATEVER FOLLOWED, and a `.select(` on a
            # later, unrelated statement hid the violation. The statement's own
            # terminator ends its own scan regardless of which line it is on.
            if ";" in lines[j]:
                break
            if j > i and lines[j].strip() == "":
                break
            j += 1
        joined = "\n".join(window)
        if ".select(" in joined:
            continue
        prior = lines[i - 1] if i > 0 else ""
        if ANNOTATION in joined or ANNOTATION in prior:
            continue
        violations.append(i + 1)
    return violations


def main() -> int:
    if "__tests__" not in EXCLUDE_DIR_PARTS:  # sanity, should never trip
        raise AssertionError("EXCLUDE_DIR_PARTS misconfigured")

    live: dict[str, list[int]] = {}
    for path in iter_candidate_files():
        rel = path.relative_to(REPO).as_posix()
        if "__tests__" in rel or ".test." in rel or rel.endswith(".d.ts"):
            continue
        viols = find_violations(path)
        if viols:
            live[rel] = viols

    failures = 0
    for rel in sorted(set(live) | set(BASELINE)):
        count = len(live.get(rel, []))
        base = BASELINE.get(rel, 0)
        if count > base:
            failures += 1
            print(f"FAIL: {rel} -- {count} un-selected .update() site(s), baseline is {base}")
            for ln in live.get(rel, []):
                print(f"  new/unaccounted-for line: {ln}")
            print(
                "  -> chain `.select('col')` and check the returned row(s), "
                "or add an `update-no-select-ok: <reason>` comment if a "
                "zero-row match is legitimate here (gh-2105 decision b)."
            )
        elif count < base:
            print(f"IMPROVED: {rel} -- {count} live vs baseline {base} (consider lowering BASELINE)")

    total_live = sum(len(v) for v in live.values())
    if failures:
        print()
        print(f"{failures} file(s) exceed their gh-2105 ratchet baseline.")
        print("Reference: react-app/app/(homeowner)/bids/actions.ts fixed in gh-2105 (bid award/decline).")
        return 1

    print(
        f"check-unselected-update-ratchet: {len(live)} file(s) with pre-existing "
        f"sites ({total_live} total), no file exceeds its baseline."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
