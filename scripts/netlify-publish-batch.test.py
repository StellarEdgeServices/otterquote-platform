#!/usr/bin/env python3
"""
Self-test for .github/workflows/netlify-publish-batch.yml (gh-2389, PR #2394,
fixes for REVIEW: FAIL 5911494004).

It extracts the two embedded python scripts from the workflow ("Publish batch"
and "Re-lock live deploys (always)") and runs them against a FAKE Netlify API
(urllib.request.urlopen is replaced; no network, no writes anywhere).

Every finding has a scenario that must PASS on the current workflow and a
negative control that must FAIL:
  * mutation controls: the current script with the fix surgically removed;
  * old-code controls: the reviewed commit ca3f4438 (read with `git show`, or
    --old-yml PATH; skipped with a NOTE if the object is not available).

USAGE
    python3 scripts/netlify-publish-batch.test.py [--old-yml PATH]
Exit 0 only if every PASS line is a pass and every control failed as required.
"""
import contextlib, io, json, os, pathlib, re, runpy, subprocess, sys, tempfile, textwrap
import time, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
YML_REL = ".github/workflows/netlify-publish-batch.yml"
OLD_SHA = "ca3f4438e883cf526addc13d23d8b3fe590dbb0f"
JADE = "6748a414-1baa-4309-a5f9-f3a7f45e3d94"
APP = "26316673-212a-4f20-a95e-902ece8387c4"
STEP_MAIN = "Publish batch"
STEP_ALWAYS = "Re-lock live deploys (always)"


# ---------------------------------------------------------------- extraction
def extract_step(yml, name):
    """Return (run_script_text, step_block_text) for the step called `name`, or (None, None)."""
    lines = yml.split("\n")
    for i, l in enumerate(lines):
        if re.match(r"\s*- name:\s*" + re.escape(name) + r"\s*$", l):
            base = len(l) - len(l.lstrip())
            j = i + 1
            while j < len(lines) and (not lines[j].strip() or len(lines[j]) - len(lines[j].lstrip()) > base
                                      or lines[j].lstrip().startswith("#")):
                j += 1
            block = lines[i:j]
            for k, bl in enumerate(block):
                if re.match(r"\s*run:\s*\|\s*$", bl):
                    ri = len(bl) - len(bl.lstrip())
                    body = []
                    for x in block[k + 1:]:
                        if x.strip() and len(x) - len(x.lstrip()) <= ri:
                            break
                        body.append(x)
                    return textwrap.dedent("\n".join(body)) + "\n", "\n".join(block)
            return None, "\n".join(block)
    return None, None


def parts_from_yml(yml):
    main, _ = extract_step(yml, STEP_MAIN)
    always, always_block = extract_step(yml, STEP_ALWAYS)
    return {"yml": yml, "main": main, "always": always, "always_block": always_block}


# ---------------------------------------------------------------- fake Netlify
def mk(name):
    P = name[0].upper()
    return {"name": name, "pub": P + "OLD", "locked": True, "deploys": [
        {"id": P + "OLD", "context": "production", "state": "ready", "branch": "main",
         "created_at": "2026-09-30T10:00:00Z", "published_at": "2026-09-30T10:00:05Z"},
        {"id": P + "NEW", "context": "production", "state": "ready", "branch": "main",
         "created_at": "2026-09-30T12:00:00Z", "published_at": None},
        {"id": P + "ERRD", "context": "production", "state": "error", "branch": "main",
         "created_at": "2026-09-30T13:00:00Z", "published_at": None},
        {"id": P + "BR", "context": "production", "state": "ready", "branch": "feature-x",
         "created_at": "2026-09-30T14:00:00Z", "published_at": None},
        {"id": P + "PREV", "context": "deploy-preview", "state": "ready", "branch": "pr-1",
         "created_at": "2026-09-30T15:00:00Z", "published_at": None}]}


def new_sites():
    return {JADE: mk("jade"), APP: mk("app")}


class Resp(io.BytesIO):
    def __init__(self, code, obj):
        super().__init__(json.dumps(obj).encode()); self.status = code
    def __enter__(self): return self
    def __exit__(self, *a): pass


def _rules(spec):
    out = []
    for r in spec:
        out.append([r, 1] if isinstance(r, str) else [r[0], r[1]])  # times=None means always
    return out


def _hit(rules, key):
    for r in rules:
        if re.search(r[0], key) and (r[1] is None or r[1] > 0):
            if r[1] is not None:
                r[1] -= 1
            return True
    return False


