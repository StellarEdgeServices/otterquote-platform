#!/usr/bin/env python3
"""
Generate static referral-partner profile pages for the SEO partner directory.

Pulls opted-in referral agents from Supabase and generates:
  partners/[channel]/[slug]/index.html  for each agent

Channels (from referral_agents.agent_type):
  re_agent        -> partners/re/
  home_inspector  -> partners/inspector/
  insurance_agent -> partners/insurance-agent/

Also updates sitemap.xml with generated URLs (mirrors
tools/generate_contractor_pages.py conventions).

Usage:
  python tools/generate_partner_pages.py [--dry-run]

Notes:
  - Only agents with status = 'active' AND public_directory_optin = true are
    included. The public_directory_optin column is added by migration
    v88_referral_agents_public_directory_optin.sql (DRAFT — Tier 3, D-182
    approval pending). Until that column exists in the live DB, this script
    detects the missing column, logs a clear notice, generates ZERO pages,
    and exits 0.
  - Column probe uses the client-safe publishable key (parsed from
    js/config.js), so the graceful "column pending" path needs no secrets.
    Actual page generation requires SUPABASE_SERVICE_ROLE_KEY (env var or
    .deploy-secrets), same as the contractor generator.
  - Public field discipline: only the safe display columns already exposed
    by the referral_agents_public view (v88 view, sql/) are used in output:
    first_name, last_name, company, service_area, bio, agent_type,
    unique_code. No email, phone, W-9, or financial fields — ever.
  - Compliance (hard requirements, enforced by construction):
      D-021  — insurance-agent profiles contain NO commission language.
               Templates contain none for any channel; agent-supplied bios
               on insurance-agent profiles are screened and fall back to
               the compliant default if commission language is detected.
      D-087  — no "lead/leads" in user-facing copy.
      D-104  — no "vetted/approved/endorsed" claims.
      D-167  — no "certified/licensed" overclaims.
      D-168  — no response-time claims.
      D-169  — Indiana-only positioning.
      D-175  — display name "Otter Quotes" (two words) in user-facing copy.
  - Schema markup: Person + BreadcrumbList only. NO AggregateRating (no
    external review data exists for referral partners).
  - Run from repo root: python tools/generate_partner_pages.py
"""

import os
import re
import sys
import json
import html
import pathlib
import datetime
import argparse
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SUPABASE_URL = "https://yeszghaspzwwstvsrioa.supabase.co"
SITE_BASE = "https://otterquote.com"
REPO_ROOT = pathlib.Path(__file__).parent.parent
PARTNERS_DIR = REPO_ROOT / "partners"
SITEMAP_PATH = REPO_ROOT / "sitemap.xml"
OPTIN_MIGRATION = "v88_referral_agents_public_directory_optin"

# agent_type -> (url channel segment, display label, attribution landing page)
# The landing pages read ?ref=<unique_code> and record partner attribution
# (same mechanism as every existing referral link — see ref-re.html,
# ref-inspector.html, ref-insurance.html).
CHANNELS = {
    "re_agent": ("re", "Real Estate Agent", "/ref-re.html"),
    "home_inspector": ("inspector", "Home Inspector", "/ref-inspector.html"),
    "insurance_agent": ("insurance-agent", "Insurance Agent", "/ref-insurance.html"),
}
# agent_type values outside CHANNELS (e.g. 'customer') are not directory
# channels and are skipped.

# D-021 screen: if an agent-supplied bio on an INSURANCE-AGENT profile
# contains any of these terms, the compliant default intro is used instead.
COMMISSION_TERMS = re.compile(
    r"\b(commission|referral fee|kickback|compensat\w*|payout|earn\w*|"
    r"get paid|paid per|bonus)\b",
    re.IGNORECASE,
)


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


def load_publishable_key() -> str:
    """Parse the client-safe publishable key from js/config.js (probe only)."""
    config_path = REPO_ROOT / "js" / "config.js"
    if config_path.exists():
        m = re.search(r"SUPABASE_ANON:\s*'([^']+)'", config_path.read_text(encoding="utf-8"))
        if m:
            return m.group(1)
    return ""


def supabase_get(api_key: str, path: str) -> list:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def optin_column_exists(api_key: str) -> bool:
    """Probe for referral_agents.public_directory_optin.

    PostgREST resolves selected columns against the schema cache before RLS
    applies, so an unknown column returns HTTP 400 (code 42703) with any
    valid API key — the publishable key is sufficient for this probe.
    """
    try:
        supabase_get(api_key, "referral_agents?select=public_directory_optin&limit=1")
        return True
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        if e.code == 400 and ("public_directory_optin" in body or "42703" in body):
            return False
        raise


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-") or "partner"


