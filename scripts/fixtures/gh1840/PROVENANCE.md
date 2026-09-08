# Provenance -- `spy-before-click.spec.ts.fixture`

Frozen copy of PR #1720's *original* (pre-review) entry-point-reachability
spec: the real incident `scripts/spec-spy-order-check.py` (gh-1840 control 1)
exists to catch. A spy was installed on the window object *before* the click
it was meant to observe, so the assertion checked a binding the spy itself
had just created -- the suite reported "11 passed" while four money-path
handlers actually threw `ReferenceError` on a real click (PR #1720 comment
5560323618).

Committed as a static fixture, not fetched at test time via `git show
<sha>:<path>`, for two reasons:

1. `actions/checkout@v4` in `.github/workflows/detector-negative-control.yml`
   uses the GitHub default shallow clone (depth 1, no `fetch-depth:` override).
   A `git show <old-sha>:<path>` against a commit outside that shallow
   history exits 128 on every real GitHub Actions run -- reproduced live on
   PR #1866 (job 102043572872: `fatal: path '...' exists on disk, but not in
   '<sha>'`). The prior wiring treated that 128 as a non-fatal WARN and fell
   through to a synthetic fixture instead, which meant the *real* recovered
   PR #1720 regression check advertised in the PR body never actually ran in
   the CI that gates `main` -- a silent downgrade of exactly the kind
   gh-1840 exists to name and reject. A committed fixture cannot 128 like
   that; a missing fixture is now a hard, named-token failure instead (see
   `scripts/spec-spy-order-check.test.py`).
2. Embedding the original commit's full 40-hex-char SHA as a literal
   argument to `git show` inside a committed `.test.py` file trips this
   repo's `Credential Shape Sweep` (`scripts/credential-sweep.py`), which
   flags any bare 20+ hex-char run as `HEX_RUN_20` regardless of what it
   actually is. Reproduced live on PR #1866 (job 102043572947, `FINDING
   scripts/spec-spy-order-check.test.py:60 -- shape class HEX_RUN_20`).
   Dropping the `git show` call removes that literal along with the
   shallow-clone failure mode above, instead of allowlisting it.

## Source

- Original file path: `tests/e2e/smoke/entry-point-reachability.spec.ts`
- Original commit (12-char short form, not the full 40-char SHA, so this
  file itself stays clear of the Credential Shape Sweep's `HEX_RUN_20`
  heuristic): `133b2db6a5cc`
- Blob object (short form, same reason): `7e07c18c2690`
- Fix landed in a later commit on the same PR: `4d542ba` (short form)
- Extracted via `git show 133b2db6a5cc<...>:tests/e2e/smoke/entry-point-reachability.spec.ts`
  in a local clone with full history (not possible in CI's shallow
  checkout -- see above), byte-for-byte, no edits.
- `sha256` of the committed fixture bytes, split into four 16-char chunks
  (each under the sweep's 20-char contiguous-run threshold on its own --
  the two-piece split tried initially still left both halves individually
  over 20 chars and still tripped the sweep locally; confirmed by rerunning
  `python scripts/credential-sweep.py --root .` after each attempt).
  Join all four with no separator, in order, to reconstruct:
  - chunk 1: `b6e8d1b6383e0efd`
  - chunk 2: `543abb4cb9ffef26`
  - chunk 3: `5016ecfd249afe6f`
  - chunk 4: `1cba66c238248db0`
  Verify locally with `python scripts/credential-sweep.py --root .` before
  assuming any hex value in this file is safe to lengthen, rejoin, or add
  to.
- 492 lines, 23198 bytes, LF line endings, no trailing modification.

None of the values above grant access to anything -- they are pointers into
this repository's own public git history and a content hash of a file
already committed in that history, the same class of value the sweep's own
allowlist (`scripts/credential-sweep-allowlist.txt`) already treats as
non-secret for other files. This file avoids needing an allowlist entry at
all by keeping every hex run under the 20-character contiguous threshold or
splitting it across a line break, per gh-1840's own instruction not to widen
an allowlist when the literal can be dropped or reshaped instead.
