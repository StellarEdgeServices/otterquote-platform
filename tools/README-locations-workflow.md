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
3. Builds every page of the run, applies the **strict 500-word unique-content
   gate** (needs the whole run), then the **compliance lint**.
4. Writes `locations/[county-slug]/[trade]/index.html` and rewrites the
   `/locations/` entries in the repo-root `sitemap.xml` so they list exactly the
   pages generated in that run.

Every generated page is indexable. The generator never injects `noindex`.

The repo-root `sitemap.xml` is written only when the output directory is the repo's
`locations/`. With `--out-dir` elsewhere, the sitemap goes next to that directory
(its parent). Refused with an error before anything is written: an `--out-dir` at the
repo root, or one whose derived sitemap would land anywhere inside the repo tree
(`./sitemap.xml`, `tools/sitemap.xml`, `locations/sitemap.xml`, ...), and an explicit
`--sitemap` that resolves to the repo's own `sitemap.xml`, unless `--out-dir` is the
repo's `locations/`. Use an out-dir whose parent is outside the repo, or a `--sitemap`
path outside the repo.
The site-wide JSON-LD entity is an `Organization` with no `areaServed`; geography
lives on each page's `Service`.

```
python3 tools/generate_location_pages.py --dry-run      # show what would happen
python3 tools/generate_location_pages.py                # write pages + sitemap
python3 tools/generate_location_pages.py --allowlist X  # use another allow-list file
python3 tools/generate_location_pages.py --out-dir DIR  # write elsewhere; sitemap goes to DIR/../sitemap.xml (refused if inside the repo)
python3 tools/generate_location_pages.py --out-dir DIR --sitemap PATH  # PATH must not be the repo's sitemap.xml
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

**Blocked states.** FL, LA and TX are blocked by D-344. The generator refuses them
in the generator itself, whether they are in the allow-list file, passed with
`--allowlist`, or passed to `generate()`: it exits with an error before writing
anything.

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
   The profile also carries `county_content` (see below), which is what lets pages
   pass the strict gate. **Indiana is the only state with a profile today, and it
   has no `county_content`, so its pages do not pass the gate.**
3. **Add `XX` to `"states"`** in `data/location-pages-state-allowlist.json`.
4. **Run the generator** (`--dry-run` first) and review the output. The run
   prints the min and median strict-unique word count; pages under 500 are
   skipped and listed. A missing or malformed profile, missing county data, or a
   county with no region fails the run with an explicit `StateConfigError`
   before anything is written.
5. **PR**, with the page copy reviewed (Dustin / CRO own copy). Commit
   `locations/` and `sitemap.xml` in that PR.

Removing a state from the list stops regeneration and drops its URLs from the
sitemap on the next run. It does not delete pages already on disk; delete
`locations/*-county-<state>/` in the same PR if the pages should come down.

## The strict 500-word gate (D-241 guardrail 2, kept by D-345)

D-241 guardrail 2 reads ">=500 words of unique non-template content per page".
The CEO ruled (#2304) that words shared across pages are template content and
do not count. A page is **emitted only if it has >= `MIN_WORDS` (500) words of
content that appears on no other page in the same run**. A page under the gate
is not written to disk and not added to the sitemap; the run logs
`SKIPPED (thin ...)`.

Measured by `strict_unique_counts()`: the number of words in the page's `<main>`
visible text that are covered by **no 8-word shingle that appears on any other
page built in the run**. One pass builds shingle -> number of pages containing
it; then, per page, every word inside a shared shingle is template content and
the rest are counted.

- The shared template contributes about nothing. Today every Indiana page fails
  (min 8, median 10 strict-unique words), so an Indiana run emits 0 pages. That is
  the intended outcome until the CRO writes county-specific content.
- Identical text on two counties, or on the same county's four trade pages, is
  shared, so it counts for none of them.
- Template baseline: every run also renders synthetic template-only pages (state
  profile, no `county_content`; 60 per trade, `TEMPLATE_BASELINES`) that are compared
  against but never scored or emitted. A one-county state, or a narrowed
  `generate()` call, therefore cannot count template text as unique.
- Repeats within a page count once: a paragraph repeated 14 times is one paragraph.
- Hidden text in the template never counts (elements with `hidden`, `aria-hidden="true"`,
  `sr-only` classes, inline `display:none` / `visibility:hidden` / `font-size:0` /
  `opacity:0`, and `<noscript>`/`<template>`). `county_content` cannot carry markup at
  all (plain text only), so it cannot hide text.
- Known gap: a filler token inserted every 7 words makes every 8-word shingle
  unique. Closing it needs a shorter n-gram test that also flags ordinary prose, so
  it is left to human review of `county_content`.
- All pages of a run are built and linted before any file is written; one lint
  failure leaves zero pages and no sitemap change.
- Each run prints min/median strict-unique words, and an **informational**
  cross-page metric (share of each page's 8-word shingles on no other page).

### `county_content` in the state profile (PLAIN TEXT only)

Where the CRO puts county storm history, housing stock, permit notes and similar
county-specific text. In `data/location-state-profiles/XX.json`:

```json
"county_content": {
  "Marion": {
    "roofing": "First paragraph, 500+ words in total across paragraphs...\n\nSecond paragraph...",
    "siding": "...", "gutters": "...", "windows": "..."
  }
}
```

- **Plain text only.** No HTML, no entities. The loader rejects `<`, `>`, `&`, `{`, `}`,
  backslashes and control characters, so no tag, attribute, style or entity can reach
  the page from `county_content`. Paragraphs are separated by a blank line; the
  generator HTML-escapes the text and wraps each paragraph in a bare `<p>` with no
  attributes. Ordinary words such as "hidden hail damage" are fine. (Write "and",
  not "&"; write "less than", not "<".)
- **Written per trade.** Keys are county names exactly as in `data/us-counties.json`;
  each value is an object keyed by trade (roofing, siding, gutters, windows). A plain
  string is accepted and used for every trade, but the same text on four trade pages
  is shared, so it can never pass the gate.
- The text is rendered under an `<h2>[County] County notes</h2>` heading and is checked
  by the same lint as all other copy (see below).
- A county or trade with no content gets no notes section and will not reach 500.

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
- Also banned: price, savings and speed promises ("save up to", "% off", "free for
  homeowners", "in 24 hours", "within N days", "guarantee" other than "does not
  guarantee"), D-104 "vetted" / "screened" / "licensed and insured", and D-326
  insurer-obligation phrasing ("your insurer must", "insurance will pay", "is
  covered", "claimable", "belongs in the claim", "legitimate supplement"). Page
  copy is procedural only: it never states an entitlement, a coverage outcome or
  what an insurer must do.
- The lint reads the visible text (tags stripped, entities decoded; NFKC-normalised,
  every Unicode Cf character removed, Cyrillic/Greek/small-cap lookalikes folded to
  Latin), the text-bearing attributes (title, alt, aria-*, data-*, meta content), CSS
  `content:` strings, iframe `srcdoc`, the parsed JSON-LD, and hyphen-split and
  hyphen-as-space copies of all of it, so markup, entity and Unicode tricks do not
  bypass it. D-326 "cover(s/ed)" is banned when insurance or a policy is the subject;
  "coverage" is deliberately allowed ("your insurer decides coverage under your
  policy"). Titles of the linked guide/blog pages are not scanned for D-326 (they are
  other pages' titles and get their own R-177 review).
- Also banned: "connects you with contractors", "connects homeowners with
  contractors". The lint scans the page HTML **and** the decoded JSON-LD strings;
  the LocalBusiness description and the disclosure use the approved framing.
- D-104: no "vetted" or screening claims. D-168: no response-time claims.
  D-175: brand is "Otter Quotes". D-312: no vendor names (list reused from
  `scripts/vendor-scrub-check.py`, plus Stripe, Mailgun, Twilio).

A lint failure stops the run with an error; it is a copy bug, not a skip.

### Sentence-level rules (R1, R2, R3)

Adjacency bans can always be dodged by one inserted word, a singular noun or
punctuation, so the lint also judges whole **sentences**. After normalisation
(NFKC, confusables folded, entities decoded, tags stripped, hyphen-split words
joined), text is split into sentences on `.`, `!`, `?` and block boundaries.
`;`, `:`, parentheses and arrows are deliberately **not** boundaries, because
"Contractors: ready" and "Contractors (ready to bid)" must stay one sentence. A
sentence fails if it contains a tradesperson noun (contractor, roofer, crew, pro,
installer, builder, tradesperson/tradespeople, sider, professional, bidder, singular
or plural) **and**:

- **R1**: a readiness / availability / assignment / matching word: ready, waiting,
  wait, standby, stand(s/ing) by, lined up, line up, queued, on call, available,
  assigned, assign, match/matched/matching, dispatched, on hand, at the ready, booked;
- **R2**: an ownership / affiliation word: we, we'll, we've, our, ours, us, Otter Quotes
  (incl. possessive), network, platform, affiliated, partner(s), vetted, member(s),
  "dozens/hundreds/thousands/many of".

**R3**: a sentence with "network" and any of we / our / us / Otter Quotes / platform.

The only exceptions are two whole sentences, listed in `APPROVED_SENTENCES` and compared
after normalisation (never by pattern):

1. `Otter Quotes creates a scope of work and we send it to local contractors.` (D-345,
   CEO chat 2026-10-02, issue #2422)
2. `Otter Quotes does not independently verify, endorse, or warrant the quality of any
   contractor's work, and does not guarantee the availability of any particular
   contractor.` (disclosure carried verbatim from the pre-D-345 generator; D-number to be
   confirmed)

Because the approved statement is matched whole, it must stand alone as its own sentence.
Any added words ("... local contractors who are ready", "... in Marion County") make it an
ordinary sentence that R1/R2 judge on its own words.

### Writing county content around the lint (known false positives)

The lint is deliberately blunt and does not understand context; do not expect it
to be loosened. Phrases that county content (storm history, housing stock, permit
notes) is likely to trip, and how to phrase around them:

| Trips on | Why | Phrase it as |
|---|---|---|
| "hundreds of homes" | "hundreds of" (implies scale of our network) | "many homes", "a large share of the housing stock", or give the real figure with its source |
| "screened porch", "screened-in" | D-104 "screened" | "enclosed porch", "porch with screens" |
| "in 15 minutes", "in 3 days", "within 2 days" | speed promises | "a short drive", "after the storm", or no timing at all |
| "the local team", "local crews", "local pros" | have-contractors (local ... team/crews/pros/roofers/network) | "the county's building department", "storm-response crews from the utility" (name the actual body; never imply it is ours) |
| "a network of storm sirens", "network of" | "network of" | "a system of sirens", "a grid of" |
| any sentence naming contractors/roofers/crews/pros with "we", "our", "us", "platform", "network", "partners", "members", "many of" (R2) | affiliation/ownership | split it: "Roofers in the county set their own prices." (no we/our/platform in that sentence); say what Otter Quotes does in a different sentence |
| a sentence naming contractors/roofers/crews/pros with "ready", "available", "waiting", "matched", "assigned", "booked", "on call" (R1) | readiness/matching | "Roofers were booked for weeks after the 2012 storms" trips R1 even though it is history, not an availability claim: rephrase without the noun or the word, e.g. "Repair schedules ran long after the 2012 storms" |
| "the county's contractors", "Marion County roofers" | "[County] contractors/roofers" | "roofing work in Marion County", "roof replacements in the county" |
| "your policy covers", "insurance covered the loss", "the damage is covered" | D-326: no coverage statements, nothing that interprets a policy | "ask your insurer what your policy includes", "your insurer decides coverage" ("coverage" alone is allowed) |
| "entitled to", "maximize", "lowest price" | D-326 / promises | "may be able to ask", "get the most from", or drop the claim |
| "guarantee" | promises (only "does not / cannot guarantee" passes) | "promise" is fine only for negated statements; otherwise drop |
| "free", "save up to", "% off" | price promises | state facts without price claims |

If a legitimate sentence still trips a ban, rewrite the sentence; a lint failure
stops the whole run and nothing is written.

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
