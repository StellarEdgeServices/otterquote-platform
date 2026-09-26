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

UPDATE (PR #2038 second refuter, comment 5779401001, head 3ca3f207): nine
more silent passes were found and closed, each with its own fixture below:
  - N8/N9: an HTML disclaimer inside `hidden` or inline
    display:none/visibility:hidden no longer counts as present.
  - N13: a step upstream of a close screen repointed straight at the
    contact screen (skipping the close screen) is now unreachable-flagged.
  - N15: a close screen's forEach given a filter/index parameter (so it
    silently drops the disclaimer paragraph while the array text still has
    it) is now flagged as unverifiable.
  - N19: a registered JS surface (js/router-discovery.js) going missing is
    now a FAILURE, not a NOTE; and js/** subfolders (not just top-level
    js/*.js) are scanned for unmapped fee-bearing surfaces.
  - N20/N21/N22: D266_PAGES now globs every partner-*.html page (was
    partner-insurance*.html only), explicitly registers refer-a-friend.html,
    and falls back to a content-driven census (any *.html page whose own
    text carries a referral-fee sentence) as a fail-closed backstop
    independent of filename.
  - N23: a track that renders its fee sentence in some screen OTHER than a
    c-<name>-close renderer, with its own contact function instead of
    renderPartnerContact(...), is now discovered and flagged.
Every fixture below was also run against the checker at the previous PR
head (3ca3f207, the version this update starts from) as a negative
control: each one passes there (proving the gap was real) and fails here
(proving the fix closes it) -- see the PR comment for the reproduction
table.

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


def build_fixture_js(
    alpha_disclaimer=True,
    beta_disclaimer=True,
    with_gamma=False,
    alpha_entry_target="c-alpha-close",
    alpha_foreach_filtered=False,
    with_lender=False,
    lender_variant="inline",
):
    """N=2 real referral-fee tracks (alpha, beta) + a declared-exempt
    'contractor' track (same key gh-2020's own JS_D266_EXEMPT_TRACKS uses,
    so this fixture exercises the real exemption entry, not a stand-in) +
    a 'home' distractor track shaped like a step sequence but never handing
    off to a partner -- structurally identical to js/router-discovery.js's
    own RENDERERS['c-<name>-close'] / COPY.<name>Close / renderPartnerContact
    conventions, so the same regexes that parse the real file parse this.

    alpha_entry_target: the id 'c-alpha-entry' navigates to on Continue.
    Defaults to alpha's own close screen (the honest shape, matching
    js/router-discovery.js's real c-ins-7 -> go('c-ins-close') pattern);
    the refuter's N13 bypass (comment 5779401001) is reproduced by pointing
    it at 'c-alpha-contact' instead, skipping the close screen entirely.

    alpha_foreach_filtered: when True, alpha's close screen forEach takes a
    (p, i) callback and skips index 1 (the disclaimer paragraph) --
    reproduces the refuter's N15 bypass.

    with_lender: adds an undiscoverable 'lender' track (N23) -- a fee
    sentence rendered directly in a screen body, with its own contact
    function instead of renderPartnerContact(...), so it has no close
    screen, no COPY.<name>Close.forEach( convention, and no
    renderPartnerContact(...) call for layers 2/3 to find it by.
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
    lender_block = ""
    lender_copy = ""
    lender_copy_comma = ""
    if with_lender:
        # gh-2020 REVIEW: FAIL (comment 5780386929) X11/X12/X13/N23c: layer 4
        # (fee-sentence track discovery) only ever saw an inline bodyText()
        # string. `lender_variant` reproduces the other real shapes this
        # module's own tracks use for their fee copy:
        #   inline        -- original N23 (bodyText string literal)
        #   array         -- X11: COPY.lenderIntro = ['...', '$200 ...
        #                    referral ...'], rendered via
        #                    COPY.lenderIntro.forEach(...) -- the same idiom
        #                    every real close screen in this file uses.
        #                    Layer 4 used to resolve only single-quoted
        #                    SCALAR `key: '...'` values, never a COPY array.
        #   scalar_double -- X12: a double-quoted scalar
        #                    (`lenderFee: "$200 ... referral ..."`) -- layer
        #                    4's scalar regex only matched single quotes.
        #   spelled_out   -- X13: the fee amount spelled out in words
        #                    ("Two hundred dollars for every referral...")
        #                    with no `$` at all.
        #   n23c          -- the approved fee copy's OWN first sentence,
        #                    "$200 when a homeowner you refer completes a
        #                    project of $10,000 or more." -- contains
        #                    "refer", not "referral".
        if lender_variant == "array":
            lender_copy = "  lenderIntro: ['$200 when a borrower you refer sends us a completed loan.']\n"
            lender_render = (
                "COPY.lenderIntro.forEach(function (p) { root.appendChild(bodyText(p)); });"
            )
        elif lender_variant == "scalar_double":
            lender_copy = '  lenderFee: "$200 when a borrower you refer sends us a completed loan."\n'
            lender_render = "root.appendChild(bodyText(COPY.lenderFee));"
        elif lender_variant == "spelled_out":
            lender_copy = ""
            lender_render = (
                "root.appendChild(bodyText("
                "'Two hundred dollars for every referral you send us.'));"
            )
        elif lender_variant == "n23c":
            lender_copy = ""
            lender_render = (
                "root.appendChild(bodyText("
                "'$200 when a homeowner you refer completes a project of "
                "$10,000 or more.'));"
            )
        else:  # "inline" -- original N23
            lender_copy = ""
            lender_render = (
                "root.appendChild(bodyText("
                "'You will earn $200 for every referral you send us.'));"
            )
        lender_block = f"""
  RENDERERS['c-lender-1'] = function () {{
    {lender_render}
    root.appendChild(continueButton('Continue', function () {{ go('c-lender-contact'); }}, true));
  }};
  RENDERERS['c-lender-contact'] = function () {{
    renderLenderContact({{
      partnerIndustry: 'lender_agent',
      completeToken: 'c-lender-contact'
    }});
  }};
"""
        if lender_copy:
            lender_copy_comma = ","
            lender_copy = f"    {lender_copy.strip()}\n"

    if alpha_foreach_filtered:
        alpha_foreach = (
            "COPY.alphaClose.forEach(function (p, i) { "
            "if (i !== 1) { root.appendChild(bodyText(p)); } });"
        )
    else:
        alpha_foreach = (
            "COPY.alphaClose.forEach(function (p) { root.appendChild(bodyText(p)); });"
        )
    return f"""// fixture -- structurally mirrors js/router-discovery.js's own conventions
var COPY = {{
    alphaClose: [
      'Alpha intro paragraph, nothing D-266-shaped here.',
      {alpha_close}
    ],
    betaClose: [
      'Beta intro paragraph, nothing D-266-shaped here.',
      {beta_close}
    ]{lender_copy_comma}
{lender_copy}  }};

  // 'home' distractor: a numbered step sequence, same '-1' shape a partner
  // track's entry screen has, but it never calls renderPartnerContact --
  // this must NOT be treated as a referral-fee track needing D-266.
  RENDERERS['c-home-1'] = function () {{
    root.appendChild(continueButton('Continue', function () {{ go('c-home-2'); }}, true));
  }};
  RENDERERS['c-home-2'] = function () {{
    root.appendChild(continueButton('Continue', function () {{ go('c-home-8'); }}, true));
  }};

  // Entry screens -- exist so the close screens below are actually
  // reachable via a go(...) call, matching js/router-discovery.js's own
  // c-ins-7 -> go('c-ins-close') / c-realtor-4 -> go('c-realtor-close')
  // shape. alpha_entry_target lets a test point this at 'c-alpha-contact'
  // instead, reproducing the N13 close-screen-skip bypass.
  RENDERERS['c-alpha-entry'] = function () {{
    root.appendChild(continueButton('Continue', function () {{ go('{alpha_entry_target}'); }}, true));
  }};
  RENDERERS['c-beta-entry'] = function () {{
    root.appendChild(continueButton('Continue', function () {{ go('c-beta-close'); }}, true));
  }};

  RENDERERS['c-alpha-close'] = function () {{
    {alpha_foreach}
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
{gamma_block}{lender_block}"""


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

        print()
        print("gh-2020 refuter bypass 1/(7): the disclaimer sentence is commented "
              "out IN PLACE inside alpha's copy array (// DISABLED ...) -- the "
              "sentence substring is still literally in the file, so a checker "
              "that does not strip comments before comparing wrongly sees it as "
              "present; must FAIL, naming alpha")
        commented_js = build_fixture_js().replace(
            f"'{D266}'",
            f"// DISABLED pending legal re-review: '{D266}'",
            1,
        )
        (tmp_root / "js" / "router-discovery.js").write_text(commented_js, encoding="utf-8")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "bypass 1: commented-out disclaimer is treated as ABSENT, alpha named",
            any("alpha track (c-alpha-close) missing D-266 disclaimer" in f for f in failures),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-bypass-1 failures", failures, [])

        print()
        print("gh-2020 refuter bypass 1b/(7): check_d266_disclaimer() directly on "
              "an HTML page whose disclaimer is wrapped in <!-- --> -- must "
              "return False, not True (a commented-out disclaimer never rendered "
              "to a visitor is not '\"present\"')")
        html_commented = (
            "<p>Some intro copy.</p>\n"
            f"<!-- <p class=\"gate-disclaimer\">{D266}</p> -->\n"
            "<p>Some outro copy.</p>\n"
        )
        check_false(
            "bypass 1b: HTML-commented disclaimer does not satisfy check_d266_disclaimer",
            mod.check_d266_disclaimer(html_commented),
        )
        html_live = f"<p class=\"gate-disclaimer\">{D266}</p>"
        check_true(
            "sanity: an UN-commented disclaimer still satisfies check_d266_disclaimer",
            mod.check_d266_disclaimer(html_live),
        )

        print()
        print("gh-2020 refuter bypass 2/(7): a leftover dead COPY.alphaCloseV1 "
              "array (itself real JS, not commented, still carrying the "
              "sentence) plus a commented-out reference to it placed ahead of "
              "the REAL forEach call inside c-alpha-close -- the real, live "
              "alphaClose array's own disclaimer is removed; must FAIL naming "
              "alpha, not be fooled by the dead array")
        js = build_fixture_js(alpha_disclaimer=False)
        js = js.replace(
            "var COPY = {\n",
            (
                "var COPY = {\n"
                "    alphaCloseV1: [\n"
                f"      'Old v1 copy, no longer rendered by anything live.',\n"
                f"      '{D266}'\n"
                "    ],\n"
            ),
            1,
        )
        js = js.replace(
            "    COPY.alphaClose.forEach(function (p) { root.appendChild(bodyText(p)); });",
            (
                "    // superseded, kept for reference: "
                "COPY.alphaCloseV1.forEach(function (p) { root.appendChild(bodyText(p)); });\n"
                "    COPY.alphaClose.forEach(function (p) { root.appendChild(bodyText(p)); });"
            ),
            1,
        )
        (tmp_root / "js" / "router-discovery.js").write_text(js, encoding="utf-8")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "bypass 2: dead decoy array does not satisfy the real alpha track, alpha named",
            any("alpha track (c-alpha-close) missing D-266 disclaimer" in f for f in failures),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-bypass-2 failures", failures, [])

        print()
        print("gh-2020 refuter bypass 3/(6): convert c-alpha-close AND "
              "c-alpha-contact to arrow functions -- both structural regexes "
              "(which require the literal 'function' keyword) miss the track "
              "entirely; must FAIL CLOSED (not pass silently with nothing "
              "printed)")
        js = build_fixture_js()
        js = js.replace(
            "  RENDERERS['c-alpha-close'] = function () {\n"
            "    COPY.alphaClose.forEach(function (p) { root.appendChild(bodyText(p)); });\n"
            "    root.appendChild(continueButton('Continue', function () { go('c-alpha-contact'); }, true));\n"
            "  };",
            "  RENDERERS['c-alpha-close'] = () => {\n"
            "    COPY.alphaClose.forEach((p) => { root.appendChild(bodyText(p)); });\n"
            "    root.appendChild(continueButton('Continue', () => { go('c-alpha-contact'); }, true));\n"
            "  };",
            1,
        )
        js = js.replace(
            "  RENDERERS['c-alpha-contact'] = function () {\n"
            "    renderPartnerContact({\n"
            "      role: 'referral_partner',\n"
            "      partnerIndustry: 'alpha_agent',\n"
            "      completeToken: 'c-alpha-contact'\n"
            "    });\n"
            "  };",
            "  RENDERERS['c-alpha-contact'] = () => {\n"
            "    renderPartnerContact({\n"
            "      role: 'referral_partner',\n"
            "      partnerIndustry: 'alpha_agent',\n"
            "      completeToken: 'c-alpha-contact'\n"
            "    });\n"
            "  };",
            1,
        )
        (tmp_root / "js" / "router-discovery.js").write_text(js, encoding="utf-8")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "bypass 3: arrow-converted alpha track fails closed (unrecognized), not silent",
            any(
                "COPY.alphaClose.forEach(" in f and "d266_js_track_unrecognized" in f
                for f in failures
            ),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-bypass-3 failures", failures, [])

        print()
        print("gh-2020 refuter bypass 5/(6): reindent EVERY renderer closer "
              "('\\n  };' -> '\\n};', simulating a whole-file formatter pass) "
              "-- the non-greedy RENDERERS regex can no longer find any close "
              "screen at all; must FAIL CLOSED for every discovered track, not "
              "just print a NOTE and exit clean")
        js = build_fixture_js().replace("\n  };", "\n};")
        (tmp_root / "js" / "router-discovery.js").write_text(js, encoding="utf-8")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "bypass 5: reindented file fails closed naming alpha",
            any(
                "COPY.alphaClose.forEach(" in f and "d266_js_track_unrecognized" in f
                for f in failures
            ),
        )
        check_true(
            "bypass 5: reindented file fails closed naming beta too",
            any(
                "COPY.betaClose.forEach(" in f and "d266_js_track_unrecognized" in f
                for f in failures
            ),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-bypass-5 failures", failures, [])

        print()
        print("gh-2020 refuter bypass 6/(7): a decoy alphaClose: [ '<sentence>' "
              "] duplicate COPY key placed EARLIER in the file -- JS itself "
              "resolves the LATER key as authoritative (later key wins), and "
              "that real, later, live array's own disclaimer is removed; the "
              "scope lookup must be bound to the renderer's own (last) array, "
              "not re-grep the whole file by name -- must FAIL naming alpha")
        js = build_fixture_js(alpha_disclaimer=False)
        js = js.replace(
            "var COPY = {\n",
            (
                "var COPY = {\n"
                "    alphaClose: [\n"
                "      'DECOY: this is not the real alphaClose array.',\n"
                f"      '{D266}'\n"
                "    ],\n"
            ),
            1,
        )
        (tmp_root / "js" / "router-discovery.js").write_text(js, encoding="utf-8")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "bypass 6: an earlier decoy alphaClose array does not satisfy the real (later) one, alpha named",
            any("alpha track (c-alpha-close) missing D-266 disclaimer" in f for f in failures),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-bypass-6 failures", failures, [])

        # ── PR #2038 second refuter (comment 5779401001), nine more bypasses ──

        print()
        print("gh-2020 refuter N13: 'c-alpha-entry' repointed straight at "
              "'c-alpha-contact', skipping 'c-alpha-close' entirely -- the "
              "close screen and its disclaimer array are untouched and pass "
              "every check above, but nothing in the file navigates to them; "
              "must FAIL as unreachable")
        write_fixture(tmp_root, alpha_entry_target="c-alpha-contact")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "N13: alpha close screen flagged unreachable when entry skips it",
            any("c-alpha-close" in f and "d266_js_close_unreachable" in f for f in failures),
        )
        check_false(
            "N13: beta (unaffected) is not flagged unreachable",
            any("c-beta-close" in f and "d266_js_close_unreachable" in f for f in failures),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-N13 failures", failures, [])

        print()
        print("gh-2020 refuter N15: 'c-alpha-close' forEach given an index "
              "parameter and a filter that skips the disclaimer paragraph "
              "(function (p, i) { if (i !== 1) ... }) -- the array text "
              "still carries the disclaimer, so the content check alone "
              "would pass; must FAIL as an unverified/filtered forEach")
        write_fixture(tmp_root, alpha_foreach_filtered=True)
        failures, notes = run_js_check(tmp_root)
        check_true(
            "N15: filtered alpha forEach flagged as unverifiable",
            any(
                "c-alpha-close" in f and "d266_js_close_foreach_filtered" in f
                for f in failures
            ),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-N15 failures", failures, [])

        print()
        print("gh-2020 refuter N23: a new 'lender' track renders its fee "
              "sentence directly in 'c-lender-1' and hands off through its "
              "own renderLenderContact(...) instead of "
              "renderPartnerContact(...) -- invisible to layers 2 and 3; "
              "must FAIL as an unrecognized fee-sentence track")
        write_fixture(tmp_root, with_lender=True)
        failures, notes = run_js_check(tmp_root)
        check_true(
            "N23: undeclared fee-sentence 'lender' track is reported as a failure",
            any(
                "c-lender-*" in f and "d266_js_fee_sentence_unrecognized_track" in f
                for f in failures
            ),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-N23 failures", failures, [])

        print()
        print("gh-2020 REVIEW: FAIL (comment 5780386929) N23c: the 'lender' "
              "track renders only the APPROVED fee sentence's own first "
              "clause, '$200 when a homeowner you refer completes a project "
              "of $10,000 or more.' -- it contains 'refer', not 'referral', "
              "which the old FEE_SENTENCE_RE required; must still FAIL as "
              "an unrecognized fee-sentence track")
        write_fixture(tmp_root, with_lender=True, lender_variant="n23c")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "N23c: 'refer' (not 'referral') fee sentence is reported as a failure",
            any(
                "c-lender-*" in f and "d266_js_fee_sentence_unrecognized_track" in f
                for f in failures
            ),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-N23c failures", failures, [])

        print()
        print("gh-2020 REVIEW: FAIL (comment 5780386929) X11: the 'lender' "
              "track's fee sentence lives in a COPY ARRAY (COPY.lenderIntro "
              "= [...]), rendered via COPY.lenderIntro.forEach(...) -- the "
              "same idiom every real close screen in this file uses for its "
              "own fee copy. Layer 4 used to resolve only a single-quoted "
              "SCALAR `key: '...'`, never a COPY array; must FAIL")
        write_fixture(tmp_root, with_lender=True, lender_variant="array")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "X11: COPY-array fee sentence is reported as a failure",
            any(
                "c-lender-*" in f and "d266_js_fee_sentence_unrecognized_track" in f
                for f in failures
            ),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-X11 failures", failures, [])

        print()
        print("gh-2020 REVIEW: FAIL (comment 5780386929) X12: same shape as "
              "X11, but the fee sentence is a DOUBLE-quoted scalar "
              "(lenderFee: \"$200 ... refer ...\") -- layer 4's scalar regex "
              "only matched single quotes; must FAIL")
        write_fixture(tmp_root, with_lender=True, lender_variant="scalar_double")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "X12: double-quoted scalar fee sentence is reported as a failure",
            any(
                "c-lender-*" in f and "d266_js_fee_sentence_unrecognized_track" in f
                for f in failures
            ),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-X12 failures", failures, [])

        print()
        print("gh-2020 REVIEW: FAIL (comment 5780386929) X13: the 'lender' "
              "track's fee amount is spelled out in words ('Two hundred "
              "dollars for every referral...') with no '$' at all; must FAIL")
        write_fixture(tmp_root, with_lender=True, lender_variant="spelled_out")
        failures, notes = run_js_check(tmp_root)
        check_true(
            "X13: spelled-out fee amount is reported as a failure",
            any(
                "c-lender-*" in f and "d266_js_fee_sentence_unrecognized_track" in f
                for f in failures
            ),
        )

        print()
        print("restore -- must return to PASS")
        write_fixture(tmp_root)
        failures, notes = run_js_check(tmp_root)
        check("restored-after-X13 failures", failures, [])

        print()
        print("gh-2020 refuter N19a: the registered surface "
              "js/router-discovery.js is simply ABSENT from the tree (moved, "
              "renamed, or deleted) -- must FAIL, not print a tolerant NOTE "
              "and exit clean")
        empty_root = pathlib.Path(tempfile.mkdtemp(prefix="partnerparity-test-empty-"))
        try:
            failures, notes = run_js_check(empty_root)
            check_true(
                "N19a: missing registered JS surface is a FAILURE",
                any("d266_js_surface_missing" in f for f in failures),
            )
            check_false(
                "N19a: missing registered JS surface is not merely a NOTE",
                any("d266_js_surface_missing" in n for n in notes),
            )
        finally:
            shutil.rmtree(empty_root, ignore_errors=True)

        print()
        print("gh-2020 refuter N19b: a fee-bearing JS file living in a js/ "
              "SUBFOLDER (simulating js/router-discovery.js having been "
              "moved to js/router/discovery.js) must be discovered by "
              "find_unmapped_static_funnels(), which used to scan top-level "
              "js/*.js only; js/vendor/ stays excluded")
        subfolder_root = pathlib.Path(tempfile.mkdtemp(prefix="partnerparity-test-subjs-"))
        try:
            router_dir = subfolder_root / "js" / "router"
            router_dir.mkdir(parents=True, exist_ok=True)
            (router_dir / "discovery.js").write_text(
                "// moved module\nvar msg = 'referral fee: $200 per completed job';\n",
                encoding="utf-8",
            )
            vendor_dir = subfolder_root / "js" / "vendor"
            vendor_dir.mkdir(parents=True, exist_ok=True)
            (vendor_dir / "qrcode-generator.js").write_text(
                "// third-party, no fee text, but harmless if it did\n",
                encoding="utf-8",
            )
            findings = mod.find_unmapped_static_funnels(subfolder_root)
            check_true(
                "N19b: fee-bearing JS in a js/ subfolder is discovered as unmapped",
                any("js/router/discovery.js" in f for f in findings),
            )
            check_false(
                "N19b: js/vendor/ is not scanned",
                any("vendor" in f for f in findings),
            )
        finally:
            shutil.rmtree(subfolder_root, ignore_errors=True)

        print()
        print("gh-2020 refuter N8: check_d266_disclaimer() on an HTML page "
              "whose disclaimer <p> carries the `hidden` attribute -- must "
              "return False (hidden means never visible to a partner)")
        html_hidden_attr = (
            "<p>Some intro copy.</p>\n"
            f'<p class="gate-disclaimer" hidden>{D266}</p>\n'
            "<p>Some outro copy.</p>\n"
        )
        check_false(
            "N8: hidden-attribute disclaimer does not satisfy check_d266_disclaimer",
            mod.check_d266_disclaimer(html_hidden_attr),
        )

        print()
        print("gh-2020 refuter N9: disclaimer <p> given an inline "
              "style=\"display:none\" (and, independently, "
              "visibility:hidden) -- must return False for both")
        html_display_none = (
            "<p>Some intro copy.</p>\n"
            f'<p class="gate-disclaimer" style="display:none; color: red;">{D266}</p>\n'
            "<p>Some outro copy.</p>\n"
        )
        check_false(
            "N9: display:none disclaimer does not satisfy check_d266_disclaimer",
            mod.check_d266_disclaimer(html_display_none),
        )
        html_visibility_hidden = f'<p class="gate-disclaimer" style="visibility:hidden">{D266}</p>\n'
        check_false(
            "N9: visibility:hidden disclaimer does not satisfy check_d266_disclaimer",
            mod.check_d266_disclaimer(html_visibility_hidden),
        )
        html_styled_visible = f'<p class="gate-disclaimer" style="color: red;">{D266}</p>\n'
        check_true(
            "sanity: a visibly-styled (non-hidden) disclaimer still satisfies check_d266_disclaimer",
            mod.check_d266_disclaimer(html_styled_visible),
        )

        print()
        print("gh-2020 REVIEW: FAIL (comment 5780386929) X6: disclaimer "
              "wrapped in a collapsed <details><summary>Legal</summary>...  "
              "</details> (no `open` attribute, so a browser hides the body "
              "by default) -- must return False; a <details open> control "
              "with the same markup must still return True")
        html_details_collapsed = f'<details><summary>Legal</summary><p>{D266}</p></details>'
        check_false(
            "X6: disclaimer inside a collapsed <details> does not satisfy check_d266_disclaimer",
            mod.check_d266_disclaimer(html_details_collapsed),
        )
        html_details_open = f'<details open><summary>Legal</summary><p>{D266}</p></details>'
        check_true(
            "X6 control: disclaimer inside an <details open> still satisfies check_d266_disclaimer",
            mod.check_d266_disclaimer(html_details_open),
        )

        print()
        print("gh-2020 REVIEW: FAIL (comment 5780386929) X9: disclaimer "
              "inside a `hidden` element that NESTS ANOTHER element of the "
              "SAME tag name ahead of the disclaimer -- the old non-greedy "
              "`<(\\w+)...>.*?</\\1>` match stopped at the first same-name "
              "closing tag (the inner </div>), leaving the outer <p> "
              "disclaimer outside the stripped span -- must return False")
        html_nested_hidden = (
            '<div class="fine-print" hidden>'
            '<div class="fine-print-title">Legal</div> '
            f'<p>{D266}</p>'
            '</div>'
        )
        check_false(
            "X9: disclaimer inside a hidden element nesting a same-named tag does not satisfy check_d266_disclaimer",
            mod.check_d266_disclaimer(html_nested_hidden),
        )

        print()
        print("gh-2155 HI-0c control (landed on main after this issue's "
              "last CLOSE-REVIEW): a disclaimer that starts "
              "style=\"display:none\" but carries an id a <script> on the "
              "SAME page later reveals via .style.display = '' (the site's "
              "own fail-closed-then-JS-reveal pattern, Ben ruling 5836510515) "
              "must still satisfy check_d266_disclaimer -- this is NOT the "
              "N8/N9 bypass, which ships no reveal script at all")
        html_conditionally_hidden = (
            f'<p id="referralFeeDisclaimer" style="display:none;">{D266}</p>\n'
            "<script>\n"
            "  var el = document.getElementById('referralFeeDisclaimer');\n"
            "  if (el) { el.style.display = ''; }\n"
            "</script>\n"
        )
        check_true(
            "HI-0c control: a script-revealed display:none disclaimer still satisfies check_d266_disclaimer",
            mod.check_d266_disclaimer(html_conditionally_hidden),
        )
        html_conditionally_hidden_batch = (
            f'<p id="referralFeeDisclaimer" style="display:none;">{D266}</p>\n'
            "<script>\n"
            "  var feeIds = ['referralFeeDisclaimer', 'recruitFeeHint'];\n"
            "  feeIds.forEach(function (id) {\n"
            "    var el = document.getElementById(id);\n"
            "    if (el) el.style.display = '';\n"
            "  });\n"
            "</script>\n"
        )
        check_true(
            "HI-0c control (batch forEach reveal): still satisfies check_d266_disclaimer",
            mod.check_d266_disclaimer(html_conditionally_hidden_batch),
        )
        html_hidden_no_reveal_script = f'<p id="referralFeeDisclaimer" style="display:none;">{D266}</p>\n'
        check_false(
            "sanity: display:none with NO reveal script anywhere is still absent (N9 unaffected)",
            mod.check_d266_disclaimer(html_hidden_no_reveal_script),
        )

        print()
        print("gh-2020 refuter N20/N21/N22: compute_d266_pages() census, "
              "isolated fixture tree with module.REPO_ROOT NOT touched "
              "(root is passed explicitly)")
        census_root = pathlib.Path(tempfile.mkdtemp(prefix="partnerparity-test-census-"))
        try:
            def write_page(name, body, with_disclaimer):
                disclaimer_html = f'<p class="gate-disclaimer">{D266}</p>' if with_disclaimer else ""
                (census_root / name).write_text(
                    f"<html><body>{body}{disclaimer_html}</body></html>", encoding="utf-8"
                )

            # N20: a brand-new vertical, partner-lenders.html, with a
            # referral-fee sentence and NO disclaimer -- the old glob
            # (partner-insurance*.html only) never saw it.
            write_page(
                "partner-lenders.html",
                "<p>Earn a $200 referral fee for every qualified lender lead.</p>",
                with_disclaimer=False,
            )
            # N22: an EXISTING, unlisted partner-*.html page (the real
            # repo's own partner-agreement.html) with fee content and NO
            # disclaimer.
            write_page(
                "partner-agreement.html",
                "<p>Otter Quotes pays a $200 referral fee under this Agreement.</p>",
                with_disclaimer=False,
            )
            # N21: refer-a-friend.html -- not a partner-*.html name at all
            # -- with fee content and NO disclaimer.
            write_page(
                "refer-a-friend.html",
                "<p>Earn $200 for every friend you refer.</p>",
                with_disclaimer=False,
            )
            # Control: a partner-*.html page with no fee content at all
            # (mirrors partner-login.html) -- must NOT be swept in.
            write_page(
                "partner-login.html", "<p>Sign in with a magic link.</p>", with_disclaimer=False
            )

            pages = mod.compute_d266_pages(census_root)
            check_true(
                "N20: partner-lenders (new vertical) is in the D-266 census",
                "partner-lenders" in pages,
            )
            check_true(
                "N22: partner-agreement (unlisted existing page) is in the D-266 census",
                "partner-agreement" in pages,
            )
            check_true("N21: refer-a-friend is in the D-266 census", "refer-a-friend" in pages)
            check_false(
                "control: fee-free partner-login is NOT swept into the census",
                "partner-login" in pages,
            )

            # Each swept page with no disclaimer must actually FAIL the
            # disclaimer check too (fail-closed, not just "counted").
            for name in ("partner-lenders", "partner-agreement", "refer-a-friend"):
                html = (census_root / f"{name}.html").read_text(encoding="utf-8")
                check_false(
                    f"{name}: missing disclaimer fails check_d266_disclaimer",
                    mod.check_d266_disclaimer(html),
                )
        finally:
            shutil.rmtree(census_root, ignore_errors=True)

        print()
        print("gh-2020 REVIEW: FAIL (comment 5780386929) X3/X4/X5: "
              "FEE_SENTENCE_RE required a literal `$\\d` amount and the "
              "exact token 'referral', with no newline or '.' between them "
              "-- a source line-wrap (X3), a decimal amount (X4), or a "
              "spelled-out amount (X5) all read as absent")
        wrap_root = pathlib.Path(tempfile.mkdtemp(prefix="partnerparity-test-x345-"))
        try:
            (wrap_root / "lenders.html").write_text(
                "<html><body><p>Earn $250 for every borrower you send us "
                "whose\nproject completes -- paid for each referral.</p>"
                "</body></html>",
                encoding="utf-8",
            )
            pages = mod.compute_d266_pages(wrap_root)
            check_true(
                "X3: line-wrapped fee sentence is swept into the D-266 census",
                "lenders" in pages,
            )
        finally:
            shutil.rmtree(wrap_root, ignore_errors=True)

        decimal_root = pathlib.Path(tempfile.mkdtemp(prefix="partnerparity-test-x345-"))
        try:
            (decimal_root / "lenders.html").write_text(
                "<html><body><p>Earn $250.00 per referral you send us.</p></body></html>",
                encoding="utf-8",
            )
            pages = mod.compute_d266_pages(decimal_root)
            check_true(
                "X4: decimal fee amount is swept into the D-266 census",
                "lenders" in pages,
            )
        finally:
            shutil.rmtree(decimal_root, ignore_errors=True)

        spelled_root = pathlib.Path(tempfile.mkdtemp(prefix="partnerparity-test-x345-"))
        try:
            (spelled_root / "lenders.html").write_text(
                "<html><body><p>Earn two hundred dollars for every referral "
                "you send us.</p></body></html>",
                encoding="utf-8",
            )
            pages = mod.compute_d266_pages(spelled_root)
            check_true(
                "X5: spelled-out fee amount is swept into the D-266 census",
                "lenders" in pages,
            )
        finally:
            shutil.rmtree(spelled_root, ignore_errors=True)

        print()
        print("gh-2020 CLOSE-REVIEW: FAIL (comment 5824278669) must-fix (3): "
              "D-333's home-inspector no-fee exemption must FAIL CLOSED -- a "
              "referral fee re-added to an exempt inspector page must be "
              "caught, not silently pass because a name-based exemption "
              "beats the fee census")
        d333_root = pathlib.Path(tempfile.mkdtemp(prefix="partnerparity-test-d333-"))
        try:
            (d333_root / "partner-inspectors.html").write_text(
                "<html><body><p>Home inspectors receive no referral fee or "
                "recruit bonus.</p></body></html>",
                encoding="utf-8",
            )
            pages = mod.compute_d266_pages(d333_root)
            check_false(
                "D-333: no-fee partner-inspectors.html is NOT required to carry D-266",
                "partner-inspectors" in pages,
            )
            (d333_root / "partner-inspectors.html").write_text(
                "<html><body><p>Earn a $200 referral fee for every "
                "completed job.</p></body></html>",
                encoding="utf-8",
            )
            pages = mod.compute_d266_pages(d333_root)
            check_true(
                "D-333 fail-closed: a fee re-added to partner-inspectors.html re-requires D-266",
                "partner-inspectors" in pages,
            )
        finally:
            shutil.rmtree(d333_root, ignore_errors=True)

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
        "both tracks are deleted; undeclared exemption observed FAILING; "
        "N8/N9/N13/N15/N19/N20/N21/N22/N23 all observed FAILING on their "
        "fixtures and PASSING once restored)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
