#!/usr/bin/env python3
"""gh-3005: fixtures for scripts/check-payout-timing-copy-drift.py.

Run: python3 scripts/check-payout-timing-copy-drift.test.py
Proves (1) the Sullivan County TN permit-expiry sentence is exempt, and
(2) real payout-timing sentences (and the same sentence on any other file)
still FAIL. The shared keyword/duration patterns are not touched.
"""
import importlib.util
import pathlib
import sys
import unittest

_p = pathlib.Path(__file__).resolve().parent / "check-payout-timing-copy-drift.py"
_spec = importlib.util.spec_from_file_location("payout_guard", _p)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

SULLIVAN = "locations/sullivan-county-tn/roofing/index.html"
PERMIT_LINE = (
    "<p>It also records that county commissioners &quot;adopted the 2018 "
    "International Residential Code&quot;. The permit, &quot;IF NOT EXERCISED, "
    "EXPIRES 180 DAYS FROM ISSUANCE AND/OR BETWEEN INSPECTIONS&quot;, and ...</p>"
)


class PayoutGuard(unittest.TestCase):
    def test_permit_sentence_raw_pattern_matches(self):
        # Fixture sanity: without the allowlist this line IS a false positive.
        self.assertTrue(guard.COMMISSION_KEYWORDS.search(PERMIT_LINE))
        self.assertTrue(guard.DURATION_RE.search(PERMIT_LINE))

    def test_permit_sentence_passes_on_sullivan_page(self):
        self.assertFalse(guard.is_flagged(SULLIVAN, PERMIT_LINE))

    def test_permit_sentence_still_fails_on_other_file(self):
        self.assertTrue(guard.is_flagged("locations/other-county-tn/roofing/index.html", PERMIT_LINE))

    def test_real_payout_sentence_fails(self):
        self.assertTrue(guard.is_flagged("index.html", "Referral payouts are sent within 30 days"))

    def test_real_payout_sentence_fails_even_on_sullivan_page(self):
        self.assertTrue(guard.is_flagged(SULLIVAN, "<p>Referral payouts are sent within 30 days</p>"))


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
