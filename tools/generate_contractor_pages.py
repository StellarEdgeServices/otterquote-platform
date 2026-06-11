#!/usr/bin/env python3
"""
Generate static contractor profile pages for SEO directory.

Pulls approved contractors from Supabase and generates:
  contractor/[slug]/index.html  for each contractor

Also updates sitemap.xml with generated URLs.

Usage:
  python tools/generate_contractor_pages.py [--dry-run]

Notes:
  - Only contractors with public_directory_optin = true are included (SQL v83, live).
  - Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars or .deploy-secrets file.
  - Run from repo root: python tools/generate_contractor_pages.py
"""

import os
import re
import sys
import json
import pathlib
import datetime
import argparse
import urllib.request
import urllib.parse

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SUPABASE_URL = "https://yeszghaspzwwstvsrioa.supabase.co"
SITE_BASE = "https://otterquote.com"
REPO_ROOT = pathlib.Path(__file__).parent.parent
CONTRACTOR_DIR = REPO_ROOT / "contractors"
SITEMAP_PATH = REPO_ROOT / "sitemap.xml"

TRADE_LABELS = {
    "roofing": "Roofing",
    "siding": "Siding",
    "gutters": "Gutters",
    "windows": "Windows",
    "other": "Other Exterior",
}


def load_service_key() -> str:
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")
    if key:
        return key
    secrets_path = REPO_ROOT / "tools" / ".deploy-secrets"
    if not secrets_path.exists():
        secrets_path = REPO_ROOT.parent / "Stellar Edge Services" / "OtterQuote" / "Tools" / ".deploy-secrets"
    if secrets_path.exists():
        for line in secrets_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError(
        "SUPABASE_SERVICE_ROLE_KEY not found. Set the env var or ensure .deploy-secrets is present."
    )


def supabase_get(service_key: str, path: str) -> list:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-") or "contractor"


def fetch_contractors(service_key: str) -> list:
    """Fetch approved contractors that have opted into the public directory (SQL v83).

    Only the four approved public fields are included in the generated HTML:
    company_name, address_city + address_state, trades[], rating + review_count.
    All other fields fetched here are excluded from public output per D-249.
    """
    fields = (
        "id,company_name,trades,address_city,address_state,rating,review_count,status"
    )
    path = (
        f"contractors?select={fields}&status=eq.approved"
        f"&public_directory_optin=eq.true&order=company_name.asc"
    )
    return supabase_get(service_key, path)


def trade_list_html(trades: list) -> str:
    if not trades:
        return ""
    labels = [TRADE_LABELS.get(t, t.title()) for t in trades]
    return ", ".join(labels)


def generate_html(c: dict, slug: str, _licenses: list) -> str:
    """Generate an individual contractor profile page.

    Public data exposure per D-249 (locked 2026-06-04):
    Only company_name, address_city + address_state, trades[], rating + review_count.
    All PII fields (phone, email, license_number, address_line1/zip, etc.) are excluded.
    """
    company = c.get("company_name", "Contractor")
    city = c.get("address_city", "")
    state = c.get("address_state", "")
    location_str = f"{city}, {state}" if city and state else (city or state or "Indiana")
    trades_str = trade_list_html(c.get("trades") or [])

    rating = c.get("rating")
    review_count = c.get("review_count") or 0
    rating_html = ""
    if rating:
        rating_html = f'<p class="rating-line"><strong>{rating:.1f} ★</strong> ({review_count} review{"s" if review_count != 1 else ""})</p>'

    schema_org = {
        "@context": "https://schema.org",
        "@type": ["LocalBusiness", "HomeAndConstructionBusiness"],
        "name": company,
        "description": f"{company} provides {trades_str} services through the Otter Quotes platform. Serving {location_str}.",
        "url": f"{SITE_BASE}/contractors/{slug}/",
        "areaServed": [{"@type": "State", "name": "Indiana"}],
        "address": {
            "@type": "PostalAddress",
            "addressLocality": city,
            "addressRegion": state,
            "addressCountry": "US",
        } if city else None,
    }
    if not schema_org["address"]:
        del schema_org["address"]
    if rating:
        schema_org["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": str(rating),
            "reviewCount": str(review_count),
        }

    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_BASE}/"},
            {"@type": "ListItem", "position": 2, "name": "Contractor Directory", "item": f"{SITE_BASE}/contractors/"},
            {"@type": "ListItem", "position": 3, "name": company, "item": f"{SITE_BASE}/contractors/{slug}/"},
        ],
    }

    trades_section = f"<p><strong>Trades:</strong> {trades_str}</p>" if trades_str else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/img/brand-assets/favicon.png">