def run_script(script, sites, env=None, fail=(), applied_but_500=(), smoke=200):
    """Run `script` against the fake API. Returns (exit_code, output, posts)."""
    posts = []
    fail, a500 = _rules(fail), _rules(applied_but_500)

    def err(url, code):
        return urllib.error.HTTPError(url, code, "x", {}, io.BytesIO(b'{"code":%d}' % code))

    def uo(req, *a, **k):
        url, m = req.full_url, req.get_method()
        if "api.netlify.com" not in url:
            c = smoke(url) if callable(smoke) else smoke
            if c != 200:
                raise err(url, c)
            return Resp(200, {})
        p = url.split("/api/v1")[1]
        key = f"{m} {p}"
        if m == "POST":
            posts.append(p)
        doit = lambda: None
        mm = re.match(r"/deploys/([\w-]+)/(lock|unlock)$", p)
        mr = re.match(r"/sites/([\w-]+)/deploys/([\w-]+)/restore$", p)
        if mm:
            d, op = mm.groups()
            s = next(s for s in sites.values() if any(x["id"] == d for x in s["deploys"]))
            def doit():
                if s["pub"] == d:
                    s["locked"] = (op == "lock")
                elif op == "lock":          # assumption: locking a non-live deploy publishes and locks it
                    s["pub"] = d; s["locked"] = True
        elif mr:
            sid, d = mr.groups(); s = sites[sid]
            def doit():
                s["pub"] = d
                dep = next(x for x in s["deploys"] if x["id"] == d)
                dep["published_at"] = dep.get("published_at") or "2026-09-30T20:00:00Z"
        if _hit(fail, key):
            raise err(url, 500)
        if _hit(a500, key):
            doit(); raise err(url, 500)
        if m == "POST":
            doit(); return Resp(200, {})
        ms = re.match(r"/sites/([\w-]+)$", p)
        if ms:
            s = sites[ms.group(1)]
            d = dict(next(x for x in s["deploys"] if x["id"] == s["pub"])); d["locked"] = s["locked"]
            return Resp(200, {"name": s["name"], "build_settings": {"repo_branch": "main"}, "published_deploy": d})
        ml = re.match(r"/sites/([\w-]+)/deploys", p)
        if ml:  # server ignores the query filters on purpose: the client-side filter must hold
            return Resp(200, [dict(x) for x in sites[ml.group(1)]["deploys"]])
        raise err(url, 404)

    real_uo, real_sleep, real_env = urllib.request.urlopen, time.sleep, dict(os.environ)
    urllib.request.urlopen = uo
    time.sleep = lambda s: None
    os.environ.update(NETLIFY_PAT="fake", DRY_RUN="false", SITES="jade-alpaca-b82b5e,otterquote-app")
    os.environ.update(env or {})
    fd, path = tempfile.mkstemp(suffix=".py"); os.close(fd)
    pathlib.Path(path).write_text(script)
    out, code = io.StringIO(), 0
    try:
        with contextlib.redirect_stdout(out):
            try:
                runpy.run_path(path, run_name="__main__")
            except SystemExit as e:
                code = e.code if isinstance(e.code, int) else 1
    finally:
        urllib.request.urlopen, time.sleep = real_uo, real_sleep
        os.environ.clear(); os.environ.update(real_env); os.unlink(path)
    return code, out.getvalue(), posts


def final(sites):
    return {s["name"]: (s["pub"], "locked" if s["locked"] else "UNLOCKED") for s in sites.values()}


def all_locked(sites):
    return all(s["locked"] for s in sites.values())


# ---------------------------------------------------------------- scenarios
# Each takes the parts dict and returns (ok, detail). ok=True means "behaves correctly".
def need(parts, key):
    if not parts.get(key):
        raise LookupError(f"workflow has no '{key}' script")
    return parts[key]


def sc_dry_run(P):
    st = new_sites()
    code, _, posts = run_script(need(P, "main"), st, env={"DRY_RUN": "true"})
    return code == 0 and not posts, f"exit={code} posts={posts}"


def sc_happy(P):
    st = new_sites()
    code, _, posts = run_script(need(P, "main"), st)
    ok = code == 0 and final(st) == {"jade": ("JNEW", "locked"), "app": ("ANEW", "locked")}
    return ok, f"exit={code} final={final(st)} (ERRD/BR/PREV newer but ignored)"


def sc_smoke_rollback(P):
    st = new_sites()
    code, _, _ = run_script(need(P, "main"), st, smoke=500)
    ok = code != 0 and final(st) == {"jade": ("JOLD", "locked"), "app": ("AOLD", "locked")}
    return ok, f"exit={code} final={final(st)}"


def sc_f1_restore_old_fails(P):   # finding 1: rollback restore(OLD) fails -> NEW live; must end locked
    st = new_sites()
    code, _, _ = run_script(need(P, "main"), st, smoke=503, fail=[r"POST /sites/.*/deploys/.OLD/restore"])
    return code != 0 and all_locked(st), f"exit={code} final={final(st)}"


