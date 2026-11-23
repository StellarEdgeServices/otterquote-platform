#!/usr/bin/env python3
"""gh-3380 S-5: put the answer-first opening ahead of the author byline block on the bylined guides.

PR #3616 (gh-3377) wrote the byline into the page hero, between the h1 and the article body, so on 41 guides the first
text block after the title is "By Dustin Stohler and Sloane ..." and the opening paragraph comes second. This script
MOVES that existing block (same bytes, nothing added, removed or reworded) to sit directly after the opening block.

Four page shapes carry the block; each is handled by one function:
  A  <p class="meta"> in .page-hero        -> after the closing </div> of <div class="article-intro">   (36 guides)
  C  <div class="meta"> in .page-hero      -> after the closing </div> of <div class="article-intro">   (3 guides)
  B  <div class="article-meta"> in hero    -> after the "<!-- Intro -->" article-section                 (1 guide)
  D  first <p class="sub"> (tool page)     -> after the next <p class="sub"> (the tool's own opening)    (1 page)
Shapes A and C also get their existing hero rule `.page-hero .meta` extended with `.article-body > .meta` so the line keeps its type size/colour.
Run: python3 scripts/gh3380_byline_after_intro.py [--check]   (--check changes nothing; exits 1 if any page still needs the move)
"""
import glob, os, re, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
BY = 'Dustin Stohler</a> and <a href="/about.html#sloane"'

def block_end(s, start, tag):
    """index just past the </tag> that closes the <tag ...> opening at `start` (counts nesting of the same tag)."""
    op, cl = re.compile(r'<%s\b' % tag), re.compile(r'</%s>' % tag)
    depth, i = 0, start
    while True:
        o, c = op.search(s, i), cl.search(s, i)
        if c is None: raise ValueError('unbalanced <%s>' % tag)
        if o and o.start() < c.start(): depth += 1; i = o.end()
        else:
            depth -= 1; i = c.end()
            if depth == 0: return i

def cut_line_block(s, start, end):
    """remove s[start:end] plus the leading indentation before it and the newline after it; return (new_s, block_text)"""
    ls = s.rfind('\n', 0, start) + 1
    le = end + 1 if s[end:end + 1] == '\n' else end
    return s[:ls] + s[le:], s[start:end], s[ls:start]

def move(s):
    if BY not in s: return s, None
    # ---- shape D: tool page (byline is the first <p class="sub">, the tool's own opening is the next one)
    SUB = re.compile(r'<p class="sub">(?!By )[^\n]*?</p>')
    m = re.search(r'<p class="sub">By <a href="/about.html"[^\n]*?</p>', s)
    if m and '<div class="article-intro">' not in s and 'class="article-meta"' not in s:
        first_other = SUB.search(s)
        if first_other is None or first_other.start() < m.start(): return s, None   # already after the opening
        blk = m.group(0); ls = s.rfind('\n', 0, m.start()) + 1; ind = s[ls:m.start()]
        t = s[:ls] + s[m.end() + 1:]
        n2 = SUB.search(t, ls)
        if n2 is None: raise ValueError('D: no following sub paragraph')
        return t[:n2.end()] + '\n' + ind + blk + t[n2.end():], 'D'
    # ---- shape B: article-meta (how-to-choose-contractor)
    m = re.search(r'<div class="article-meta">', s)
    if m:
        if m.start() > s.index('<!-- Intro -->'): return s, None   # already after the intro
        end = block_end(s, m.start(), 'div')
        t, blk, ind = cut_line_block(s, m.start(), end)
        i = t.index('<!-- Intro -->'); j = t.index('<div class="article-section">', i)
        k = block_end(t, j, 'div')
        return t[:k] + '\n\n' + ind + blk + t[k:], 'B'
    # ---- shapes A and C: meta in the hero
    h = re.search(r'<section class="page-hero">.*?</section>', s, re.S)
    m = re.compile(r'<(p|div) class="meta">').search(s, h.start(), h.end())
    if not m: return s, None   # byline no longer in the hero: already moved
    tag = m.group(1)
    end = block_end(s, m.start(), tag)
    t, blk, ind = cut_line_block(s, m.start(), end)
    i = t.index('<div class="article-intro">'); k = block_end(t, i, 'div')
    ind2 = t[t.rfind('\n', 0, i) + 1:i]
    t = t[:k] + '\n\n' + ind2 + blk + t[k:]
    old = '.page-hero .meta {'
    if t.count(old) != 1: raise ValueError('expected one .page-hero .meta rule, found %d' % t.count(old))
    t = t.replace(old, '.page-hero .meta,\n.article-body > .meta {')
    return t, 'A' if tag == 'p' else 'C'

def main():
    check = '--check' in sys.argv
    todo, done = [], 0
    for f in sorted(glob.glob(os.path.join(ROOT, 'guides', '*.html'))):
        s = open(f, encoding='utf8', newline='').read()
        if BY not in s: continue
        # already moved? the byline then sits after the opening block: not inside the hero / not before the first article-intro
        t, shape = move(s)
        if t == s: continue
        todo.append((os.path.relpath(f, ROOT), shape))
        if not check: open(f, 'w', encoding='utf8', newline='').write(t)
    for r, sh in todo: print(('NEEDS MOVE ' if check else 'MOVED ') + sh + ' ' + r)
    print('%d page(s) %s' % (len(todo), 'need the move' if check else 'moved'))
    sys.exit(1 if (check and todo) else 0)

if __name__ == '__main__': main()