<title>{company} — Contractor Profile · Otter Quotes</title>
<meta name="description" content="{company} is available on Otter Quotes. {trades_str} services in {location_str}. Get competing bids from qualified contractors.">
<link rel="canonical" href="{SITE_BASE}/contractors/{slug}/">
<meta property="og:title" content="{company} — Contractor Profile · Otter Quotes">
<meta property="og:description" content="{company}: {trades_str} contractor serving {location_str} via Otter Quotes.">
<meta property="og:type" content="profile">
<meta property="og:url" content="{SITE_BASE}/contractors/{slug}/">
<meta property="og:site_name" content="Otter Quotes">

<!-- GA4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-D1Y1TLGEFY"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments)}}
  gtag('js', new Date());
  gtag('config', 'G-D1Y1TLGEFY');
</script>

<script type="application/ld+json">{json.dumps(schema_org, indent=2)}</script>
<script type="application/ld+json">{json.dumps(breadcrumb, indent=2)}</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/design-system.css">
<link rel="stylesheet" href="/css/nav.css">

<style>
.profile-hero {{
  padding: var(--sp-12) 0 var(--sp-8);
  background: radial-gradient(ellipse at 50% 0%, rgba(224,123,0,0.06) 0%, transparent 60%);
  text-align: center;
}}
.profile-hero h1 {{
  font-size: clamp(1.6rem, 4vw, 2.4rem);
  margin-bottom: var(--sp-3);
}}
.profile-hero .location-badge {{
  display: inline-block;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 99px;
  padding: 0.25rem 0.9rem;
  font-size: 0.9rem;
  color: var(--slate);
  margin-bottom: var(--sp-4);
}}
.profile-body {{
  max-width: 820px;
  margin: 0 auto;
  padding: var(--sp-10) var(--sp-6);
}}
.profile-card {{
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: var(--radius-lg);
  padding: var(--sp-8);
  margin-bottom: var(--sp-8);
}}
.profile-card p {{
  color: var(--slate);
  line-height: 1.75;
  margin-bottom: var(--sp-3);
}}
.rating-line {{ color: var(--amber); font-size: 1rem; }}
.cta-bar {{
  text-align: center;
  padding: var(--sp-10) 0;
  border-top: 1px solid rgba(255,255,255,0.06);
}}
.cta-bar p {{ color: var(--slate); margin-bottom: var(--sp-6); }}
.disclosure {{
  font-size: 0.82rem;
  color: var(--gray);
  text-align: center;
  padding: var(--sp-4) var(--sp-6) var(--sp-10);
  max-width: 700px;
  margin: 0 auto;
  line-height: 1.6;
}}
.breadcrumb {{
  font-size: 0.85rem;
  color: var(--gray);
  padding: var(--sp-4) 0 0;
  text-align: center;
}}
.breadcrumb a {{ color: var(--amber); text-decoration: none; }}
</style>
</head>
<body>

<script>
(function() {{
  var navHtml = '<nav class="site-nav"><div class="nav-inner"><a class="nav-logo" href="/"><img src="/img/brand-assets/otter-logo-inline.svg" alt="Otter Quotes" height="32"></a><div class="nav-links"><a href="/how-it-works.html">How It Works</a><a href="/contractor-join.html">For Contractors</a><a href="/get-started.html" class="btn btn-primary btn-sm">Get Started</a></div></div></nav>';
  document.write(navHtml);
}})();
</script>