def fetch_agents(service_key: str) -> list:
    """Fetch active referral agents that opted into the public directory.

    Only safe display fields are selected — matches the safe-column list of
    the referral_agents_public view. No PII/financial columns.
    """
    fields = "id,first_name,last_name,company,service_area,bio,agent_type,unique_code,status"
    path = (
        f"referral_agents?select={fields}&status=eq.active"
        f"&public_directory_optin=eq.true&order=last_name.asc"
    )
    return supabase_get(service_key, path)


def safe_jsonld(obj) -> str:
    return json.dumps(obj, indent=2).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def intro_paragraph(agent: dict, channel_label: str) -> str:
    """Agent-supplied bio if present (and compliant), else compliant default.

    D-021 (hard): insurance-agent profiles may contain NO commission
    language. Agent-supplied bios on that channel are screened; on any hit
    the compliant default is used and a warning is logged.
    """
    first = agent.get("first_name") or ""
    last = agent.get("last_name") or ""
    name = f"{first} {last}".strip() or "This partner"
    default = (
        f"{name} is a {channel_label.lower()} who refers homeowners to Otter Quotes, "
        "an independent platform where Indiana homeowners collect competing bids "
        "for property damage repair and exterior improvement projects."
    )
    bio = (agent.get("bio") or "").strip()
    if not bio:
        return html.escape(default, quote=True)
    if agent.get("agent_type") == "insurance_agent" and COMMISSION_TERMS.search(bio):
        print(
            f"  WARNING: bio for {name} (insurance_agent) contains commission "
            "language — using compliant default intro per D-021."
        )
        return html.escape(default, quote=True)
    return html.escape(bio, quote=True)


