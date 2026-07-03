# /locations Programmatic SEO — Scheduling Workflow (ready to add)

Task 86e1h5hty. The generator `tools/generate_location_pages.py` is scheduled
the same way `tools/generate_contractor_pages.py` is: a nightly GitHub Actions
run that regenerates pages and commits any changes.

## Why this YAML is documented here instead of committed to `.github/workflows/`

The automation session that authored this pipeline pushes with a PAT that
lacks the `workflow` scope, so it cannot create or modify files under
`.github/workflows/` (GitHub rejects the push). The workflow below is
ready to paste into `.github/workflows/generate-location-pages.yml` by
anyone with a workflow-scoped token (or via the GitHub web UI editor,
which is the fastest path).

## Ready-to-add workflow

Create `.github/workflows/generate-location-pages.yml` with exactly:

```yaml
name: Generate Location SEO Pages

on:
  schedule:
    - cron: '30 2 * * *'  # nightly at 2:30 AM UTC (offset from contractor pages at 2:00)
  workflow_dispatch:       # allow manual trigger from Actions UI

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'

jobs:
  generate:
    name: Generate Location Pages
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write  # required to push generated files back to repo

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Generate location pages
        env:
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: python3 tools/generate_location_pages.py

      - name: Commit generated pages
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add otterquote-deploy/locations/ otterquote-deploy/sitemap.xml 2>/dev/null || true
          if git diff --staged --quiet; then
            echo "No changes to commit — pages are up to date."
          else
            git commit -m "chore(seo): regenerate location SEO pages [skip ci]"
            git push
          fi
```

Notes:

- Uses the same `SUPABASE_SERVICE_ROLE_KEY` repository secret the contractor
  workflow already relies on — no new secrets required.
- The nightly regeneration is what makes the auto-noindex guardrail live:
  if a (county, trade) tuple drops below 2 approved contractors, the next
  run keeps the page but injects `<meta name="robots" content="noindex">`
  and removes the URL from `otterquote-deploy/sitemap.xml`.
- The 2-contractor eligibility minimum (`MIN_CONTRACTORS` in the script) is
  a hard D-241 guardrail — do not lower it.
