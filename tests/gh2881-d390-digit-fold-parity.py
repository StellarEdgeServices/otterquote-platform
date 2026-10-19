#!/usr/bin/env python3
"""gh-2881 static check (no database): the digit-fold migration changes PR #2880's d390_redact_contact and bidder_claim_summary statements in exactly
ONE clause (the Unicode fold's translate() list gains U+0660-0669 and U+06F0-06F9 mapped to 0-9), and its rollback restores #2880's statements verbatim."""
import re, sys, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
rd = lambda p: open(os.path.join(ROOT, p)).read()
d = "supabase/migrations_drafts/"
base = rd(d + "gh2559_d390_redact_contact_until_fee.sql")
fwd = rd(d + "gh2881_d390_digit_fold.sql")
rb = rd(d + "gh2881_d390_digit_fold_rollback.sql")
OLD = r"""U&'\0142\0141\00F8\00D8\0131\0111\0110\00F0\0127\0126', 'lLoOidDdhH')"""
NEW = r"""U&'\0142\0141\00F8\00D8\0131\0111\0110\00F0\0127\0126\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9', 'lLoOidDdhH01234567890123456789')"""
def fn(t):
    s = t.index("CREATE OR REPLACE FUNCTION public.d390_redact_contact"); return t[s:t.index("$fn$;", t.index("AS $fn$", s)) + 5]
def vw(t):
    s = t.index("CREATE OR REPLACE VIEW public.bidder_claim_summary")
    m = re.search(r"\n\s*OR EXISTS \(SELECT 1 FROM public\.quotes q WHERE q\.claim_id = c\.id AND q\.contractor_id = ct\.id\);", t[s:])
    return t[s:s + m.end()]
ok = True
def check(c, m):
    global ok
    print(("PASS: " if c else "FAIL: ") + m); ok = ok and c
check(fn(base).count(OLD) == 1 and vw(base).count(OLD) == 5, "#2880 has the old fold clause once in the function and five times in the view")
check(fn(fwd) == fn(base).replace(OLD, NEW), "forward function == #2880 function with the one clause extended")
check(vw(fwd) == vw(base).replace(OLD, NEW), "forward view == #2880 view with the one clause extended (5 places)")
check(fn(fwd).count(NEW) == 1 and vw(fwd).count(NEW) == 5 and OLD not in fn(fwd) + vw(fwd), "no old clause left in the forward statements")
check(fn(rb) == fn(base) and vw(rb) == vw(base), "rollback function and view == #2880 statements verbatim")
import hashlib
body = lambda t: t[t.index("AS $fn$") + 7:t.index("$fn$;")]
m_base = hashlib.md5(body(fn(base)).encode()).hexdigest(); m_new = hashlib.md5(body(fn(fwd)).encode()).hexdigest()
check("P0A91" in fwd and "P0A94" in rb, "both files carry their gate")
check(m_base in fwd and m_new in fwd and m_base in rb and m_new in rb and m_base != m_new, "the guard md5s in both files are the md5 of #2880's function body and of the extended body (%s / %s)" % (m_base[:8], m_new[:8]))
check("P0A95" in fwd and "P0A96" in rb, "both guards refuse a function body that is neither text")
print("DIGIT_FOLD_PARITY:", "PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
