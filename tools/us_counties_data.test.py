#!/usr/bin/env python3
"""
gh-2433: guard data/us-counties.json, the county source for
tools/generate_location_pages.py (D-345 /locations/ pages).

The file shipped with 28 of 51 states corrupt (TN held "Bruno",
"Brunonianism" x5 -- 14 entries for 95 counties; TX had 10 of 254; KY listed
"Griggs" for "Livingston"). A location page is generated per (county, trade),
so a bad list publishes nonsense pages. This test pins the county count and
uniqueness for every state the plan names (#2423: IN, OH, MO, MI, KY, TN) and
for every other state whose count is stable since 2013.

Data vintage: regenerated from the Census-derived FIPS master list
(kjhealy/fips-codes). AK (29, pre-2019 Valdez-Cordova split) and VA (134,
includes Bedford city, merged 2013) are older than the 2020 Census and are
deliberately not pinned -- regenerate them before either state is allow-listed.

Run: python3 tools/us_counties_data.test.py
"""
import json
import unicodedata
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "us-counties.json"

# County (or county-equivalent) counts, 2020 Census.
EXPECTED = {
    "AL": 67, "AZ": 15, "AR": 75, "CA": 58, "CO": 64, "CT": 8, "DE": 3,
    "DC": 1, "FL": 67, "GA": 159, "HI": 5, "ID": 44, "IL": 102, "IN": 92,
    "IA": 99, "KS": 105, "KY": 120, "LA": 64, "ME": 16, "MD": 24, "MA": 14,
    "MI": 83, "MN": 87, "MS": 82, "MO": 115, "MT": 56, "NE": 93, "NV": 17,
    "NH": 10, "NJ": 21, "NM": 33, "NY": 62, "NC": 100, "ND": 53, "OH": 88,
    "OK": 77, "OR": 36, "PA": 67, "RI": 5, "SC": 46, "SD": 66, "TN": 95,
    "TX": 254, "UT": 29, "VT": 14, "WA": 39, "WV": 55, "WI": 72, "WY": 23,
}
NOT_PINNED = {"AK", "VA"}

failures = []


def check(cond, msg):
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures.append(msg)


states = {s["code"]: s for s in json.loads(DATA.read_text(encoding="utf-8"))["states"]}
check(set(states) == set(EXPECTED) | NOT_PINNED, "every state + DC present, nothing extra")

for code, want in sorted(EXPECTED.items()):
    counties = states.get(code, {}).get("counties", [])
    check(len(counties) == want, f"{code}: {len(counties)} counties (want {want})")
    check(len(set(counties)) == len(counties), f"{code}: no duplicate county names")

for code, s in sorted(states.items()):
    bad = [c for c in s["counties"] if not c or c != c.strip() or c.endswith((" County", " Parish"))]
    check(not bad, f"{code}: names are trimmed, non-empty, without a County/Parish suffix")

for code, s in sorted(states.items()):
    odd = [c for c in s["counties"]
           if unicodedata.normalize("NFC", c) != c or any(unicodedata.combining(ch) for ch in c)]
    check(not odd, f"{code}: no combining marks / non-NFC names (e.g. a mangled 'Doña Ana')")

# Negative controls: the exact corruption this file shipped with must fail.
check("Brunonianism" not in states["TN"]["counties"], "TN: corrupt 'Brunonianism' entry is gone")
check("Livingston" in states["KY"]["counties"] and "Griggs" not in states["KY"]["counties"],
      "KY: 'Livingston' present, bogus 'Griggs' absent")

if failures:
    print(f"\n{len(failures)} check(s) failed.")
    sys.exit(1)
print("\nall checks passed")
