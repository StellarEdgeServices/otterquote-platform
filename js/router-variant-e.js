// gh-2076 (D-327): Variant E -- the same role-first structure as arm C,
// but the homeowner path leads every question with a short line of
// exposition explaining how OtterQuote solves a specific problem before
// asking the next question. Filed by Ben (CEO RUN 57) from Dustin's
// verbatim decision, 2026-09-21 (see #2076's own issue body for Dustin's
// full 13-page homeowner-path script, quoted verbatim in this file's
// COPY constants below -- his words are the copy; do not edit, do not
// paraphrase; a typo is fixed only with his word).
//
// This is a MODULE, not a second page (same constraint #2011/#2017/#2075
// impose on arms C/D -- /start?v=e has to stay /start). start.html loads
// this file by injecting a <script> element ONLY when variant === 'e'
// (dormant today -- see start.html's own ARM_E/LIVE_VARIANTS comments:
// `variant` cannot be 'e' until the orchestrator flips LIVE_VARIANTS at
// merge, except through the ?v=e&oq_internal=1 QA override start.html
// also adds in this PR -- see that file's own comment for exactly what
// it does and does not do), then calls
// window.RouterVariantE.init(bridge, root) once it has loaded.
//
// Dustin, verbatim (#2076): "It is variant (c) with exposition after
// pages to explain OQs value. I didn't include the full language for the
// existing variant C pages. those should stay the same as they are in
// variant c." Screen 1 (role tap) and the ENTIRE professional/contractor
// tracks are therefore arm C's own screens, unchanged, reused via
// window.RouterDiscovery's exported COPY/renderMultiSelect/
// renderSingleSelect/renderDisqualifier/renderPartnerContact and its
// exported PARTNER_INDUSTRY_ORDER/REALTOR_TRACK/INSURANCE_TRACK/
// CONTRACTOR_TRACK track definitions (PR #2088 round 1, item 6: these
// track exports replaced this file's own earlier hand-forked copies of
// arm C's professional/contractor screens -- see js/router-discovery.js's
// own comment above those exports for why they are additive and change
// no behaviour for arm C). This file adds NOT ONE WORD of new copy for
// any of those reused screens.
//
// The homeowner path is Dustin's 13-page script, page by page. Pages 3,
// 5, 6, 8, 10, 12 and 13 ARE arm C's own existing question/contact
// screens (home3/home2/home4/home5/home6/home7/home8 -- mapped by
// content, since the script's own page ORDER differs from arm C's
// internal home-1..home-8 ordering: the script asks "who is paying"
// (home3) before "what kind of work" (home2), which arm C does not) --
// every one of those keeps arm C's own copy AND arm C's own qualify/
// disqualify branching (D-2/D-4/D-5/D-6/D-7, all unchanged, all read
// from window.RouterDiscovery.COPY, never re-typed here). Pages 2, 4(a),
// 4(b), 7, 9 and 11 are new, Dustin-authored exposition screens (one
// paragraph, one "Continue" tap) -- copied byte for byte from the issue
// body's fenced script block. Pages 5.5 and 7.5 are new single-field
// screens (name; email respectively), both with browser autofill
// enabled via the same autocomplete attributes this router's other
// contact fields already use, wrapped in a <form> so Enter/mobile "Go"
// submits (PR #2088 round 1, item 7).
//
// Contact capture is SPLIT, deliberately, the same way #2075 (arm D)
// split it -- Dustin: "the `leads` row is written at 7.5 (email) and
// updated as later answers arrive." Page 5.5 (name) captures a value
// held client-side only, with NO leads row yet (mirrors arm D's own
// d-name/d-email ordering constraint: nothing is written until the
// first field that actually creates the row). Page 7.5 (email) is that
// first commitment: it calls bridge.insertFreshLead(name, email, null)
// -- NAME is already known by this point, unlike arm D's own d-email
// screen, which is deliberately email-only -- then set_lead_role
// (role is already known from page 1). Page 13 (home8) keeps arm C's
// own home8Text VERBATIM, but does NOT re-collect name/email (both
// already sit on the lead row by then) -- it collects the one remaining
// optional field, phone, and PATCHes the same row via
// update_lead_contact, never a second insert.
//
// Analytics (#2076's own naming, distinct from arm C's/D's tokens):
// router_step_view/router_step_complete fire on every screen, INCLUDING
// the exposition-only ones, with step tokens 'e-p1'..'e-p13' following
// the issue's own page numbers ('e-p5-5'/'e-p7-5' for the two half-
// numbered pages, 'e-p4a'/'e-p4b' for the payer-branch pair).
// router_disqualified fires once per (session, source screen), identical
// semantics to arms C/D's own dedupe (see DQ_SOURCE below). The
// professional/contractor tracks (arm C's own screens, reused verbatim)
// get their own 'e-'-prefixed tokens too (e-prof-entry, e-realtor-*,
// e-ins-*, e-contractor-*) rather than reusing arm C's literal
// 'c-*' token names -- same reasoning as #2075's own d-trades/d-payer/
// etc. tokens: a shared token would collapse arm C's and arm E's funnels
// into the same GA4/BigQuery column, unreadable for both arms, not just
// one.
//
// gh-2078 (gh-2011's sub-issue, NOT this issue): the two conversion
// events -- measurement_purchase (homeowner) and partner_signup_complete
// (professional) -- are NOT emitted anywhere in this file. The homeowner
// hand-off (page 13) marks its own point with a named no-op hook
// (HOOK_measurementPurchase), mirroring js/router-variant-d.js's own
// hook of the same name. The professional/contractor hand-off now runs
// entirely through js/router-discovery.js's own exported
// renderPartnerContact (PR #2088 round 1, item 6), which has no
// equivalent hook of its own today -- same boundary arm C's own
// production hand-off already has, out of scope for this file to add.
//
// #2076: "Professional path: separate sub-issue (Sloane drafts the copy
// in the same style); until it lands, E's professional/contractor roles
// route exactly as C does." This uses arm C's FULL five-industry picker
// (re_agent/insurance_agent/home_inspector/adjuster/other, arm C's own
// exported PARTNER_INDUSTRY_ORDER) rather than #2075's own two-industry-
// only tap target, because this arm's own page-1 role screen is arm C's
// unrestricted "I am a professional..." option, not #2075's narrower
// one. When #2084 lands its own homeowner-style exposition copy for this
// track, only the small wiring in this file's "Professional / contractor
// tracks" section below is expected to change.
(function () {
  'use strict';

  var bridge = null;
  var root = null;

  // -- Homeowner-path exposition copy (#2076 issue body, byte-for-byte).
  // Kept in ONE place, separate from arm C's own COPY object (which this
  // file also reads from, via window.RouterDiscovery.COPY, for every
  // reused screen) so it is obvious at a glance which strings are new to
  // this arm and which are arm C's, unchanged. Every double space below
  // is exactly as pasted from the issue body -- not a typo this file
  // introduced, and not this file's place to fix one Dustin did not
  // flag. --
  var E_COPY = {
    p2: 'Otter Quotes helps homeowners get better deals on construction projects.  We generate your scope of work, submit it to multiple contractors, and they provide bids you can sign right here on our site.',
    p4a: 'When multiple contractors know they are bidding on the same job, the competition encourages them to provide better materials, warranties, and pricing.  When they know you have options, they work harder to win your business.',
    p4b: 'Contractors discourage homeowners from shopping around for contractors on insurance jobs by telling them their out of pocket expense is just your deductible.  What they don\'t tell you is that there is an upcharge for better materials and warranties.  When they are competing for your job, they are likely to throw these in for a reduced price or free to earn your business.',
    p7: 'Otter Quotes get contractors jobs without the need for a marketing budget, sales rep, and other overhead that adds nothing to the value of your home.   Since our contractors are competing for your business, these savings get passed along to you.',
    p9: 'A typical sales call with a contractor takes about two hours or more.  Getting 3 bids can take up your entire day.  With Otter Quotes, you spend about 15 minutes telling us about your project to get multiple bids from our contractors.',
    p11: 'Nearly 40% of the cost of your roof is money companies spend to look like they do great work.  The amazing sales rep at your kitchen table won\'t be swinging a hammer on your roof.   Otter Quotes helps you make your decision based on the information that really matters.'
  };

  // -- State, held client-side only for the lifetime of this page load --
  // same convention as arms C/D. --
  var role = null;
  var partnerIndustry = null;
  var leadId = null;
  var name = null;
  var email = null;
  var answers = {
    trades: [],
    payer: null,
    hiddenCosts: [],
    timeInvestment: null,
    selectionCriteria: [],
    online: null
  };

  var activeToken = null;
  var stack = [];
  var disqualifiedFired = {};
  var DQ_SOURCE = {
    'e-dq-p6': 'e-p6',
    'e-dq-p8': 'e-p8',
    'e-dq-p10': 'e-p10',
    'e-dq-p12': 'e-p12'
  };

  // gh-2088 (PR #2088 round 1, BLOCKER item 1; round 2, BLOCKER N1): the
  // in-flight request promise for e-p7-5's CURRENT submission -- fresh
  // insert OR resubmit/PATCH -- held at MODULE level, not inside that
  // render's own closure. Round 1's repro: Back (still live during the
  // in-flight insert) back to e-p7, forward to e-p7-5 again -- a fresh
  // render has its own fresh local `busy = false` and `leadId` is still
  // null (the first insert has not resolved yet), so the second render's
  // own submit fired a SECOND insertFreshLead. Round 2's repro: the SAME
  // render's own onSubmit fired twice (Enter/Go pressed twice, or two
  // 'submit' events in the same tick) -- round 1's fix only checked this
  // promise in the top-level RENDERERS['e-p7-5']() function, which only
  // runs at RENDER time, never inside onSubmit() itself, so two calls to
  // onSubmit() on the SAME rendered form both slipped through (the
  // resubmit/PATCH branch didn't set this promise at all, so it was
  // unguarded even on a cross-render re-entry). onSubmit() now checks
  // this at its own very first line, before touching validation, and
  // both branches (fresh insert and resubmit/PATCH) set it before
  // starting their request. Cleared back to null once that request
  // settles, success or failure.
  var p75InsertPromise = null;

  // gh-2088 (PR #2088 round 2, BLOCKER N1): same guard, for e-p13's own
  // update_lead_contact (phone) submission -- a second Enter/Go/click
  // while the PATCH is in flight used to fire update_lead_contact twice,
  // and on the `data:false` fallback path, insertFreshLead + finish()
  // (redirect) twice.
  var p13SubmitPromise = null;

  // gh-2088 (PR #2088 round 1, item 9): the click-debounce guard below
  // needs to know when the current screen was rendered. See show().
  var lastShowAt = 0;

  // -- DOM helpers, kept local for the same reason js/router-variant-d.js
  // keeps its own copy rather than importing window.RouterDiscovery's
  // heading/bodyText/continueButton exports: this file owns its own
  // back-stack (goBack/stack below), and RD.renderMultiSelect/
  // renderSingleSelect's own `cfg.backTo` flag would bind a Back button
  // to RD's INTERNAL c-entry stack, not this one -- see
  // js/router-discovery.js's own comment on its exports block for why
  // that flag is deliberately never forwarded by a caller module. --
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }
  function clearRoot() { while (root.firstChild) root.removeChild(root.firstChild); }
  function heading(text) { return el('h1', null, text); }
  function bodyText(text) { return el('p', 'router-sub', text); }
  function continueButton(label, onClick, startEnabled) {
    var btn = el('button', 'btn btn-primary router-btn', label);
    btn.type = 'button';
    btn.disabled = !startEnabled;
    btn.addEventListener('click', onClick);
    return btn;
  }
  function backButton(onClick) {
    var btn = el('button', 'router-back', null);
    btn.type = 'button';
    btn.innerHTML = '&larr; Back';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function emitView(token) { bridge.trackRouter('router_step_view', { step: token }); }
  function emitComplete(token) { bridge.trackRouter('router_step_complete', { step: token }); }
  function emitDisqualified(sourceToken) { bridge.trackRouter('router_disqualified', { step: sourceToken }); }

  var RENDERERS = {};

  function show(token) {
    activeToken = token;
    clearRoot();
    lastShowAt = Date.now();
    emitView(token);
    var dqSource = DQ_SOURCE[token];
    if (dqSource && !disqualifiedFired[dqSource]) {
      disqualifiedFired[dqSource] = true;
      emitDisqualified(dqSource);
    }
    RENDERERS[token]();
  }
  function go(token) {
    if (activeToken) emitComplete(activeToken);
    stack.push(activeToken);
    show(token);
  }
  function goBack() {
    if (!stack.length) return;
    if (activeToken) emitComplete(activeToken);
    show(stack.pop());
  }

  // -- gh-2042 precedent: phone optional everywhere on this router.
  // Duplicated locally for the same reason js/router-variant-d.js keeps
  // its own copy. --
  function normalizePhone(raw) {
    var digits = (raw || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    return digits;
  }
  function isValidUsPhone(raw) {
    var digits = normalizePhone(raw);
    if (digits.length !== 10) return false;
    if (/^(\d)\1{9}$/.test(digits)) return false;
    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return false;
    return true;
  }

  // gh-2088 (PR #2088 round 1, item 5): `optional` now actually appends
  // the " (optional)" suffix span, matching arm C's own field label text
  // exactly ("Phone Number (optional)") -- this file's own copy of this
  // helper had dropped that append entirely, so e-p13's phone field
  // silently drifted to "Phone Number". `parent` (item 7) is the
  // optional <form> element a field should append into instead of
  // `root` directly, so a screen can wrap its field(s) + submit button
  // in one <form> for native Enter/mobile-"Go" submission.
  function field(id, labelText, type, extra, optional, parent) {
    var group = el('div', 'form-group');
    var label = el('label', optional ? 'form-label' : 'form-label required', null);
    label.setAttribute('for', id);
    label.appendChild(document.createTextNode(labelText));
    if (optional) {
      var opt = el('span', 'form-label-optional', ' (optional)');
      label.appendChild(opt);
    }
    var input = el('input', 'form-input');
    input.type = type;
    input.id = id;
    if (extra) {
      Object.keys(extra).forEach(function (k) { input.setAttribute(k, extra[k]); });
    }
    var err = el('div', 'field-error');
    err.id = id + 'Error';
    group.appendChild(label);
    group.appendChild(input);
    group.appendChild(err);
    (parent || root).appendChild(group);
    return { input: input, err: err };
  }

  // gh-2088 (PR #2088 round 1, item 7): wraps one or more fields + a
  // submit control in a <form>, so pressing Enter (desktop) or tapping
  // "Go"/"Next" on a mobile keyboard (single-field implicit submission)
  // fires the SAME onSubmit the Continue button's own click already
  // does. The button stays type="button" (never "submit") so a click
  // fires exactly the one 'click' listener below and nothing else --
  // the form's own 'submit' listener is reached only via keyboard
  // implicit submission, so neither path can double-invoke onSubmit.
  function wrapInForm(onSubmit) {
    var form = el('form');
    form.addEventListener('submit', function (evt) {
      if (evt && evt.preventDefault) evt.preventDefault();
      onSubmit();
    });
    return form;
  }

  // gh-2088 (PR #2088 round 1, item 9): exposition screens (e-p2, e-p4a/
  // e-p4b, e-p7, e-p9, e-p11) advance with a single synchronous go() call
  // and no network round-trip, so a fast real double-tap can land its
  // second tap on whatever the NEXT screen renders at the same on-screen
  // position (round 1's repro: e-p11 -> e-p12, second tap lands on
  // e-p12's own first, disqualifying option). A per-render `fired` flag
  // alone does not stop this -- the second tap hits a DIFFERENT element
  // (the next screen's), not the same button twice. The actual guard is
  // the capturing-phase listener init() attaches to `root` (see below):
  // it drops any click within a short window of the CURRENT screen
  // having been shown, so the accidental second tap is swallowed before
  // it ever reaches the newly-rendered screen's own handler, for every
  // screen this file renders (its own exposition buttons AND arm C's own
  // reused option rows), without needing any change to arm C's code.
  var CLICK_GUARD_MS = 350;

  // ====== Page 1: role tap (arm C's own c-entry, unchanged) ======
  RENDERERS['e-p1'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderSingleSelect(root, {
      heading: RD.COPY.entryIntro,
      options: [
        { label: RD.COPY.entryOptions[0], disabled: false },
        { label: RD.COPY.entryOptions[1], disabled: false },
        { label: RD.COPY.entryOptions[2], disabled: false }
      ],
      onSelect: function (idx) {
        if (idx === 1) { role = 'homeowner'; go('e-p2'); return; }
        if (idx === 2) { go('e-prof-entry'); return; }
        role = 'contractor';
        go('e-contractor-1');
      }
    });
  };

  // ====== Exposition screens (pages 2, 4a, 4b, 7, 9, 11) -- one
  // paragraph, one guarded Continue tap, nothing else. ======
  function expositionRenderer(text, nextToken) {
    return function () {
      root.appendChild(bodyText(text));
      var fired = false;
      root.appendChild(continueButton('Continue', function () {
        // Per-render guard: protects against the SAME button firing
        // twice (e.g. two synthetic events on one element); the
        // cross-screen fast-double-tap case is handled by the root-level
        // click guard in init() -- see CLICK_GUARD_MS's own comment.
        if (fired) return;
        fired = true;
        go(nextToken);
      }, true));
    };
  }
  RENDERERS['e-p2'] = expositionRenderer(E_COPY.p2, 'e-p3');
  RENDERERS['e-p4a'] = expositionRenderer(E_COPY.p4a, 'e-p5');
  RENDERERS['e-p4b'] = expositionRenderer(E_COPY.p4b, 'e-p5');
  RENDERERS['e-p7'] = expositionRenderer(E_COPY.p7, 'e-p7-5');
  RENDERERS['e-p9'] = expositionRenderer(E_COPY.p9, 'e-p10');
  RENDERERS['e-p11'] = expositionRenderer(E_COPY.p11, 'e-p12');

  // ====== Page 3: who is paying (arm C's home3, unchanged) ======
  RENDERERS['e-p3'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, {
      heading: RD.COPY.home3Heading,
      options: RD.COPY.home3Options,
      onSelect: function (idx) {
        answers.payer = RD.COPY.home3Options[idx - 1];
        // home3Options is ['Me', 'Insurance'] -- #2076's own page 4(a)/4(b)
        // branch on this exact answer.
        go(idx === 1 ? 'e-p4a' : 'e-p4b');
      }
    });
  };

  // ====== Page 5: what kind of work (arm C's home2, unchanged) ======
  RENDERERS['e-p5'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderMultiSelect(root, {
      heading: RD.COPY.home2Heading,
      options: RD.COPY.home2Options,
      onContinue: function (chosen) {
        answers.trades = chosen.map(function (i) { return RD.COPY.home2Options[i - 1]; });
        go('e-p5-5');
      }
    });
  };

  // ====== Page 5.5: name (new, autofill-enabled, form-wrapped). No lead
  // row exists yet -- held client-side only, written at page 7.5
  // alongside email (#2076: "the leads row is written at 7.5 ... and
  // updated as later answers arrive"). Restores a previously-typed value
  // on Back (#2088 round 1, item 7). ======
  RENDERERS['e-p5-5'] = function () {
    root.appendChild(backButton(goBack));
    root.appendChild(heading('How should I address you?'));
    var form = wrapInForm(onSubmit);
    root.appendChild(form);
    var nameF = field('eName', 'Name', 'text', { autocomplete: 'name', maxlength: '200' }, false, form);
    nameF.input.value = name || '';
    form.appendChild(continueButton('Continue', onSubmit, true));
    function onSubmit() {
      nameF.err.textContent = '';
      var value = nameF.input.value.trim();
      if (!value) { nameF.err.textContent = 'Please enter your name.'; return; }
      name = value;
      go('e-p6');
    }
  };

  // ====== Page 6: hidden-cost expenses (arm C's home4, unchanged) ======
  RENDERERS['e-p6'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderMultiSelect(root, {
      heading: RD.COPY.home4Heading,
      options: RD.COPY.home4Options,
      onContinue: function (chosen) {
        answers.hiddenCosts = chosen;
        var qualifies = chosen.length === 1 && chosen[0] === 5;
        if (qualifies) { go('e-p7'); } else { go('e-dq-p6'); }
      }
    });
  };
  RENDERERS['e-dq-p6'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderDisqualifier(root, {
      text: RD.COPY.dq4Text,
      opt1: RD.COPY.dq4Opt1,
      onContinue: function () { go('e-p7'); }
    });
  };

  // ====== Page 7.5: email (new, autofill-enabled, form-wrapped). FIRST
  // COMMITMENT -- writes the leads row with the name already captured at
  // page 5.5, exactly once. Guarded against the round-1 BLOCKER (see
  // p75InsertPromise's own comment above): a re-entry while a fresh
  // insert is still pending renders a wait state and resolves forward
  // once that SAME request settles, instead of collecting and inserting
  // a second time. Resubmit-after-Back (lead already exists) PATCHes via
  // update_lead_contact; a `data:false` result (row >30 min old, or its
  // prefill already used -- #2088 round 1 item 4) falls back to a fresh
  // insertFreshLead, mirroring arm A's own Step 1 resubmit fallback,
  // instead of silently losing the correction. ======
  // gh-2088 (PR #2088 round 2 leftover, item 4): arm A calls set_lead_role
  // right after EVERY fresh insert it falls back to, not only the very
  // first one -- round 1's own `data:false` fallbacks (e-p7-5's resubmit,
  // e-p13's phone patch) called bridge.insertFreshLead(...) directly and
  // stopped there, leaving those rows with role=NULL (gh-2017's own
  // insert-time default forces it). Factored out so the original submit
  // AND both `data:false` fallbacks share the exact same insert-then-
  // set-role sequence, with `is_synthetic` still threaded through every
  // one of them via bridge.oqInternalOverride.
  function insertFreshLeadAndSetRole(nm, em, phoneDigits) {
    return bridge.insertFreshLead(nm, em, phoneDigits, bridge.oqInternalOverride).then(function (newId) {
      return new Promise(function (resolve) {
        bridge.sb.rpc('set_lead_role', { p_lead_id: newId, p_role: 'homeowner' }).then(function (res) {
          if (res && res.error) throw res.error;
          resolve(newId);
        }).catch(function (roleErr) {
          console.error('[router-variant-e] set_lead_role failed -- proceeding anyway:', roleErr);
          resolve(newId);
        });
      });
    });
  }

  RENDERERS['e-p7-5'] = function () {
    if (p75InsertPromise) {
      root.appendChild(heading('What is a good email address to reach you?'));
      root.appendChild(continueButton('Please wait…', function () {}, false));
      p75InsertPromise.then(function () {
        if (activeToken === 'e-p7-5') go('e-p8');
      }, function () { /* the original submit's own handler already surfaced the error */ });
      return;
    }

    var backBtn = backButton(goBack);
    root.appendChild(backBtn);
    root.appendChild(heading('What is a good email address to reach you?'));
    var form = wrapInForm(onSubmit);
    root.appendChild(form);
    var emailF = field('eEmail', 'Email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '320' }, false, form);
    emailF.input.value = email || '';
    var submitBtn = continueButton('Continue', onSubmit, true);
    form.appendChild(submitBtn);

    function onSubmit() {
      // gh-2088 (PR #2088 round 2, BLOCKER N1): the FIRST line of
      // onSubmit, before any validation -- a second 'submit' (Enter/Go
      // pressed twice) or a second click reaching this SAME rendered
      // form while a request from the first is already in flight must be
      // a complete no-op, on EITHER branch below (fresh insert or
      // resubmit/PATCH). p75InsertPromise is set synchronously, before
      // either branch's own request starts (see below), so by the time a
      // second synchronous onSubmit() call can run, it is already set.
      if (p75InsertPromise) return;

      emailF.err.textContent = '';
      var value = emailF.input.value.trim();
      if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        emailF.err.textContent = 'Please enter a valid email address.';
        return;
      }
      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }

      submitBtn.disabled = true;
      backBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';
      // gh-2088 (PR #2088 round 2, BLOCKER N1): readOnly, not just
      // disabled -- a disabled INPUT still accepts focus/typing in some
      // browsers; readOnly is the property that actually blocks edits
      // during the in-flight request, matching the coordinator's ask.
      emailF.input.readOnly = true;

      if (leadId) {
        // Resubmit path: a lead row already exists (Back from a later
        // screen, correct the email, Continue again) -- PATCH it, never
        // insert a second row/admin alert. Back is disabled for the
        // duration, so no re-entrant submit can reach this screen while
        // the PATCH is in flight -- and p75InsertPromise (set just below,
        // BEFORE this branch returns) now also guards a same-render
        // double 'submit' event, which disabling Back does not.
        email = value;
        var patchP = bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: name, p_email: email, p_phone: null }).then(function (res) {
          if (res && res.data === true) { return; }
          // #2088 round 1 item 4 / round 2 leftover: `data:false` means
          // the guard (30-minute window, or prefill already used)
          // refused the write -- arm A's own resubmit path falls back to
          // a fresh insert (now via the shared helper, which ALSO calls
          // set_lead_role -- round 1's own fallback here did not) rather
          // than losing the correction.
          return insertFreshLeadAndSetRole(name, email, null).then(function (newId) { leadId = newId; });
        }, function () { /* thrown/rejected rpc -- proceed anyway, same "never strand" rule every RPC on this router follows */ }).then(function () {
          if (activeToken === 'e-p7-5') go('e-p8');
        }, function () {
          if (activeToken === 'e-p7-5') go('e-p8');
        });
        p75InsertPromise = patchP;
        patchP.then(function () { p75InsertPromise = null; }, function () { p75InsertPromise = null; });
        return;
      }

      // gh-2088 (PR #2088 round 1, item 3): `bridge.oqInternalOverride` is
      // true only while the ?v=e&oq_internal=1 QA override is active (see
      // start.html's own comment on that override) -- insertFreshLead
      // sets leads.is_synthetic=true on the row in that case so a pre-
      // flip QA walk never creates an unflagged production lead / an
      // unflagged admin alert. False/undefined for every real visitor.
      // (Threaded inside insertFreshLeadAndSetRole, shared with both
      // `data:false` fallbacks above/below.)
      var p = insertFreshLeadAndSetRole(name, value, null).then(function (newId) {
        email = value;
        leadId = newId;
        return newId;
      });

      p75InsertPromise = p;
      p.then(function () {
        p75InsertPromise = null;
        if (activeToken === 'e-p7-5') go('e-p8');
      }, function (err) {
        p75InsertPromise = null;
        console.error('[router-variant-e] email save failed:', err);
        if (activeToken === 'e-p7-5') {
          submitBtn.disabled = false;
          backBtn.disabled = false;
          submitBtn.textContent = 'Continue';
          emailF.input.readOnly = false;
          bridge.showError('Something went wrong saving your info. Please try again.');
        }
      });
    }
  };

  // ====== Page 8: time investment (arm C's home5, unchanged) ======
  RENDERERS['e-p8'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, {
      heading: RD.COPY.home5Heading,
      options: RD.COPY.home5Options,
      onSelect: function (idx) {
        answers.timeInvestment = RD.COPY.home5Options[idx - 1];
        if (idx === 3) { go('e-dq-p8'); } else { go('e-p9'); }
      }
    });
  };
  RENDERERS['e-dq-p8'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderDisqualifier(root, {
      text: RD.COPY.dq5Text,
      opt1: RD.COPY.dq5Opt1,
      onContinue: function () { go('e-p9'); }
    });
  };

  // ====== Page 10: selection criteria (arm C's home6, unchanged) ======
  RENDERERS['e-p10'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderMultiSelect(root, {
      heading: RD.COPY.home6Heading,
      options: RD.COPY.home6Options,
      onContinue: function (chosen) {
        answers.selectionCriteria = chosen;
        var disqualifyingChoice = chosen.some(function (n) { return n === 6 || n === 7 || n === 8; });
        if (disqualifyingChoice) { go('e-dq-p10'); } else { go('e-p11'); }
      }
    });
  };
  RENDERERS['e-dq-p10'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderDisqualifier(root, {
      text: RD.COPY.dq6Text,
      opt1: RD.COPY.dq6Opt1,
      onContinue: function () { go('e-p11'); }
    });
  };

  // ====== Page 12: online comfort (arm C's home7, unchanged) ======
  RENDERERS['e-p12'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, {
      heading: RD.COPY.home7Heading,
      options: RD.COPY.home7Options,
      onSelect: function (idx) {
        answers.online = RD.COPY.home7Options[idx - 1];
        // D-2 (issue #2011/#2017): option 1 disqualifies, option 2
        // qualifies -- identical logic to arms C/D's own equivalent screen.
        if (idx === 1) { go('e-dq-p12'); } else { go('e-p13'); }
      }
    });
  };
  RENDERERS['e-dq-p12'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderDisqualifier(root, {
      text: RD.COPY.dq7Text,
      opt1: RD.COPY.dq7Opt1,
      onContinue: function () { go('e-p13'); }
    });
  };

  // gh-2078 HOOK POINT (not implemented here, on purpose) -- see this
  // file's own top-of-file comment and js/router-variant-d.js's identical
  // hook of the same name.
  function HOOK_measurementPurchase() { /* see gh-2078; intentionally not implemented in gh-2076 */ }

  // ====== Page 13: "Tell us about your home" (arm C's home8 TEXT,
  // unchanged) -- but name/email are already on the lead row from page
  // 7.5, so this screen collects only the one remaining optional field,
  // phone, and PATCHes rather than re-collecting/re-inserting. Same
  // `data:false` fallback as e-p7-5 above (#2088 round 1 item 4). Has
  // its own Back (#2088 round 1 item 8) which, together with the submit
  // button, is restored on a bfcache return -- see the `pageshow`
  // listener in init(). ======
  RENDERERS['e-p13'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(bodyText(RD.COPY.home8Text));
    var backBtn = backButton(goBack);
    root.appendChild(backBtn);
    var form = wrapInForm(onSubmit);
    root.appendChild(form);
    var phoneF = field('ePhone', 'Phone Number', 'tel', { autocomplete: 'tel', inputmode: 'tel', maxlength: '20' }, true, form);
    var submitBtn = continueButton('Continue', onSubmit, true);
    form.appendChild(submitBtn);

    function finish() {
      emitComplete('e-p13');
      HOOK_measurementPurchase();
      redirectWithLeadId(bridge.ROLE_DESTINATIONS.homeowner, leadId);
    }

    function onSubmit() {
      // gh-2088 (PR #2088 round 2, BLOCKER N1): same guard as e-p7-5 --
      // a second Enter/Go/click landing on this SAME rendered form while
      // the PATCH is in flight used to fire update_lead_contact twice,
      // and on the `data:false` fallback path, insertFreshLead + finish()
      // (redirect) twice.
      if (p13SubmitPromise) return;

      phoneF.err.textContent = '';
      var raw = phoneF.input.value.trim();
      if (raw && !isValidUsPhone(raw)) {
        phoneF.err.textContent = 'Please enter a valid 10-digit US phone number.';
        return;
      }
      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }
      submitBtn.disabled = true;
      backBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';
      phoneF.input.readOnly = true;
      var phoneDigits = raw ? normalizePhone(raw) : null;
      var p = bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: name, p_email: email, p_phone: phoneDigits }).then(function (res) {
        if (res && res.data === true) { finish(); return; }
        // #2088 round 1 item 4 / round 2 leftover: same data:false
        // fallback as e-p7-5, now via the shared helper so this ALSO
        // calls set_lead_role (round 1's own fallback here did not).
        return insertFreshLeadAndSetRole(name, email, phoneDigits).then(function (newId) {
          leadId = newId;
          finish();
        });
      }, function (err) {
        console.error('[router-variant-e] update_lead_contact (phone) threw -- proceeding anyway:', err);
        finish();
      }).catch(function (err) {
        console.error('[router-variant-e] update_lead_contact (phone) threw -- proceeding anyway:', err);
        finish();
      });
      p13SubmitPromise = p;
      p.then(function () { p13SubmitPromise = null; }, function () { p13SubmitPromise = null; });
    }
  };

  function redirectWithLeadId(destBase, id) {
    var sep = destBase.indexOf('?') === -1 ? '?' : '&';
    var withLead = destBase + sep + 'lead=' + encodeURIComponent(id);
    bridge.redirectTo(bridge.appendParams(withLead, bridge.collectAttribution()), true);
  }

  // ====== Professional / contractor tracks -- arm C's own screens,
  // unchanged, reused via js/router-discovery.js's exported
  // renderPartnerContact and PARTNER_INDUSTRY_ORDER/REALTOR_TRACK/
  // INSURANCE_TRACK/CONTRACTOR_TRACK (#2088 round 1, item 6). Registered
  // once RD has loaded (registerReusedTracks(), called from init()'s own
  // loadDiscoveryModule().then()) since they read those exports at
  // REGISTRATION time, not at render time. Pending #2084. ======
  function registerQuestionTrack(prefix, track, closeToken, RD) {
    track.forEach(function (q, i) {
      var token = prefix + '-' + (i + 1);
      var nextToken = (i + 1 < track.length) ? (prefix + '-' + (i + 2)) : closeToken;
      RENDERERS[token] = function () {
        var RD2 = window.RouterDiscovery;
        root.appendChild(backButton(goBack));
        RD2.renderSingleSelect(root, {
          heading: RD2.COPY[q.headingKey],
          options: RD2.COPY[q.optionsKey],
          onSelect: function (idx) {
            answers[q.answerKey] = RD2.COPY[q.optionsKey][idx - 1];
            go(nextToken);
          }
        });
      };
    });
  }

  function registerReusedTracks(RD) {
    registerQuestionTrack('e-realtor', RD.REALTOR_TRACK, 'e-realtor-close', RD);
    registerQuestionTrack('e-ins', RD.INSURANCE_TRACK, 'e-ins-close', RD);
    registerQuestionTrack('e-contractor', RD.CONTRACTOR_TRACK, 'e-contractor-5', RD);
  }

  RENDERERS['e-prof-entry'] = function () {
    var RD = window.RouterDiscovery;
    var order = RD.PARTNER_INDUSTRY_ORDER;
    var labels = (window.AgentTypes && window.AgentTypes.CHOOSER_LABELS) || {};
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, {
      heading: RD.COPY.profEntryHeading,
      sub: RD.COPY.profEntrySub,
      options: order.map(function (code) { return labels[code] || code; }),
      onSelect: function (idx) {
        var industry = order[idx - 1];
        partnerIndustry = industry;
        if (industry === 're_agent') { go('e-realtor-1'); return; }
        if (industry === 'insurance_agent') { go('e-ins-1'); return; }
        // home_inspector/adjuster/other -- arm C's own c-prof-entry sends
        // these straight to their destination page with attribution only,
        // no lead id (no copy/track exists for them yet, same as arm C).
        emitComplete('e-prof-entry');
        var dest = bridge.PARTNER_INDUSTRY_DESTINATIONS[industry];
        bridge.redirectTo(bridge.appendParams(dest, bridge.collectAttribution()), true);
      }
    });
  };

  RENDERERS['e-realtor-close'] = function () {
    var RD = window.RouterDiscovery;
    RD.COPY.realtorClose.forEach(function (p) { root.appendChild(bodyText(p)); });
    root.appendChild(continueButton('Continue', function () { go('e-realtor-contact'); }, true));
  };
  RENDERERS['e-realtor-contact'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderPartnerContact(root, {
      introParagraphs: [],
      role: 'referral_partner',
      partnerIndustry: 're_agent',
      destination: bridge.PARTNER_INDUSTRY_DESTINATIONS.re_agent,
      completeToken: 'e-realtor-contact'
    });
  };

  RENDERERS['e-ins-close'] = function () {
    var RD = window.RouterDiscovery;
    RD.COPY.insClose.forEach(function (p) { root.appendChild(bodyText(p)); });
    root.appendChild(continueButton('Continue', function () { go('e-ins-contact'); }, true));
  };
  RENDERERS['e-ins-contact'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderPartnerContact(root, {
      introParagraphs: [],
      role: 'referral_partner',
      partnerIndustry: 'insurance_agent',
      destination: bridge.PARTNER_INDUSTRY_DESTINATIONS.insurance_agent,
      completeToken: 'e-ins-contact'
    });
  };

  RENDERERS['e-contractor-5'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(bodyText(RD.COPY.contractorQ5Text));
    root.appendChild(continueButton('Continue', function () { go('e-contractor-contact'); }, true));
  };
  RENDERERS['e-contractor-contact'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderPartnerContact(root, {
      introParagraphs: [],
      role: 'contractor',
      partnerIndustry: null,
      destination: bridge.ROLE_DESTINATIONS.contractor,
      completeToken: 'e-contractor-contact'
    });
  };

  // -- Lazy-load js/router-discovery.js -- unlike #2075's own
  // loadDiscoveryModule() (called only once a visitor clears
  // d-email/d-name/d-phone), this arm's very FIRST screen (e-p1) is arm
  // C's own role screen and needs RD.COPY/renderSingleSelect
  // immediately, so this file loads it once, at init(), before anything
  // renders -- there is no earlier screen of this arm's own that could
  // render without it. start.html itself still only fetches THIS file
  // (js/router-variant-e.js) for an arm-e visitor, exactly like arm D's
  // own wiring -- js/router-discovery.js is fetched by this module, not
  // by start.html, and only for a visitor who actually lands on arm e. ──
  var discoveryLoadPromise = null;
  function loadDiscoveryModule() {
    if (window.RouterDiscovery && window.RouterDiscovery.COPY) {
      return Promise.resolve(window.RouterDiscovery);
    }
    if (discoveryLoadPromise) return discoveryLoadPromise;
    discoveryLoadPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'js/router-discovery.js';
      s.onload = function () {
        if (window.RouterDiscovery && window.RouterDiscovery.COPY) resolve(window.RouterDiscovery);
        else reject(new Error('RouterDiscovery did not export COPY'));
      };
      s.onerror = function () { reject(new Error('failed to load js/router-discovery.js')); };
      document.body.appendChild(s);
    });
    return discoveryLoadPromise;
  }

  function init(injectedBridge, mountEl) {
    bridge = injectedBridge;
    root = mountEl || document.getElementById('routerERoot');
    if (!root) { return; }
    root.setAttribute('data-re-root', '1');

    // #2088 round 1 item 9: capturing-phase guard on the mount element --
    // swallows any click within CLICK_GUARD_MS of the current screen
    // having been shown, before it reaches the target element's own
    // listener. Covers both this file's own exposition buttons AND arm
    // C's reused option rows, without any change to arm C's code -- see
    // CLICK_GUARD_MS's own comment above for the exact failure mode this
    // fixes.
    root.addEventListener('click', function (evt) {
      if (Date.now() - lastShowAt < CLICK_GUARD_MS) {
        if (evt && evt.stopPropagation) evt.stopPropagation();
        if (evt && evt.preventDefault) evt.preventDefault();
      }
    }, true);

    // #2088 round 1 item 8: a bfcache restore (Android/iOS back-gesture
    // from the homeowner hand-off destination back to /start?v=e) revives
    // this module's in-memory JS exactly as it was -- if that was e-p13
    // mid-submit, its Continue button and Back button are still disabled
    // and read "Please wait…". Re-rendering the current screen rebuilds
    // both fresh and enabled; this is a no-op for every other screen.
    window.addEventListener('pageshow', function (e) {
      if (e.persisted && activeToken === 'e-p13') { show('e-p13'); }
    });

    loadDiscoveryModule().then(function (RD) {
      if (typeof RD.setBridge === 'function') RD.setBridge(bridge);
      registerReusedTracks(RD);
      show('e-p1');
    }).catch(function (err) {
      console.error('[router-variant-e] failed to load js/router-discovery.js:', err);
      bridge.showError('Something went wrong loading this page. Please refresh and try again.');
    });
  }

  window.RouterVariantE = { init: init };
})();
