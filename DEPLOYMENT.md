# OtterQuote Deployment Guide

## Pre-Push Static Analysis Gate

Before any push, run:
```bash
bash scripts/pre-push-check.sh
```

This gate ensures code quality, type safety, and HTML validity before changes reach production. Failures (FAIL count > 0) block the push unless explicitly waived.

### Tools Used

- **biome** (JS linting): `npm install -g @biomejs/biome` — configured via `biome.json`
  - Lints vanilla JavaScript in `assets/js/` and `scripts/`
  - Rules: recommended + strict equals checks + unused variable warnings
  - Currently: no JS files to lint (skipped gracefully)

- **htmlhint** (HTML validation): runs via `npx htmlhint`
  - Validates HTML structure across all `.html` files in root
  - Currently: detects 39 errors in 10 files (pre-existing, documented separately)

- **TypeScript** (Edge Functions): `npx tsc --noEmit` if tsconfig.json present
  - Checks type safety for Supabase Edge Functions
  - Currently: skipped — requires deno/supabase runtime (non-blocking pre-D-211)

### Waiver Process

If a push must proceed despite lint failures, add `[LINT-WAIVER: <reason>]` to the commit message:

```bash
git commit -m "fix: critical hotfix [LINT-WAIVER: pre-existing HTML errors, merged in parallel PR]"
```

The gate will detect the waiver and allow the push. Always document the reason clearly.

### Known Gaps (pre-D-211 React Migration)

- **Dead-code detection**: Currently manual (no `package.json` for depcheck). Will be automated post-D-211.
- **TypeScript check**: Skipped until full Deno/Supabase runtime is integrated.
- **HTML errors**: 39 pre-existing errors in 10 files. Separate remediation task (not blocking this deploy gate).

## Deploy Tiers (D-182)

See `Deploy_Review_Checklist.md` for the full CRITICAL/HIGH/NORMAL gate structure. The static analysis gate runs BEFORE the checklist on every push.

## Base Deploy Steps

Per `claude-memory.md` Base Deploy Steps:
- **Step 5a**: Run `bash scripts/pre-push-check.sh` from repo root. FAIL count > 0 blocks push (waiver via `[LINT-WAIVER: reason]` in commit message).
- **Step 5b**: Proceed to Deploy_Review_Checklist.md.

*Last updated: 2026-05-05*
