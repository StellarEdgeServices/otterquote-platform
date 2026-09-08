#!/usr/bin/env python3
"""
NEGATIVE CONTROL -- gh-1841 RED/GREEN demonstration seed. DO NOT MERGE.

This file exists ONLY to deliberately trip
scripts/detector-negative-control-check.py's CHECK 1 ("detector-shaped
script has NO self-test and is not in LEGACY_EXEMPT") so the Detector
Negative Control Gate can be observed turning RED on exactly the shape
named in gh-1841's closes-on -- "a deliberately-added detector-shaped
scripts/*.py carrying no self-test" -- and then GREEN once this file is
removed on the same branch/PR.

This is a deliberate, labeled negative control, not a real defect. It is
removed by a follow-up commit on this same branch before the PR is closed.
If you are reading this in a merged tree, something went wrong -- delete
this file; it should never reach main.
"""


def main():
    print("gh-1841 negative control seed -- not a real detector, do not merge")


if __name__ == "__main__":
    main()
