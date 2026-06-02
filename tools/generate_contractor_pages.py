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
CONTRACTOR_DIR = REPO_ROOT / "contractor"
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
    """Fetch approved contractors that have opted into the public directory (SQL v83)."""
    fields = (
        "id,company_name,about_us,why_choose_us,trades,service_counties,"
        "service_area_description,years_in_business,google_reviews_url,bbb_url,"
        "angi_url,yelp_url,has_general_liability,has_workers_comp,status,"
        "cert_status,intro_video_path,gallery_photo_urls,preferred_brands,"
        "address_city,address_state,created_at"
    )
    path = (
        f"contractors?select={fields}&status=eq.approved"
        f"&public_directory_optin=eq.true&order=company_name.asc"
    )
    return supabase_get(service_key, path)


def fetch_licenses(service_key: str, contractor_id: str) -> list:
    """Fetch multi-license records for a contractor (D-218)."""
    try:
        path = (
            f"contractor_licenses?select=jurisdiction,license_number,license_type,"
            f"expiry_date,verify_url&contractor_id=eq.{contractor_id}"
        )
        return supabase_get(service_key, path)
    except Exception:
        return []


def trade_list_html(trades: list) -> str:
    if not trades:
        return ""
    labels = [TRADE_LABELS.get(t, t.title()) for t in trades]
    return ", ".join(labels)


def cert_badges_html(cert_status: dict) -> str:
    if not cert_status or not isinstance(cert_status, dict):
        return ""
    badges = []
    for brand, info in cert_status.items():
        if isinstance(info, dict) and info.get("verified"):
            tier = info.get("tier", "")
            tier_str = f" — {tier}" if tier else ""
            badges.append(
                f'<span class="cert-badge">{brand}{tier_str}</span>'
            )
    if not badges:
        return ""
    return (
        '<div class="cert-badges">'
        '<p class="cert-label">Manufacturer Certifications on File</p>'
        + "".join(badges)
        + "</div>"
    )


def license_rows_html(licenses: list) -> str:
    if not licenses:
        return ""
    rows = []
    for lic in licenses:
        jur = lic.get("jurisdiction", "")
        num = lic.get("license_number", "")
        ltype = lic.get("license_type", "")
        expiry = lic.get("expiry_date", "")
        verify = lic.get("verify_url", "")
        verify_link = f' <a href="{verify}" target="_blank" rel="noopener">Verify ↗</a>' if verify else ""
        rows.append(
            f"<tr><td>{jur}</td><td>{num}</td><td>{ltype}</td>"
            f"<td>{expiry}</td><td>{verify_link}</td></tr>"
        )
    return (
        '<table class="license-table">'
        "<thead><tr><th>Jurisdiction</th><th>License #</th>"
        "<th>Type</th><th>Expiry</th><th>Verify</th></tr></thead>"
        "<tbody>" + "".join(rows) + "</tbody></table>"
    )


def review_links_html(c: dict) -> str:
    links = []
    if c.get("google_reviews_url"):
        links.append(f'<a href="{c["google_reviews_url"]}" target="_blank" rel="noopener nofollow">Google Reviews ↗</a>')
    if c.get("bbb_url"):
        links.append(f'<a href="{c["bbb_url"]}" target="_blank" rel="noopener nofollow">BBB Profile ↗</a>')
    if c.get("angi_url"):
        links.append(f'<a href="{c["angi_url"]}" target="_blank" rel="noopener nofollow">Angi Profile ↗</a>')
    if c.get("yelp_url"):
        links.append(f'<a href="{c["yelp_url"]}" target="_blank" rel="noopener nofollow">Yelp Profile ↗</a>')
    if not links:
        return ""
    return '<div class="review-links">' + " &bull; ".join(links) + "</div>"


def service_area_html(c: dict) -> str:
    counties = c.get("service_counties") or []
    desc = c.get("service_area_description", "")
    if not counties and not desc:
        return ""
    county_str = ", ".join(counties) if counties else ""
    if county_str and desc:
        return f"<p>{county_str}</p><p class='text-muted'>{desc}</p>"
    return f"<p>{county_str or desc}</p>"


def insurance_line_html(c: dict) -> str:
    parts = []
    if c.get("has_general_liability"):
        parts.append("General Liability on file")
    if c.get("has_workers_comp"):
        parts.append("Workers&#39; Comp on file")
    return " &bull; ".join(parts) if parts else ""


