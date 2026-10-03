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
(kjhealy/fips-codes), then brought to 2020 Census names: AK (Valdez-Cordova
split into Chugach + Copper River, 2019; Wade Hampton -> Kusilvak, 2015),
VA (Bedford city merged into Bedford County, 2013), SD (Shannon -> Oglala
Lakota, 2015), LA ("La Salle" -> "LaSalle"). Every state is count-pinned.

The six plan states (#2423: IN, OH, MO, MI, KY, TN) are also NAME-pinned by a
sha256 of their sorted county list, because a count pin cannot catch a
same-count wrong name. Changing one of those lists on purpose means updating
its hash here in the same PR.

Run: python3 tools/us_counties_data.test.py
"""
import hashlib
import json
import unicodedata
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "us-counties.json"

# County (or county-equivalent) counts, 2020 Census.
EXPECTED = {
    "AK": 30, "VA": 133,
    "AL": 67, "AZ": 15, "AR": 75, "CA": 58, "CO": 64, "CT": 8, "DE": 3,
    "DC": 1, "FL": 67, "GA": 159, "HI": 5, "ID": 44, "IL": 102, "IN": 92,
    "IA": 99, "KS": 105, "KY": 120, "LA": 64, "ME": 16, "MD": 24, "MA": 14,
    "MI": 83, "MN": 87, "MS": 82, "MO": 115, "MT": 56, "NE": 93, "NV": 17,
    "NH": 10, "NJ": 21, "NM": 33, "NY": 62, "NC": 100, "ND": 53, "OH": 88,
    "OK": 77, "OR": 36, "PA": 67, "RI": 5, "SC": 46, "SD": 66, "TN": 95,
    "TX": 254, "UT": 29, "VT": 14, "WA": 39, "WV": 55, "WI": 72, "WY": 23,
}
NAME_HASHES = {
    "IN": "19bd9b43693432af50c0ffb2f4491d196d0a645cc83ab5e209a08307c07841f0",
    "OH": "2adc0f3cf23a21837f24f2074469e8c4713a313a67c598192e6118ef27e7bb1e",
    "MO": "ca74b9fcfdd0fce9298e708fe2324b84af50220f85e1947e70b47c331d3e98a6",
    "MI": "be37f0aa55cd93a702fbdb9bc9171e1f20b3809de4273c48670dd3082df0aacb",
    "KY": "f3bff2188e953c13d7543b4c222e1e166406364513e62cca82a746632a644ece",
    "TN": "2abb9019a0200707b6bfd1d29a62fc8f048562b3c756c395092b69ea8df2e3a3",
}

failures = []


def check(cond, msg):
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures.append(msg)


states = {s["code"]: s for s in json.loads(DATA.read_text(encoding="utf-8"))["states"]}
check(set(states) == set(EXPECTED), "every state + DC present, nothing extra")

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

for code, want in sorted(NAME_HASHES.items()):
    got = hashlib.sha256("\n".join(sorted(states[code]["counties"])).encode("utf-8")).hexdigest()
    check(got == want, f"{code}: county names match the pinned list (sha256)")

# Negative controls: the exact corruption this file shipped with must fail.
check("Brunonianism" not in states["TN"]["counties"], "TN: corrupt 'Brunonianism' entry is gone")
check("Livingston" in states["KY"]["counties"] and "Griggs" not in states["KY"]["counties"],
      "KY: 'Livingston' present, bogus 'Griggs' absent")
check("Oglala Lakota" in states["SD"]["counties"] and "Shannon" not in states["SD"]["counties"],
      "SD: 2015 rename to 'Oglala Lakota' applied")

if failures:
    print(f"\n{len(failures)} check(s) failed.")
    sys.exit(1)
print("\nall checks passed")