<main>
  <div class="profile-hero">
    <div class="breadcrumb">
      <a href="/">Home</a> &rsaquo; <a href="/contractors/">Contractor Directory</a> &rsaquo; {company}
    </div>
    <div style="padding: var(--sp-8) var(--sp-6) 0;">
      <div class="location-badge">{location_str}</div>
      <h1>{company}</h1>
      {trades_section}
      {rating_html}
    </div>
  </div>

  <div class="profile-body">

    <div class="profile-card">
      <p>This contractor is available on Otter Quotes for insurance-related repair and exterior improvement projects in {location_str}.</p>
    </div>

    <div class="cta-bar">
      <p>Ready to connect with a qualified contractor?</p>
      <a href="/get-started.html" class="btn btn-primary btn-lg">Start Your Project with Otter Quotes</a>
    </div>

    <p class="disclosure">
      Otter Quotes is an independent platform that connects homeowners with contractors for property damage repair and exterior improvement projects.
      Otter Quotes does not independently verify, endorse, or warrant the quality of any contractor's work.
    </p>

  </div>
</main>

<footer style="text-align:center; padding: var(--sp-8); color: var(--gray); font-size:0.85rem; border-top: 1px solid rgba(255,255,255,0.06);">
  <p>&copy; {datetime.date.today().year} Stellar Edge Services, LLC &mdash; Otter Quotes</p>
  <p><a href="/terms.html" style="color:var(--amber)">Terms</a> &bull; <a href="/privacy.html" style="color:var(--amber)">Privacy</a></p>
</footer>

