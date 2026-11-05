#!/usr/bin/env python3
"""Self-test for scripts/check-og-image.py (gh-3338). Builds tiny throwaway trees and runs the detector
in them: a clean tree must PASS, and each defect (old icon value on a page, old navy value in
twitter:image, release page on the wrong image, missing image, wrong-size image, oversized image,
wrong og:image dimensions) must be REJECTED (exit 1) naming the problem.
Run: python3 scripts/check-og-image.test.py"""
import subprocess, sys, tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-og-image.py"
BASE = "https://otterquote.com/img/social/"
FAILURES = []

def check(label, ok):
    print(("PASS " if ok else "FAIL ") + label)
    if not ok: FAILURES.append(label)

def jpeg(w=1200, h=630, pad=1000):
    # minimal JPEG: SOI, SOF0 with the size, EOI, plus padding after it
    return b"\xff\xd8\xff\xc0\x00\x11\x08" + h.to_bytes(2, "big") + w.to_bytes(2, "big") + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01" + b"\xff\xd9" + b"\0" * pad

def page(img, tw=None, w="1200", h="630", card="summary_large_image"):
    t = f'<meta property="og:image" content="{img}"><meta property="og:image:width" content="{w}"><meta property="og:image:height" content="{h}">'
    if tw: t += f'<meta name="twitter:card" content="{card}"><meta name="twitter:image" content="{tw}">'
    return f"<!DOCTYPE html><html><head>{t}</head><body>x</body></html>"

D, R = BASE + "og-default.jpg", BASE + "og-roof-buying-season.jpg"

def tree(pages=None, imgs=None):
    pages = pages if pages is not None else {}
    base = {"news/roof-buying-season.html": page(R, R), "index.html": page(D, D)}
    base.update(pages)
    imgs = imgs if imgs is not None else {"og-default.jpg": jpeg(), "og-roof-buying-season.jpg": jpeg()}
    return base, imgs

def run(files, imgs):
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        for n, b in files.items():
            (root / n).parent.mkdir(parents=True, exist_ok=True); (root / n).write_text(b)
        (root / "img/social").mkdir(parents=True)
        for n, b in imgs.items(): (root / "img/social" / n).write_bytes(b)
        r = subprocess.run([sys.executable, str(SCRIPT)], cwd=d, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

f, i = tree()
code, out = run(f, i)
check("CLEAN tree exits 0 and prints ok", code == 0 and out.startswith("ok"))

f, i = tree({"guides/a.html": page("https://otterquote.com/img/brand-assets/otter-quotes-icon-512.png", w="512", h="512")})
code, out = run(f, i)
check("REJECTED: page still on otter-quotes-icon-512.png exits 1 (names the page)", code == 1 and "guides/a.html: og:image still" in out)

f, i = tree({"b.html": page(D, "https://otterquote.com/img/otter-icon-navy.png")})
code, out = run(f, i)
check("REJECTED: twitter:image still on otter-icon-navy.png exits 1", code == 1 and "b.html: twitter:image still" in out)

f, i = tree({"news/roof-buying-season.html": page(D, D)})
code, out = run(f, i)
check("REJECTED: release page on the default image exits 1", code == 1 and "roof-buying-season.html: og:image is not" in out)

f, i = tree({"news/roof-buying-season.html": page(R, R, card="summary")})
code, out = run(f, i)
check("REJECTED: release page twitter:card not summary_large_image exits 1", code == 1 and "twitter:card" in out)

f, i = tree()
del i["og-default.jpg"]
code, out = run(f, i)
check("REJECTED: missing og-default.jpg exits 1", code == 1 and "missing img/social/og-default.jpg" in out)

f, i = tree(imgs={"og-default.jpg": jpeg(512, 512), "og-roof-buying-season.jpg": jpeg()})
code, out = run(f, i)
check("REJECTED: wrong-size image exits 1", code == 1 and "expected (1200, 630)" in out)

f, i = tree(imgs={"og-default.jpg": jpeg(pad=400 * 1024), "og-roof-buying-season.jpg": jpeg()})
code, out = run(f, i)
check("REJECTED: image over 300 KB exits 1", code == 1 and "over 307200" in out)

f, i = tree({"c.html": page(D, w="512", h="512")})
code, out = run(f, i)
check("REJECTED: new image with 512x512 dimensions exits 1", code == 1 and "c.html: og:image dimensions" in out)

if FAILURES:
    print(f"{len(FAILURES)} FAILED"); sys.exit(1)
print("all passed")