def sc_f1_lock_old_fails(P):      # finding 1: rollback lock(OLD) fails once -> OLD live; must end locked
    st = new_sites()
    code, _, _ = run_script(need(P, "main"), st, smoke=500, fail=[r"POST /deploys/.OLD/lock"])
    return code != 0 and all_locked(st), f"exit={code} final={final(st)}"


def sc_f2_unlock_applied_500(P):  # finding 2: first unlock applied but returns 5xx; must end locked
    st = new_sites()
    code, _, _ = run_script(need(P, "main"), st, applied_but_500=[r"POST /deploys/.OLD/unlock"])
    return code != 0 and all_locked(st), f"exit={code} final={final(st)}"


def sc_f3_never_republish(P):     # finding 3: a rolled-back broken deploy is not published again
    st = new_sites()
    c1, _, p1 = run_script(need(P, "main"), st, smoke=500)
    c2, _, p2 = run_script(need(P, "main"), st, smoke=500)
    again = [p for p in p2 if "/restore" in p]
    ok = c1 != 0 and again == [] and c2 == 0 and all_locked(st)
    return ok, f"run1 exit={c1} POSTs={len(p1)}; run2 exit={c2} restore POSTs={again}; final={final(st)}"


def sc_f4_always_step(P):         # finding 4: always() step re-locks an unlocked live deploy, idempotently
    st = new_sites()
    st[JADE]["pub"], st[JADE]["locked"] = "JNEW", False    # job died between unlock and lock
    c1, _, p1 = run_script(need(P, "always"), st)
    c2, _, p2 = run_script(need(P, "always"), st)
    blk = P.get("always_block") or ""
    cond = re.search(r"^\s*if:\s*(.*)$", blk, re.M)
    cond_ok = bool(cond) and "always()" in cond.group(1)
    ok = c1 == 0 and all_locked(st) and len(p1) == 1 and p2 == [] and c2 == 0 and cond_ok
    return ok, f"exit={c1} lock POSTs run1={p1} run2={p2} final={final(st)} if={'always()' if cond_ok else cond and cond.group(1) or 'MISSING'}"


def sc_f4_always_fails_loud(P):   # finding 4: if the re-lock itself fails the step exits non-zero
    st = new_sites(); st[APP]["locked"] = False
    code, _, _ = run_script(need(P, "always"), st, fail=[(r"POST /deploys/.*/lock", None)])
    return code != 0, f"exit={code}"


def sc_f5_unlocked_at_start(P):   # finding 5: unlocked at start -> re-locked and run fails
    st = new_sites(); st[JADE]["locked"] = False
    code, out, _ = run_script(need(P, "main"), st)
    ok = code != 0 and st[JADE]["locked"] and st[JADE]["pub"] == "JOLD" and final(st)["app"] == ("ANEW", "locked")
    return ok, f"exit={code} final={final(st)}"


def sc_f5_unlocked_dry(P):        # finding 5: same in dry-run, no writes but still a failure
    st = new_sites(); st[JADE]["locked"] = False
    code, _, posts = run_script(need(P, "main"), st, env={"DRY_RUN": "true"})
    return code != 0 and posts == [], f"exit={code} posts={posts}"


def sc_get_error_isolated(P):
    st = new_sites()
    code, _, _ = run_script(need(P, "main"), st, fail=[(rf"GET /sites/{JADE}$", None)])
    return code != 0 and final(st) == {"jade": ("JOLD", "locked"), "app": ("ANEW", "locked")}, f"exit={code} final={final(st)}"


def sc_f7_comment(P):             # finding 7: comment must not claim the spec lacks the filters
    y = P["yml"]
    ok = "does not list them" not in y and "listSiteDeploys" in y
    return ok, "comment cites listSiteDeploys filters, no 'does not list them' claim" if ok else "wrong API-filter comment present"


# id, finding, scenario, must-pass-on-current
SCENARIOS = [
    ("dry-run", "-", sc_dry_run),
    ("happy-path", "-", sc_happy),
    ("smoke-500-rollback", "-", sc_smoke_rollback),
    ("site-GET-500-isolated", "-", sc_get_error_isolated),
    ("F1a rollback restore(OLD) fails", "1", sc_f1_restore_old_fails),
    ("F1b rollback lock(OLD) fails", "1", sc_f1_lock_old_fails),
    ("F2 unlock applied-but-5xx", "2", sc_f2_unlock_applied_500),
    ("F3 never republish rolled-back deploy", "3", sc_f3_never_republish),
    ("F4a always() step re-locks, idempotent", "4", sc_f4_always_step),
    ("F4b always() step fails loud", "4", sc_f4_always_fails_loud),
    ("F5a unlocked at start fails run", "5", sc_f5_unlocked_at_start),
    ("F5b unlocked at start (dry-run) fails", "5", sc_f5_unlocked_dry),
    ("F7 API-filter comment", "7", sc_f7_comment),
]
BY_ID = {s[0]: s for s in SCENARIOS}