def generate_html(c: dict, slug: str, licenses: list) -> str:
    company = c.get("company_name", "Contractor")
    city = c.get("address_city", "")
    state = c.get("address_state", "")
    location_str = f"{city}, {state}" if city and state else (city or state or "Indiana")
    trades_str = trade_list_html(c.get("trades") or [])
    years = c.get("years_in_business")
    years_str = f"{years} years in business" if years else ""
    about = c.get("about_us") or ""
    why = c.get("why_choose_us") or ""
    cert_html = cert_badges_html(c.get("cert_status"))
    lic_html = license_rows_html(licenses)
    review_html = review_links_html(c)
    area_html = service_area_html(c)
    insurance_html = insurance_line_html(c)
    today = datetime.date.today().isoformat()

    schema_org = {
        "@context": "https://schema.org",
        "@type": ["LocalBusiness", "HomeAndConstructionBusiness"],
        "name": company,
        "description": f"{company} provides {trades_str} services through the Otter Quotes platform. Licensing on file. Serving {location_str}.",
        "url": f"{SITE_BASE}/contractor/{slug}/",
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

    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_BASE}/"},
            {"@type": "ListItem", "position": 2, "name": "Contractor Directory", "item": f"{SITE_BASE}/contractor/"},
            {"@type": "ListItem", "position": 3, "name": company, "item": f"{SITE_BASE}/contractor/{slug}/"},
        ],
    }

    about_section = f"<p>{about}</p>" if about else ""
    why_section = f"<div class='why-section'><h3>Why contractors choose Otter Quotes</h3><p>{why}</p></div>" if why else ""
    years_section = f"<p class='stat-line'><strong>{years_str}</strong></p>" if years_str else ""
    trades_section = f"<p><strong>Trades:</strong> {trades_str}</p>" if trades_str else ""
    insurance_section = f"<p class='insurance-line'>{insurance_html}</p>" if insurance_html else ""
    area_section = f"<div class='service-area'><h3>Service Area</h3>{area_html}</div>" if area_html else ""
    certs_section = cert_html
    licenses_section = (
        f"<div class='licenses-section'><h3>Licenses on File</h3>{lic_html}</div>"
        if lic_html else ""
    )
    reviews_section = (
        f"<div class='review-links-section'><h3>External Reviews</h3>{review_html}</div>"
        if review_html else ""
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/img/brand-assets/favicon.png">
<title>{company} — Contractor Profile · Otter Quotes</title>
<meta name="description" content="{company} is available on Otter Quotes. {trades_str} services. {location_str}. View licensing on file, certifications, and service area.">
<link rel="canonical" href="{SITE_BASE}/contractor/{slug}/">
<meta property="og:title" content="{company} — Contractor Profile · Otter Quotes">
<meta property="og:description" content="{company}: {trades_str} contractor serving {location_str} via Otter Quotes. Licensing on file.">
<meta property="og:type" content="profile">
<meta property="og:url" content="{SITE_BASE}/contractor/{slug}/">
<meta property="og:site_name" content="Otter Quotes">

<!-- GA4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-JNQ6XR3LX2"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments)}}
  gtag('js', new Date());
  gtag('config', 'G-JNQ6XR3LX2');
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
.profile-card h2, .profile-card h3 {{
  margin-bottom: var(--sp-4);
}}
.profile-card p {{
  color: var(--slate);
  line-height: 1.75;
  margin-bottom: var(--sp-3);
}}
.stat-line {{ color: var(--white); font-size: 1.05rem; }}
.insurance-line {{ font-size: 0.9rem; color: var(--amber); }}
.text-muted {{ font-size: 0.9rem; color: var(--gray); }}
.cert-badges {{ margin-top: var(--sp-4); }}
.cert-label {{ font-size: 0.85rem; color: var(--gray); margin-bottom: var(--sp-2); }}
.cert-badge {{
  display: inline-block;
  background: rgba(224,123,0,0.12);
  border: 1px solid rgba(224,123,0,0.25);
  color: var(--amber);
  border-radius: 4px;
  padding: 0.2rem 0.6rem;
  font-size: 0.85rem;
  margin: 0.15rem 0.2rem;
}}
.license-table {{ width: 100%; border-collapse: collapse; font-size: 0.9rem; margin-top: var(--sp-4); }}
.license-table th, .license-table td {{
  text-align: left;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  color: var(--slate);
}}
.license-table th {{ color: var(--gray); font-weight: 500; font-size: 0.82rem; text-transform: uppercase; }}
.license-table a {{ color: var(--amber); }}
.review-links a {{ color: var(--amber); text-decoration: none; font-size: 0.9rem; }}
.review-links a:hover {{ text-decoration: underline; }}
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
// Inline nav bootstrap — matches pattern used across static pages
(function() {{
  var navHtml = '<nav class="site-nav"><div class="nav-inner"><a class="nav-logo" href="/"><img src="/img/brand-assets/otter-logo-inline.svg" alt="Otter Quotes" height="32"></a><div class="nav-links"><a href="/how-it-works.html">How It Works</a><a href="/contractor-join.html">For Contractors</a><a href="/get-started.html" class="btn btn-primary btn-sm">Get Started</a></div></div></nav>';
  document.write(navHtml);
}})();
</script>

<main>
  <div class="profile-hero">
    <div class="breadcrumb">
      <a href="/">Home</a> &rsaquo; <a href="/contractor/">Contractors</a> &rsaquo; {company}
    </div>
    <div style="padding: var(--sp-8) var(--sp-6) 0;">
      <div class="location-badge">{location_str}</div>
      <h1>{company}</h1>
      {years_section}
      {trades_section}
      {insurance_section}
    </div>
  </div>

  <div class="profile-body">

    {f'<div class="profile-card"><h2>About {company}</h2>{about_section}</div>' if about else ''}

    {f'<div class="profile-card">{certs_section}</div>' if cert_html else ''}

    {f'<div class="profile-card">{licenses_section}</div>' if lic_html else ''}

    {f'<div class="profile-card">{area_section}</div>' if area_html else ''}

    {f'<div class="profile-card">{reviews_section}</div>' if review_html else ''}

    <div class="cta-bar">
      <p>Ready to connect with a qualified contractor?</p>
      <a href="/get-started.html" class="btn btn-primary btn-lg">Start Your Project with Otter Quotes</a>
    </div>

    <p class="disclosure">
      Otter Quotes is an independent platform that connects homeowners with contractors for property damage repair and exterior improvement projects.
      Licensing and insurance information shown on this page is based on documents submitted by the contractor. Otter Quotes does not independently verify, endorse, or warrant the quality of any contractor's work.
      For independent verification, use the links above to check state licensing boards and review platforms.
    </p>

    <div class="profile-card" style="margin-top: var(--sp-8);">
      <h3>More from Otter Quotes</h3>
      <ul>
        <li><a href="/guides/how-to-choose-contractor.html">How to Choose a Contractor Without Getting Burned</a></li>
        <li><a href="/contractor-faq.html">Contractor FAQ</a></li>
        <li><a href="/how-it-works.html">How Otter Quotes Works</a></li>
      </ul>
    </div>

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

    # Remove existing contractor/ entries (so we regenerate cleanly)
    sitemap_text = re.sub(
        r"\s*<url>\s*<loc>https://otterquote\.com/contractor/[^<]*</loc>.*?</url>",
        "",
        sitemap_text,
        flags=re.DOTALL,
    )

    # Build new entries
    new_entries = "\n".join(
        f"""  <url>
    <loc>{SITE_BASE}/contractor/{slug}/</loc>
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
        cards.append(
            f"""<a href="/contractor/{slug}/" class="dir-card">
  <strong>{company}</strong>
  <span class="dir-location">{location}</span>
  <span class="dir-trades">{trades_str}</span>
</a>"""
        )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/img/brand-assets/favicon.png">
<title>Contractor Directory — Otter Quotes</title>
<meta name="description" content="Browse contractors available on the Otter Quotes platform. View licensing on file, service areas, and certifications.">
<link rel="canonical" href="{SITE_BASE}/contractor/">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-JNQ6XR3LX2"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','G-JNQ6XR3LX2');</script>
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

    index_path = CONTRACTOR_DIR / "index.html"
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
        contractor_id = c.get("id", "")

        print(f"  Processing: {company} -> /contractor/{slug}/")

        # Fetch multi-license data (D-218)
        licenses = fetch_licenses(service_key, contractor_id) if contractor_id else []

        # Generate profile page
        html = generate_html(c, slug, licenses)
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
    print("\nNEXT STEPS:")
    print("  1. Run migration for contractors.public_directory_optin column (Tier 3 — migration-author task needed)")
    print("  2. After migration: add public_directory_optin=eq.true filter to fetch_contractors()")
    print("  3. Add GitHub Actions step to run this script on every deploy")
    print("  4. Send 'profile is live' email to each contractor (email template pending)")
    print("  5. Update Marketing/6-Direct-Organic/seo-tracker.md 'Directory Pages Live' section (Cowork)")


if __name__ == "__main__":
    main()