</body>
</html>
"""


def update_sitemap(generated_slugs: list[str], dry_run: bool) -> None:
    today = datetime.date.today().isoformat()
    sitemap_text = SITEMAP_PATH.read_text(encoding="utf-8")

    # Remove existing contractors/ entries (so we regenerate cleanly)
    sitemap_text = re.sub(
        r"\s*<url>\s*<loc>https://otterquote\.com/contractors/[^<]*</loc>.*?</url>",
        "",
        sitemap_text,
        flags=re.DOTALL,
    )

    # Build new entries
    new_entries = "\n".join(
        f"""  <url>
    <loc>{SITE_BASE}/contractors/{slug}/</loc>
    <lastmod>{today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>"""
        for slug in sorted(generated_slugs)
    )

    # Insert before closing </urlset>
    sitemap_text = sitemap_text.replace("</urlset>", f"\n{new_entries}\n</urlset>")

    if dry_run:
        print(f"[DRY RUN] Would update sitemap.xml with {len(generated_slugs)} contractor URLs")
    else:
        SITEMAP_PATH.write_text(sitemap_text, encoding="utf-8")
        print(f"Updated sitemap.xml — {len(generated_slugs)} contractor URLs added")


def generate_directory_index(contractors_with_slugs: list[tuple], dry_run: bool) -> None:
    """Generate contractor/index.html — a directory listing page."""
    today = datetime.date.today().isoformat()
    cards = []
    for c, slug in contractors_with_slugs:
        company = c.get("company_name", "")
        city = c.get("address_city", "")
        state = c.get("address_state", "")
        trades_str = trade_list_html(c.get("trades") or [])
        location = f"{city}, {state}" if city and state else (city or state or "Indiana")
        rating = c.get("rating")
        rating_snippet = f'<span class="dir-rating">{rating:.1f} ★</span>' if rating else ""
        cards.append(
            f"""<a href="/contractors/{slug}/" class="dir-card">
  <strong>{company}</strong>
  <span class="dir-location">{location}</span>
  <span class="dir-trades">{trades_str}</span>
  {rating_snippet}
</a>"""
        )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/img/brand-assets/favicon.png">
<title>Contractor Directory — Otter Quotes</title>
<meta name="description" content="Browse contractors available on the Otter Quotes platform. Get competing bids from qualified roofing and exterior contractors.">
<link rel="canonical" href="{SITE_BASE}/contractors/">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-D1Y1TLGEFY"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','G-D1Y1TLGEFY');</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/design-system.css">
<link rel="stylesheet" href="/css/nav.css">
<style>
.dir-hero {{ padding: var(--sp-12) var(--sp-6) var(--sp-8); text-align: center; }}
.dir-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--sp-4); max-width: 1100px; margin: 0 auto; padding: 0 var(--sp-6) var(--sp-12); }}
.dir-card {{ display: block; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: var(--radius-md); padding: var(--sp-5) var(--sp-6); text-decoration: none; transition: border-color 0.2s; }}
.dir-card:hover {{ border-color: var(--amber); }}
.dir-card strong {{ display: block; color: var(--white); font-size: 1rem; margin-bottom: var(--sp-1); }}
.dir-location {{ display: block; font-size: 0.85rem; color: var(--gray); margin-bottom: var(--sp-1); }}
.dir-trades {{ display: block; font-size: 0.82rem; color: var(--amber); }}
.dir-rating {{ display: block; font-size: 0.82rem; color: var(--amber); margin-top: var(--sp-1); }}
.disclosure {{ font-size: 0.82rem; color: var(--gray); text-align: center; padding: 0 var(--sp-6) var(--sp-10); max-width: 700px; margin: 0 auto; }}
</style>
</head>
<body>
<script>
(function(){{var navHtml='<nav class="site-nav"><div class="nav-inner"><a class="nav-logo" href="/"><img src="/img/brand-assets/otter-logo-inline.svg" alt="Otter Quotes" height="32"></a><div class="nav-links"><a href="/how-it-works.html">How It Works</a><a href="/contractor-join.html">For Contractors</a><a href="/get-started.html" class="btn btn-primary btn-sm">Get Started</a></div></div></nav>';document.write(navHtml);}})();
</script>
<main>
<div class="dir-hero">
  <h1>Contractor Directory</h1>
  <p style="color:var(--slate);max-width:600px;margin:0 auto;">Browse contractors available through Otter Quotes. Licensing documentation on file for all listed contractors.</p>
</div>
<div class="dir-grid">
{"".join(cards)}
</div>
<p class="disclosure">Licensing and insurance information is based on documents submitted by contractors. Otter Quotes does not independently endorse or warrant any contractor's work. Verify licensing independently before hiring.</p>
</main>
<footer style="text-align:center;padding:var(--sp-8);color:var(--gray);font-size:0.85rem;border-top:1px solid rgba(255,255,255,0.06);">
<p>&copy; {datetime.date.today().year} Stellar Edge Services, LLC &mdash; Otter Quotes</p>
</footer>
</body>
</html>"""

    index_path = CONTRACTOR_DIR / "index.html"  # contractors/index.html
    if dry_run:
        print(f"[DRY RUN] Would write {index_path}")
    else:
        CONTRACTOR_DIR.mkdir(parents=True, exist_ok=True)
        index_path.write_text(html, encoding="utf-8")
        print(f"Written: {index_path}")


def main():
    parser = argparse.ArgumentParser(description="Generate contractor profile pages")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing files")
    args = parser.parse_args()

    print("Loading Supabase service key...")
    service_key = load_service_key()

    print("Fetching approved contractors...")
    contractors = fetch_contractors(service_key)
    print(f"Found {len(contractors)} approved contractors")

    if not contractors:
        print("No approved contractors found — nothing to generate.")
        return

    generated_slugs = []
    contractors_with_slugs = []

    for c in contractors:
        company = c.get("company_name", "")
        if not company:
            continue

        slug = slugify(company)

        print(f"  Processing: {company} -> /contractors/{slug}/")

        # Generate profile page (only 4 approved public fields per D-249)
        html = generate_html(c, slug, [])
        profile_dir = CONTRACTOR_DIR / slug
        profile_path = profile_dir / "index.html"

        if args.dry_run:
            print(f"  [DRY RUN] Would write {profile_path}")
        else:
            profile_dir.mkdir(parents=True, exist_ok=True)
            profile_path.write_text(html, encoding="utf-8")
            print(f"  Written: {profile_path}")

        generated_slugs.append(slug)
        contractors_with_slugs.append((c, slug))

    # Generate directory index page
    generate_directory_index(contractors_with_slugs, args.dry_run)

    # Update sitemap
    update_sitemap(generated_slugs, args.dry_run)

    print(f"\nDone — {len(generated_slugs)} contractor profile pages {'(dry run)' if args.dry_run else 'generated'}.")
    print(f"  Directory index: contractors/index.html")
    print(f"  Profile pages:   contractors/[slug]/index.html")
    print(f"  Sitemap:         updated with {len(generated_slugs)} /contractors/ URLs")


if __name__ == "__main__":
    main()