def generate_html(agent: dict, channel: str, channel_label: str, ref_page: str, slug: str) -> str:
    """Generate an individual partner profile page.

    Public data exposure: only first_name, last_name, company, service_area,
    bio, agent_type, unique_code (all already public via the
    referral_agents_public view). No PII or financial fields.
    """
    first = agent.get("first_name") or ""
    last = agent.get("last_name") or ""
    name = f"{first} {last}".strip() or "Referral Partner"
    company = (agent.get("company") or "").strip()
    service_area = (agent.get("service_area") or "").strip()
    unique_code = agent.get("unique_code") or ""

    name_esc = html.escape(name, quote=True)
    company_esc = html.escape(company, quote=True)
    service_area_esc = html.escape(service_area, quote=True)
    intro_esc = intro_paragraph(agent, channel_label)

    page_url = f"{SITE_BASE}/partners/{channel}/{slug}/"
    cta_href = f"{ref_page}?ref={urllib.parse.quote(unique_code)}" if unique_code else "/get-started.html"

    meta_desc = (
        f"{name} is a {channel_label.lower()} listed in the Otter Quotes partner directory."
        + (f" Serving {service_area}." if service_area else " Serving Indiana homeowners.")
    )
    meta_desc_esc = html.escape(meta_desc, quote=True)

    person = {
        "@context": "https://schema.org",
        "@type": "Person",
        "name": name,
        "jobTitle": channel_label,
        "description": (
            f"{name} is a {channel_label.lower()} in the Otter Quotes partner directory"
            + (f", serving {service_area}." if service_area else ", serving Indiana homeowners.")
        ),
        "url": page_url,
    }
    if company:
        person["worksFor"] = {"@type": "Organization", "name": company}

    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_BASE}/"},
            {"@type": "ListItem", "position": 2, "name": "Partner Directory", "item": f"{SITE_BASE}/partners/"},
            {"@type": "ListItem", "position": 3, "name": name, "item": page_url},
        ],
    }

    company_section = f"<p><strong>Company:</strong> {company_esc}</p>" if company else ""
    service_area_section = (
        f"<p><strong>Service area:</strong> {service_area_esc}</p>" if service_area else ""
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/img/brand-assets/favicon.png">
<title>{name_esc} — {channel_label} · Otter Quotes Partner Directory</title>
<meta name="description" content="{meta_desc_esc}">
<link rel="canonical" href="{page_url}">
<meta property="og:title" content="{name_esc} — {channel_label} · Otter Quotes">
<meta property="og:description" content="{meta_desc_esc}">
<meta property="og:type" content="profile">
<meta property="og:url" content="{page_url}">
<meta property="og:site_name" content="Otter Quotes">

<!-- GA4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-D1Y1TLGEFY"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments)}}
  gtag('js', new Date());
  gtag('config', 'G-D1Y1TLGEFY');
</script>

<script type="application/ld+json">{safe_jsonld(person)}</script>
<script type="application/ld+json">{safe_jsonld(breadcrumb)}</script>

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
.profile-hero .channel-badge {{
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
      <a href="/">Home</a> &rsaquo; <a href="/partners/">Partner Directory</a> &rsaquo; {name_esc}
    </div>
    <div style="padding: var(--sp-8) var(--sp-6) 0;">
      <div class="channel-badge">{channel_label}</div>
      <h1>{name_esc}</h1>
    </div>
  </div>

  <div class="profile-body">

    <div class="profile-card">
      <p>{intro_esc}</p>
      {company_section}
      {service_area_section}
    </div>

    <div class="cta-bar">
      <p>Know this {channel_label.lower()}? Start your project with their referral attached.</p>
      <a href="{cta_href}" class="btn btn-primary btn-lg">Get an Intro From This Agent</a>
    </div>

    <p class="disclosure">
      Otter Quotes is an independent platform that connects homeowners with contractors for property damage repair and exterior improvement projects.
      Referral partners listed in this directory are independent professionals and are not employees or representatives of Otter Quotes.
      Otter Quotes does not warrant any listed professional's services. This page is informational only.
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


def generate_directory_index(agents_with_paths: list, dry_run: bool) -> None:
    """Generate partners/index.html — directory listing grouped by channel."""
    sections = []
    for agent_type, (channel, label, _ref) in CHANNELS.items():
        cards = []
        for agent, ch, slug in agents_with_paths:
            if ch != channel:
                continue
            name = f"{agent.get('first_name') or ''} {agent.get('last_name') or ''}".strip()
            company = (agent.get("company") or "").strip()
            service_area = (agent.get("service_area") or "").strip()
            name_esc = html.escape(name, quote=True)
            company_snippet = f'<span class="dir-company">{html.escape(company, quote=True)}</span>' if company else ""
            area_snippet = f'<span class="dir-area">{html.escape(service_area, quote=True)}</span>' if service_area else ""
            cards.append(
                f"""<a href="/partners/{channel}/{slug}/" class="dir-card">
  <strong>{name_esc}</strong>
  {company_snippet}
  {area_snippet}
</a>"""
            )
        if cards:
            sections.append(
                f"""<h2 class="dir-channel-heading">{label}s</h2>
<div class="dir-grid">
{"".join(cards)}
</div>"""
            )

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/img/brand-assets/favicon.png">
<title>Partner Directory — Otter Quotes</title>
<meta name="description" content="Browse referral partners who work with Otter Quotes — real estate agents, home inspectors, and insurance agents serving Indiana homeowners.">
<link rel="canonical" href="{SITE_BASE}/partners/">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-D1Y1TLGEFY"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','G-D1Y1TLGEFY');</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/design-system.css">
<link rel="stylesheet" href="/css/nav.css">
<style>
.dir-hero {{ padding: var(--sp-12) var(--sp-6) var(--sp-8); text-align: center; }}
.dir-channel-heading {{ max-width: 1100px; margin: 0 auto; padding: var(--sp-6) var(--sp-6) var(--sp-4); }}
.dir-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--sp-4); max-width: 1100px; margin: 0 auto; padding: 0 var(--sp-6) var(--sp-8); }}
.dir-card {{ display: block; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: var(--radius-md); padding: var(--sp-5) var(--sp-6); text-decoration: none; transition: border-color 0.2s; }}
.dir-card:hover {{ border-color: var(--amber); }}
.dir-card strong {{ display: block; color: var(--white); font-size: 1rem; margin-bottom: var(--sp-1); }}
.dir-company {{ display: block; font-size: 0.85rem; color: var(--gray); margin-bottom: var(--sp-1); }}
.dir-area {{ display: block; font-size: 0.82rem; color: var(--amber); }}
.disclosure {{ font-size: 0.82rem; color: var(--gray); text-align: center; padding: 0 var(--sp-6) var(--sp-10); max-width: 700px; margin: 0 auto; }}
</style>
</head>
<body>
<script>
(function(){{var navHtml='<nav class="site-nav"><div class="nav-inner"><a class="nav-logo" href="/"><img src="/img/brand-assets/otter-logo-inline.svg" alt="Otter Quotes" height="32"></a><div class="nav-links"><a href="/how-it-works.html">How It Works</a><a href="/contractor-join.html">For Contractors</a><a href="/get-started.html" class="btn btn-primary btn-sm">Get Started</a></div></div></nav>';document.write(navHtml);}})();
</script>
<main>
<div class="dir-hero">
  <h1>Partner Directory</h1>
  <p style="color:var(--slate);max-width:600px;margin:0 auto;">Referral partners who work with Otter Quotes — real estate agents, home inspectors, and insurance agents serving Indiana homeowners.</p>
