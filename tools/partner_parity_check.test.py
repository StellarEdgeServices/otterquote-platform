#!/usr/bin/env python3
"""
Proof-of-detection test for tools/partner_parity_check.py's per-track D-266
JS-surface check (gh-2020, comment 5737683786 -- the amended closes-on).

WHY THIS EXISTS
----------------
check_js_d266_surfaces() shipped (PR #2028) as a WHOLE-FILE presence test: it
passed as long as the D-266 sentence appeared ANYWHERE in js/router-
discovery.js, with no concept of which referral-fee track it belonged to.
Deleting the disclaimer from exactly ONE track while a sibling track's
occurrence survived left the check at exit 0, PASS, naming nothing -- live,
on production, in the highest-risk copy in the build (CEO RUN 54's refute,
issue comment 5734139109; reproduced independently, comment 5737683786).

Gap 2's OWN closure evidence could not have caught this: control (3) was
demonstrated against a planted fixture with ALL occurrences deleted (the
whole-file-absent case), never the single-track case the criterion actually
names -- js/router-discovery.js did not exist in the tree yet at merge time.
This file is the fixture that reproduces the single-track case for real, the
same class of "a negative control that cannot fail is not a control" this
issue's own earlier verify pass named on the Gap-1 fixture (comment
5732002829) and that recurred here uncaught.

Two runs against an isolated tmp fixture tree, structured like the real
js/router-discovery.js (module.REPO_ROOT is monkeypatched so this never
touches the real repo or the real js/router-discovery.js):
  1. N=2 referral-fee tracks (alpha, beta), each with its own
     RENDERERS['c-<name>-close'] screen and COPY.<name>Close array carrying
     the disclaimer, PLUS a declared-exempt "contractor" track (no close
     screen, listed in JS_D266_EXEMPT_TRACKS) and a "home" track that looks
     like a step sequence but never hands off to a partner (no
     renderPartnerContact call) -- the exact shape of the real c-home-*
     homeowner flow this checker must NOT mistake for a referral-fee track.
  2. Delete exactly ONE track's disclaimer (alpha, then independently beta)
     -- must FAIL, exit reflected in a non-empty failures list, NAMING that
     one track and not its sibling. Restore -- must return to PASS (empty
     failures list). This is the exact pair gh-2020's amended criterion (3)
     requires and PR #2028's fixture could not produce.
  3. Delete BOTH tracks' disclaimers -- the pre-amendment whole-file floor
     (3b) must still fire, on top of both per-track failures.
  4. An undeclared no-close partner track ("gamma": has a contact screen
     calling renderPartnerContact, no close screen, not in
     JS_D266_EXEMPT_TRACKS) must FAIL rather than pass silently -- (3c)'s
     negative direction: an exemption must be declared, not merely absent
     of a failure.

A test that only ever fed the checker the all-occurrences-deleted case would
prove nothing about the single-track hole this issue exists to close; runs
2-4 above are the negative controls that could not have passed before this
file's companion fix to tools/partner_parity_check.py.

Run: python tools/partner_parity_check.test.py
"""
import importlib.util
import pathlib
import shutil
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("partner_parity_check", HERE / "partner_parity_check.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def check_true(label, cond):
    check(label, bool(cond), True)


def check_false(label, cond):
    check(label, bool(cond), False)


D266 = (
    "Check your employment agreement and your governing licensing agency "
    "to make sure it is lawful for you to accept referral fees."
)


def build_fixture_js(alpha_disclaimer=True, beta_disclaimer=True, with_gamma=False):
    """N=2 real referral-fee tracks (alpha, beta) + a declared-exempt
    'contractor' track (same key gh-2020's own JS_D266_EXEMPT_TRACKS uses,
    so this fixture exercises the real exemption entry, not a stand-in) +
    a 'home' distractor track shaped like a step sequence but never handing
    off to a partner -- structurally identical to js/router-discovery.js's
    own RENDERERS['c-<name>-close'] / COPY.<name>Close / renderPartnerContact
    conventions, so the same regexes that parse the real file parse this.
    """
    alpha_close = (
        f"'{D266}'" if alpha_disclaimer else "'Some other closing paragraph.'"
    )
    beta_close = (
        f"'{D266}'" if beta_disclaimer else "'Some other closing paragraph.'"
    )
    gamma_block = ""
    if with_gamma:
        gamma_block = """
  RENDERERS['c-gamma-1'] = function () {
    root.appendChild(continueButton('Continue', function () { go('c-gamma-contact'); }, true));
  };
  RENDERERS['c-gamma-contact'] = function () {
    renderPartnerContact({
      role: 'referral_partner',
      partnerIndustry: 'gamma_agent',
      completeToken: 'c-gamma-contact'
    });
  };
"""
    return f"""// fixture -- structurally mirrors js/router-discovery.js's own conventions
var COPY = {{
    alphaClose: [
      'Alpha intro paragraph, nothing D-266-shaped here.',
      {alpha_close}
    ],
    betaClose: [
      'Beta intro paragraph, nothing D-266-shaped here.',
      {beta_close}
    ]
  }};

  // 'home' distractor: a numbered step sequence, same '-1' shape a partner
  // track's entry screen has, but it never calls renderPartnerContact --
  // this must NOT be treated as a referral-fee track needing D-266.
  RENDERERS['c-home-1'] = function () {{
    root.appendChild(continueButton('Continue', function () {{ go('c-home-2'); }}, true));
  }};
  RENDERERS['c-home-2'] = function () {{
    root.appendChild(continueButton('Continue', function () {{ go('c-home-8'); }}, true));
  }};

  RENDERERS['c-alpha-close'] = function () {{
    COPY.alphaClose.forEach(function (p) {{ root.appendChild(bodyText(p)); }});
    root.appendChild(continueButton('Continue', function () {{ go('c-alpha-contact'); }}, true));
  }};
  RENDERERS['c-alpha-contact'] = function () {{
    renderPartnerContact({{
      role: 'referral_partner',
      partnerIndustry: 'alpha_agent',
      completeToken: 'c-alpha-contact'
    }});
  }};

  RENDERERS['c-beta-close'] = function () {{
    COPY.betaClose.forEach(function (p) {{ root.appendChild(bodyText(p)); }});
    root.appendChild(continueButton('Continue', function () {{ go('c-beta-contact'); }}, true));
  }};
  RENDERERS['c-beta-contact'] = function () {{
    renderPartnerContact({{
      role: 'referral_partner',
      partnerIndustry: 'beta_agent',
      completeToken: 'c-beta-contact'
    }});
  }};

  RENDERERS['c-contractor-1'] = function () {{
    root.appendChild(continueButton('Continue', function () {{ go('c-contractor-contact'); }}, true));
  }};
  RENDERERS['c-contractor-contact'] = function () {{
    renderPartnerContact({{
      role: 'contractor',
      partnerIndustry: null,
      completeToken: 'c-contractor-contact'
    }});
  }};
{gamma_block}"""


def write_fixture(tmp_root, **kwargs):
    js_dir = tmp_root / "js"
    js_dir.mkdir(parents=True, exist_ok=True)
    (js_dir / "router-discovery.js").write_text(build_fixture_js(**kwargs), encoding="utf-8")


def run_js_check(tmp_root):
    """Run check_js_d266_surfaces() with module.REPO_ROOT pointed at tmp_root."""
    original_root = mod.REPO_ROOT
    mod.REPO_ROOT = tmp_root
    try:
        return mod.check_js_d266_surfaces()
    finally:
        mod.REPO_ROOT = original_root


def main():
    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="partnerparity-test-"))
    try:
        print("baseline: N=2 tracks (alpha, beta), both disclaimers present, "
              "'contractor' declared-exempt, 'home' distractor present")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("baseline failures", failures, [])
        check_true(
            "baseline declares the contractor exemption in its own output",
            any("contractor track (c-contractor-*) exempt from D-266" in n for n in notes),
        )
        check_false(
            "baseline never mentions the 'home' distractor track",
            any("home" in f for f in failures) or any("home" in n for n in notes),
        )

        print()
        print("gh-2020 (3): delete ONLY alpha's disclaimer, beta's stays intact "
              "-- this is the exact shape PR #2028's own fixture could not "
              "produce (it deleted all occurrences, not one track's)")
        write_fixture(tmp_root, alpha_disclaimer=False, beta_disclaimer=True)
        failures, notes = run_js_check(tmp_root)
        check("alpha-only-deleted failure count", len(failures), 1)
        check_true(
            "alpha-only-deleted names the alpha track specifically",
            any("alpha track (c-alpha-close) missing D-266 disclaimer" in f for f in failures),
        )
        check_false(
            "alpha-only-deleted does not also blame beta",
            any("beta track" in f for f in failures),
        )

        print()
        print("restore alpha -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-alpha failures", failures, [])

        print()
        print("gh-2020 (3), second pair: delete ONLY beta's disclaimer, alpha's "
              "stays intact -- proves the per-track match is not hardcoded to "
              "one track name")
        write_fixture(tmp_root, alpha_disclaimer=True, beta_disclaimer=False)
        failures, notes = run_js_check(tmp_root)
        check("beta-only-deleted failure count", len(failures), 1)
        check_true(
            "beta-only-deleted names the beta track specifically",
            any("beta track (c-beta-close) missing D-266 disclaimer" in f for f in failures),
        )
        check_false(
            "beta-only-deleted does not also blame alpha",
            any("alpha track" in f for f in failures),
        )

        print()
        print("restore beta -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-beta failures", failures, [])

        print()
        print("gh-2020 (3b): delete BOTH tracks' disclaimers -- the pre-amendment "
              "whole-file floor must still fire, on top of both per-track hits")
        write_fixture(tmp_root, alpha_disclaimer=False, beta_disclaimer=False)
        failures, notes = run_js_check(tmp_root)
        check("both-deleted failure count", len(failures), 3)
        check_true(
            "both-deleted floor check fires",
            any("missing D-266 disclaimer verbatim text" in f and "track" not in f for f in failures),
        )
        check_true(
            "both-deleted names alpha",
            any("alpha track (c-alpha-close)" in f for f in failures),
        )
        check_true(
            "both-deleted names beta",
            any("beta track (c-beta-close)" in f for f in failures),
        )

        print()
        print("restore both -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("fully-restored failures", failures, [])

        print()
        print("gh-2020 (3c), negative direction: an UNDECLARED no-close partner "
              "track ('gamma': hands off via renderPartnerContact, no close "
              "screen, not in JS_D266_EXEMPT_TRACKS) must FAIL, not pass "
              "silently -- an exemption must be declared, never assumed")
        write_fixture(tmp_root, with_gamma=True)
        failures, notes = run_js_check(tmp_root)
        check_true(
            "undeclared gamma track is reported as a failure",
            any(
                "gamma track (c-gamma-contact)" in f and "d266_js_track_undeclared" in f
                for f in failures
            ),
        )
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED -- {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print(
        "partner_parity_check per-track D-266 self-test: all assertions passed "
        "(single-track negative control observed FAILING and NAMING the track; "
        "restored tree observed PASSING; whole-file floor observed FAILING when "
        "both tracks are deleted; undeclared exemption observed FAILING)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
