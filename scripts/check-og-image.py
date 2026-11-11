#!/usr/bin/env python3
"""gh-3338: fail if any HTML page in the repo still points og:image / twitter:image at the old square
logos, or if the 1200x630 share images are missing, oversized, or the wrong size.
Run from repo root:  python3 scripts/check-og-image.py   (exit 1 on any problem)."""
import re, struct, sys
from pathlib import Path

BASE = "https://otterquote.com/img/social/"
DEFAULT, ROOF = BASE + "og-default.jpg", BASE + "og-roof-buying-season.jpg"
OLD = ("otter-quotes-icon-512.png", "otter-icon-navy.png")
MAX_BYTES = 300 * 1024
errs = []

def jpeg_size(p):
    d = Path(p).read_bytes(); i = 2
    if d[:2] != b"\xff\xd8": return None
    while i < len(d):
        if d[i] != 0xFF: i += 1; continue
        m = d[i + 1]
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", d[i + 5:i + 9]); return w, h
        i += 2 + struct.unpack(">H", d[i + 2:i + 4])[0]
    return None

for name in ("og-default.jpg", "og-roof-buying-season.jpg"):
    p = Path("img/social") / name
    if not p.exists(): errs.append(f"missing {p}"); continue
    if p.stat().st_size > MAX_BYTES: errs.append(f"{p} is {p.stat().st_size} bytes, over {MAX_BYTES}")
    if jpeg_size(p) != (1200, 630): errs.append(f"{p} is {jpeg_size(p)}, expected (1200, 630)")

SKIP = {".git", "node_modules", "_site"}
pages = sorted(str(f) for f in Path(".").rglob("*.html") if not SKIP & set(f.parts))
tag = re.compile(r'<meta\s+(?:property|name)=["\'](og:image|twitter:image)["\']\s+content=["\']([^"\']*)', re.I)
for f in pages:
    t = Path(f).read_text(encoding="utf-8", errors="replace")
    for kind, val in tag.findall(t):
        if val.endswith(OLD): errs.append(f"{f}: {kind} still {val}")
        if val.startswith(BASE) and kind == "og:image":
            w = re.search(r'og:image:width["\']\s+content=["\'](\d+)', t); h = re.search(r'og:image:height["\']\s+content=["\'](\d+)', t)
            if (w and w.group(1) != "1200") or (h and h.group(1) != "630"): errs.append(f"{f}: og:image dimensions {w and w.group(1)}x{h and h.group(1)}, expected 1200x630")
roof = Path("news/roof-buying-season.html").read_text(encoding="utf-8")
for kind in ("og:image", "twitter:image"):
    if (kind, ROOF) not in [(k, v) for k, v in tag.findall(roof)]: errs.append(f"news/roof-buying-season.html: {kind} is not {ROOF}")
if 'name="twitter:card" content="summary_large_image"' not in roof: errs.append("news/roof-buying-season.html: twitter:card is not summary_large_image")
print("\n".join(errs) if errs else f"ok: {len(pages)} html pages, no old og:image/twitter:image values, share images 1200x630 under {MAX_BYTES} bytes")
sys.exit(1 if errs else 0)