def attempt(fn, parts):
    try:
        return fn(parts)
    except LookupError as e:
        return False, str(e)
    except Exception as e:  # a crashing script is a failing scenario
        return False, f"{type(e).__name__}: {e}"


# ---------------------------------------------------------------- mutation controls
def mut(parts, key, old, new, count=1):
    p = dict(parts)
    if key == "always_block":
        p[key] = parts[key].replace(old, new)
        assert p[key] != parts[key], f"mutation did not apply to {key}: {old!r}"
        return p
    assert old in parts[key], f"mutation did not apply to {key}: {old!r}"
    p[key] = parts[key].replace(old, new)
    return p


def _no_relock(P):
    p = dict(P)
    s = P["main"]
    old = "            relock_live(site_id)\n    except Exception as e:"
    assert old in s, "mutation did not apply: finally relock"
    p["main"] = s.replace(old, "            pass\n    except Exception as e:")
    return p


MUTANTS = [  # (finding, description, mutate, scenario ids that must now FAIL)
    ("1,2", "remove the try/finally relock_live around unlock..rollback", _no_relock,
     ["F1a rollback restore(OLD) fails", "F1b rollback lock(OLD) fails", "F2 unlock applied-but-5xx"]),
    ("3", "drop the never-published filter (published_at)",
     lambda P: mut(P, "main", ' and not d.get("published_at")', ""),
     ["F3 never republish rolled-back deploy"]),
    ("4", "always() step does not lock",
     lambda P: mut(P, "always", """must("POST", f"/deploys/{pd['id']}/lock")""", "pass"),
     ["F4a always() step re-locks, idempotent", "F4b always() step fails loud"]),
    ("4", "always() step loses its `if: always()` condition",
     lambda P: mut(P, "always_block", "always() && ", ""),
     ["F4a always() step re-locks, idempotent"]),
    ("5", "unlocked-at-start only prints instead of failing",
     lambda P: mut(P, "main", 'raise RuntimeError("site was UNLOCKED at start', 'print("site was UNLOCKED at start'),
     ["F5a unlocked at start fails run", "F5b unlocked at start (dry-run) fails"]),
    ("7", "restore the wrong comment",
     lambda P: mut(P, "yml", "The OpenAPI spec lists these", "The OpenAPI spec does not list them; these"),
     ["F7 API-filter comment"]),
]


# ---------------------------------------------------------------- old-code source
def load_old(argv):
    if "--old-yml" in argv:
        return pathlib.Path(argv[argv.index("--old-yml") + 1]).read_text(), "file"
    r = subprocess.run(["git", "show", f"{OLD_SHA}:{YML_REL}"], cwd=ROOT, capture_output=True, text=True)
    return (r.stdout, "git " + OLD_SHA[:8]) if r.returncode == 0 and r.stdout else (None, None)


def main(argv):
    yml = (ROOT / YML_REL).read_text()
    cur = parts_from_yml(yml)
    bad = 0

    def line(ok, tag, name, detail):
        nonlocal bad
        if not ok:
            bad += 1
        print(f"{'PASS' if ok else 'FAIL'} {tag} {name} -- {detail}")

    print("== current workflow: every scenario must behave correctly")
    for sid, finding, fn in SCENARIOS:
        ok, d = attempt(fn, cur)
        line(ok, f"[finding {finding}]", sid, d)

    print("== negative controls (mutation): the scenario must FAIL once the fix is removed")
    for finding, desc, mutate, must_fail in MUTANTS:
        try:
            mp = mutate(cur)
        except AssertionError as e:
            line(False, f"[finding {finding}]", f"mutant '{desc}'", str(e)); continue
        for sid in must_fail:
            ok, d = attempt(BY_ID[sid][2], mp)
            line(not ok, f"[finding {finding}]", f"control '{desc}' => '{sid}' fails", f"scenario returned ok={ok}: {d}")

    old_yml, src = load_old(argv)
    if old_yml is None:
        print(f"NOTE old-code controls skipped: commit {OLD_SHA[:8]} not available (pass --old-yml PATH)")
    else:
        print(f"== negative controls (old code, {src}): every finding scenario must FAIL on the reviewed version")
        old = parts_from_yml(old_yml)
        for sid, finding, fn in SCENARIOS:
            if finding == "-":
                ok, d = attempt(fn, old)
                line(ok, "[old code, sanity]", f"'{sid}' passes on old code too", d)
            else:
                ok, d = attempt(fn, old)
                line(not ok, f"[finding {finding}]", f"old code fails '{sid}'", f"scenario returned ok={ok}: {d}")

    print(f"{'ALL PASS' if not bad else 'FAILURES: ' + str(bad)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
