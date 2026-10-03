# /locations Programmatic SEO: Generator Workflow

`tools/generate_location_pages.py` builds static `/locations/[county]/[trade]/`
pages. D-345 (gh-2422) amended D-241 and D-169 for these pages. This file
describes how the generator behaves now and how a state is added.

## What the generator does

1. Reads the **state allow-list**, `data/location-pages-state-allowlist.json`.
2. For each allow-listed state, iterates every county in `data/us-counties.json`
   for that state x the four trades (roofing, siding, gutters, windows).
   Discovery does not depend on contractors. The script no longer reads
   Supabase and runs with no credentials.
3. Builds each page, then applies the **500 unique-word floor** and the
   **compliance lint**.
4. Writes `locations/[county-slug]/[trade]/index.html` and rewrites the
   `/locations/` entries in the repo-root `sitemap.xml` so they list exactly the
   pages generated in that run.

Every generated page is indexable. The generator never injects `noindex`.

```
python3 tools/generate_location_pages.py --dry-run      # show what would happen
python3 tools/generate_location_pages.py                # write pages + sitemap
python3 tools/generate_location_pages.py --allowlist X  # use another allow-list file
python3 tools/generate_location_pages.test.py           # self-test (CI runs this)
```

## The state allow-list (CRO-maintained)

`data/location-pages-state-allowlist.json` ships **empty**:

```json
{ "_readme": "...", "states": [] }
```

With an empty list the generator emits nothing and prints
`State allow-list is empty: no pages emitted.` No page publishes until a state
is added.

### How to add a state

statute search clears (D-344) -> CRO writes `data/location-state-profiles/XX.json`
-> add `XX` to the allow-list -> run the generator -> PR.

1. **Statute search clears** (D-344 trigger a), and the result is recorded.
2. **CRO writes the state profile**, `data/location-state-profiles/XX.json`
   (no code change). Copy `IN.json` as the model; its `_readme` documents the
   schema: `code`, `name`, and `regions`, where each region has a `label`, the
   `counties` it contains, and one or more `climate` paragraphs (each must contain
   `{county}`). Every county of the state in `data/us-counties.json` must appear
   in exactly one region. Climate copy is written per state and is not invented.
   **Indiana is the only state with a profile today.**
3. **Add `XX` to `"states"`** in `data/location-pages-state-allowlist.json`.
4. **Run the generator** (`--dry-run` first) and review the output. The run
   prints the min and median unique-word count; a thin margin over 500 is
   visible there. A missing or malformed profile, missing county data, or a
   county with no region fails the run with an explicit `StateConfigError`
   before anything is written.
5. **PR**, with the page copy reviewed (Dustin / CRO own copy). Commit
   `locations/` and `sitemap.xml` in that PR.

Removing a state from the list stops regeneration and drops its URLs from the
sitemap on the next run. It does not delete pages already on disk; delete
`locations/*-county-<state>/` in the same PR if the pages should come down.

## The 500 unique-word floor (D-241 guardrail 2, kept)

A page whose unique content is under `MIN_WORDS` (500) is **not generated**: it
is not written to disk and not added to the sitemap. The run logs it as
`SKIPPED (thin ...)`.

"Unique" is measured by `unique_word_count()`: the words of the page's
`<main>` content, minus the blocks every page shares (breadcrumb, CTA bar,
legal disclosure, homeowner-guide link list, all marked `data-boilerplate` in
the template). Nav, head, footer, scripts, styles and JSON-LD are outside
`<main>` and never count. What is left is the page-specific prose. Today every
Indiana page lands between 536 and 658.

## Copy rule (D-345)

Otter Quotes creates a scope of work and **sends it to local contractors**. No
string may state or imply that Otter Quotes has contractors in a county.
Enforced in the template and in `compliance_lint()`:

- Every page must contain the exact phrase `send it to local contractors`.
- Banned, case-insensitive (`HAVE_CONTRACTORS_BANS`): "our contractors", "our
  network of", "contractors who serve", "contractors serving", "contractors in
  [X] County", "local contractors we", "contractors near you", "approved
  contractors", "contractors available", "contractors on the platform",
  "we have ... contractors", "platform coverage", "contractor profiles".
- Also banned: "connects you with contractors", "connects homeowners with
  contractors". The lint scans the page HTML **and** the decoded JSON-LD strings;
  the LocalBusiness description and the disclosure use the approved framing.
- D-104: no "vetted" or screening claims. D-168: no response-time claims.
  D-175: brand is "Otter Quotes". D-312: no vendor names (list reused from
  `scripts/vendor-scrub-check.py`, plus Stripe, Mailgun, Twilio).

A lint failure stops the run with an error; it is a copy bug, not a skip.

## Removed by D-345

The >=2-active-contractors eligibility check (`MIN_CONTRACTORS`), the
contractor coverage-count and profile-link sections, and the auto-noindex rule
(`inject_noindex`). A county with zero contractors can get an indexable page.

## Scheduling

The previous version of this file documented a nightly GitHub Actions workflow
(`generate-location-pages.yml`) that regenerated pages from Supabase. That
workflow was never committed under `.github/workflows/` and is not needed for
the empty-allow-list state. If a nightly regeneration is wanted after a state is
added, the job needs no Supabase secret; it is
`python3 tools/generate_location_pages.py` followed by committing `locations/`
and `sitemap.xml`. Adding it is a separate decision.