</div>
{"".join(sections)}
<p class="disclosure">Referral partners listed in this directory are independent professionals and are not employees or representatives of Otter Quotes. Otter Quotes does not warrant any listed professional's services. This page is informational only.</p>
</main>
<footer style="text-align:center;padding:var(--sp-8);color:var(--gray);font-size:0.85rem;border-top:1px solid rgba(255,255,255,0.06);">
<p>&copy; {datetime.date.today().year} Stellar Edge Services, LLC &mdash; Otter Quotes</p>
</footer>
</body>
</html>"""

    index_path = PARTNERS_DIR / "index.html"
    if dry_run:
        print(f"[DRY RUN] Would write {index_path}")
    else:
        PARTNERS_DIR.mkdir(parents=True, exist_ok=True)
        index_path.write_text(html_content, encoding="utf-8", newline="\n")
        print(f"Written: {index_path}")


def update_sitemap(generated_paths: list, dry_run: bool) -> None:
    today = datetime.date.today().isoformat()
    sitemap_text = SITEMAP_PATH.read_text(encoding="utf-8")

    # Remove existing partners/ entries (so we regenerate cleanly)
    sitemap_text = re.sub(
        r"\s*<url>\s*<loc>https://otterquote\.com/partners/[^<]*</loc>.*?</url>",
        "",
        sitemap_text,
        flags=re.DOTALL,
    )

    new_entries = "\n".join(
        f"""  <url>
    <loc>{SITE_BASE}/partners/{path + "/" if path else ""}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>"""
        for path in sorted(generated_paths)
    )

    sitemap_text = sitemap_text.replace("</urlset>", f"\n{new_entries}\n</urlset>")

    if dry_run:
        print(f"[DRY RUN] Would update sitemap.xml with {len(generated_paths)} partner URLs")
    else:
        SITEMAP_PATH.write_text(sitemap_text, encoding="utf-8", newline="\n")
        print(f"Updated sitemap.xml — {len(generated_paths)} partner URLs added")


def main():
    parser = argparse.ArgumentParser(description="Generate referral-partner profile pages")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing files")
    args = parser.parse_args()

    # -----------------------------------------------------------------------
    # Column probe — graceful zero-page path until migration v88 is applied.
    # Uses the publishable key so no secrets are needed for the probe.
    # -----------------------------------------------------------------------
    probe_key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SERVICE_KEY")
        or load_publishable_key()
    )
    if not probe_key:
        print("ERROR: no API key available for column probe (js/config.js not found).")
        sys.exit(1)

    print("Probing referral_agents.public_directory_optin ...")
    if not optin_column_exists(probe_key):
        print(
            "NOTICE: referral_agents.public_directory_optin does not exist — "
            f"column pending migration {OPTIN_MIGRATION} (Tier 3, D-182 approval pending)."
        )
        print("Generated 0 partner pages. Sitemap unchanged. Exiting cleanly.")
        sys.exit(0)

    print("Column present. Loading Supabase service key...")
    service_key = load_service_key()

    print("Fetching opted-in active referral agents...")
    agents = fetch_agents(service_key)
    print(f"Found {len(agents)} opted-in active agents")

    if not agents:
        print("No opted-in agents found — nothing to generate.")
        return

    generated_paths = []
    agents_with_paths = []
    used_slugs = set()

    for agent in agents:
        agent_type = agent.get("agent_type")
        if agent_type not in CHANNELS:
            print(f"  Skipping non-directory agent_type: {agent_type}")
            continue
        channel, label, ref_page = CHANNELS[agent_type]

        name = f"{agent.get('first_name') or ''} {agent.get('last_name') or ''}".strip()
        if not name:
            print("  Skipping agent with no name")
            continue

        slug = slugify(name)
        if (channel, slug) in used_slugs:
            code = (agent.get("unique_code") or "x").lower()
            slug = f"{slug}-{slugify(code)}"
        used_slugs.add((channel, slug))

        print(f"  Processing: {name} -> /partners/{channel}/{slug}/")

        html_out = generate_html(agent, channel, label, ref_page, slug)
        profile_dir = PARTNERS_DIR / channel / slug
        profile_path = profile_dir / "index.html"

        if args.dry_run:
            print(f"  [DRY RUN] Would write {profile_path}")
        else:
            profile_dir.mkdir(parents=True, exist_ok=True)
            profile_path.write_text(html_out, encoding="utf-8", newline="\n")
            print(f"  Written: {profile_path}")

        generated_paths.append(f"{channel}/{slug}")
        agents_with_paths.append((agent, channel, slug))

    # Directory index page (also the BreadcrumbList level-2 target)
    generate_directory_index(agents_with_paths, args.dry_run)

    # Sitemap — profile pages + the directory index
    update_sitemap(generated_paths + [""] if generated_paths else [], args.dry_run)

    print(f"\nDone — {len(generated_paths)} partner profile pages {'(dry run)' if args.dry_run else 'generated'}.")
    print("  Directory index: partners/index.html")
    print("  Profile pages:   partners/[channel]/[slug]/index.html")
    print(f"  Sitemap:         updated with {len(generated_paths)} /partners/ URLs")


if __name__ == "__main__":
    main()
