# typed-stamp-check.py (mirror)

Version-controlled mirror of `In Flight/bin/typed-stamp-check.py` on the CTO device (R-140 / gh-3250). The device copy is the one
`exec-wrap.py` calls (MARKER-EW-TYPED-STAMP block); this mirror exists so the script has a commit sha. Not run by CI.
Self-test: `python3 scripts/exec-tools/typed-stamp-check.py --self-test` (prints TYPED-STAMP-SUSPECT on the typed-stamp fixture, exit 0 when its four cases behave).
