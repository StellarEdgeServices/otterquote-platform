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
// renderSingleSelect/renderDisqualifier -- the same export contract
// js/router-variant-d.js already established and uses (see that file's
// own top-of-file comment and js/router-discovery.js's own comment above
// its `window.RouterDiscovery = {...}` block). This file adds NOT ONE
// WORD of new copy for any of those reused screens.
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
// contact fields already use.
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
// update_lead_contact, never a second insert. This is the same
// contact-capture shape #2075/round-3's re-review already established
// as this router's working pattern for a split, multi-screen contact
// funnel (see js/router-variant-d.js's own d-name/d-phone) -- reused
// here, not reinvented.
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
// one (see js/router-variant-d.js's own B_STEP_TOKENS-adjacent comment
// on this exact class of bug in a different arm).
//
// gh-2078 (gh-2011's sub-issue, NOT this issue): the two conversion
// events -- measurement_purchase (homeowner) and partner_signup_complete
// (professional) -- are NOT emitted anywhere in this file, same as
// #2075. HOOK_measurementPurchase/HOOK_partnerSignupComplete mark the
// two hand-off points with named no-ops, exactly mirroring
// js/router-variant-d.js's own hooks of the same name.
//
// #2076: "Professional path: separate sub-issue (Sloane drafts the copy
// in the same style); until it lands, E's professional/contractor roles
// route exactly as C does." This file's e-prof-entry/e-realtor-*/
// e-ins-*/e-contractor-* screens are therefore full re-implementations
// of arm C's OWN professional/contractor screens (same reasoning as
// #2075's own d-professional-industry/d-realtor-*/d-ins-* -- arm C does
// not export its internal show()/go()/RENDERERS sequencer, only COPY and
// the three render helpers, so a caller that wants arm C's screens under
// its OWN step tokens/back-stack has to re-wire them, not copy their
// text) -- unlike #2075, this uses arm C's FULL five-industry picker
// (re_agent/insurance_agent/home_inspector/adjuster/other, arm C's own
// PARTNER_INDUSTRY_ORDER) rather than #2075's own two-industry-only tap
// target, because this arm's own page-1 role screen is arm C's
// unrestricted "I am a professional..." option, not #2075's narrower
// "Professional (real estate or insurance)" tap. When #2084 lands its
// own homeowner-style exposition copy for this track, ONLY this file's
// e-prof-entry/e-realtor-*/e-ins-*/e-contractor-* screens are the ones
// expected to change -- the homeowner screens above are untouched by
// that follow-up, which is why they are kept in clearly separate
// sections of this file.
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

  function field(id, labelText, type, extra, optional) {
    var group = el('div', 'form-group');
    var label = el('label', optional ? 'form-label' : 'form-label required', null);
    label.setAttribute('for', id);
    label.appendChild(document.createTextNode(labelText));
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
    root.appendChild(group);
    return { input: input, err: err };
  }

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

  // ====== Page 2: exposition (general value prop) ======
  RENDERERS['e-p2'] = function () {
    root.appendChild(bodyText(E_COPY.p2));
    root.appendChild(continueButton('Continue', function () { go('e-p3'); }, true));
  };

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

  // ====== Page 4(a)/4(b): exposition, branched on the payer answer ======
  RENDERERS['e-p4a'] = function () {
    root.appendChild(bodyText(E_COPY.p4a));
    root.appendChild(continueButton('Continue', function () { go('e-p5'); }, true));
  };
  RENDERERS['e-p4b'] = function () {
    root.appendChild(bodyText(E_COPY.p4b));
    root.appendChild(continueButton('Continue', function () { go('e-p5'); }, true));
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

  // ====== Page 5.5: name (new, autofill-enabled). No lead row exists
  // yet -- held client-side only, written at page 7.5 alongside email
  // (#2076: "the leads row is written at 7.5 ... and updated as later
  // answers arrive"). ======
  RENDERERS['e-p5-5'] = function () {
    root.appendChild(backButton(goBack));
    root.appendChild(heading('How should I address you?'));
    var nameF = field('eName', 'Name', 'text', { autocomplete: 'name', maxlength: '200' });
    var submitBtn = continueButton('Continue', onSubmit, true);
    root.appendChild(submitBtn);
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

  // ====== Page 7: exposition (no marketing budget) ======
  RENDERERS['e-p7'] = function () {
    root.appendChild(bodyText(E_COPY.p7));
    root.appendChild(continueButton('Continue', function () { go('e-p7-5'); }, true));
  };

  // ====== Page 7.5: email (new, autofill-enabled). FIRST COMMITMENT --
  // writes the leads row with the name already captured at page 5.5,
  // exactly once. Resubmit-after-Back reuses the existing lead id via
  // update_lead_contact instead of a second insert -- same class of bug
  // #2075's round-2 review caught on d-email, fixed the same way here
  // from the start. ======
  RENDERERS['e-p7-5'] = function () {
    root.appendChild(backButton(goBack));
    root.appendChild(heading('What is a good email address to reach you?'));
    var emailF = field('eEmail', 'Email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '320' });
    var submitBtn = continueButton('Continue', onSubmit, true);
    root.appendChild(submitBtn);
    var busy = false;

    function onSubmit() {
      if (busy) return; // double-tap guard -- same reasoning as
      // js/router-variant-d.js's d-professional-industry: this is the one
      // screen in the homeowner track with an RPC between the tap and the
      // next screen render.
      emailF.err.textContent = '';
      var value = emailF.input.value.trim();
      if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        emailF.err.textContent = 'Please enter a valid email address.';
        return;
      }
      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }

      // Resubmit path: a lead row already exists (Back from a later
      // screen, correct the email, Continue again) -- PATCH it, never
      // insert a second row/admin alert. Mirrors js/router-variant-d.js's
      // own d-email resubmit branch, including using `.then(null, fn)`
      // rather than `.catch(fn)` directly on the rpc() thenable --
      // supabase-js 2.112.4's `.rpc(...)` result has no `.catch()` of its
      // own (see that file's own extensive comment on this exact bug,
      // #2075 round 3's BLOCKER finding).
      if (leadId) {
        busy = true;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Please wait...';
        email = value;
        bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: name, p_email: email, p_phone: null }).then(null, function () {});
        go('e-p8');
        return;
      }

      busy = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait...';

      bridge.insertFreshLead(name, value, null).then(function (newId) {
        email = value;
        leadId = newId;

        function proceed() {
          go('e-p8');
        }
        bridge.sb.rpc('set_lead_role', { p_lead_id: newId, p_role: 'homeowner' }).then(function (res) {
          if (res && res.error) throw res.error;
          proceed();
        }).catch(function (roleErr) {
          console.error('[router-variant-e] set_lead_role failed -- proceeding anyway:', roleErr);
          proceed();
        });
      }).catch(function (err) {
        console.error('[router-variant-e] email save failed:', err);
        busy = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        bridge.showError('Something went wrong saving your info. Please try again.');
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

  // ====== Page 9: exposition (15 minutes) ======
  RENDERERS['e-p9'] = function () {
    root.appendChild(bodyText(E_COPY.p9));
    root.appendChild(continueButton('Continue', function () { go('e-p10'); }, true));
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

  // ====== Page 11: exposition (40% roofing stat) ======
  RENDERERS['e-p11'] = function () {
    root.appendChild(bodyText(E_COPY.p11));
    root.appendChild(continueButton('Continue', function () { go('e-p12'); }, true));
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
  // shape as js/router-variant-d.js's own d-phone. ======
  RENDERERS['e-p13'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(bodyText(RD.COPY.home8Text));
    var phoneF = field('ePhone', 'Phone Number', 'tel', { autocomplete: 'tel', inputmode: 'tel', maxlength: '20' }, true);
    var submitBtn = continueButton('Continue', onSubmit, true);
    root.appendChild(submitBtn);

    function finish() {
      emitComplete('e-p13');
      HOOK_measurementPurchase();
      redirectWithLeadId(bridge.ROLE_DESTINATIONS.homeowner, leadId);
    }

    function onSubmit() {
      phoneF.err.textContent = '';
      var raw = phoneF.input.value.trim();
      if (raw && !isValidUsPhone(raw)) {
        phoneF.err.textContent = 'Please enter a valid 10-digit US phone number.';
        return;
      }
      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait...';
      // gh-2075 round 2 precedent (finding 3): does NOT re-enable on
      // success -- finish() below navigates away (redirect), so there is
      // no screen left to re-enable it on; a failure falls through to
      // finish() anyway (same "never strand the visitor" rule every RPC
      // on this router already follows), never re-enabling either.
      var phoneDigits = raw ? normalizePhone(raw) : null;
      bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: name, p_email: email, p_phone: phoneDigits }).then(function (res) {
        if (res && res.error) {
          console.error('[router-variant-e] update_lead_contact (phone) failed -- proceeding anyway:', res.error);
        }
        finish();
      }).catch(function (err) {
        console.error('[router-variant-e] update_lead_contact (phone) threw -- proceeding anyway:', err);
        finish();
      });
    }
  };

  function redirectWithLeadId(destBase, id) {
    var sep = destBase.indexOf('?') === -1 ? '?' : '&';
    var withLead = destBase + sep + 'lead=' + encodeURIComponent(id);
    bridge.redirectTo(bridge.appendParams(withLead, bridge.collectAttribution()), true);
  }

  // ====== Professional / contractor tracks -- arm C's own screens,
  // unchanged, reused verbatim (see this file's own top-of-file comment
  // for why these are re-implemented here rather than delegated to arm
  // C's internal sequencer). Pending #2084. ======
  RENDERERS['e-prof-entry'] = function () {
    var RD = window.RouterDiscovery;
    // Arm C's own full five-industry order (PARTNER_INDUSTRY_ORDER),
    // unrestricted -- unlike #2075's own d-professional-industry, which
    // narrows to two because ITS OWN page-1 tap target already says
    // "real estate or insurance". This arm's page-1 option 2 is arm C's
    // unrestricted "I am a professional..." row, so this screen offers
    // arm C's unrestricted five.
    var order = ['re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'];
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

  RENDERERS['e-realtor-1'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.realtorQ1Heading, options: RD.COPY.realtorQ1Options, onSelect: function (idx) { answers.realtorQ1 = RD.COPY.realtorQ1Options[idx - 1]; go('e-realtor-2'); } });
  };
  RENDERERS['e-realtor-2'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.realtorQ2Heading, options: RD.COPY.realtorQ2Options, onSelect: function (idx) { answers.realtorQ2 = RD.COPY.realtorQ2Options[idx - 1]; go('e-realtor-3'); } });
  };
  RENDERERS['e-realtor-3'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.realtorQ3Heading, options: RD.COPY.realtorQ3Options, onSelect: function (idx) { answers.realtorQ3 = RD.COPY.realtorQ3Options[idx - 1]; go('e-realtor-4'); } });
  };
  RENDERERS['e-realtor-4'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.realtorQ4Heading, options: RD.COPY.realtorQ4Options, onSelect: function (idx) { answers.realtorQ4 = RD.COPY.realtorQ4Options[idx - 1]; go('e-realtor-close'); } });
  };
  function HOOK_partnerSignupComplete() { /* see gh-2078; intentionally not implemented in gh-2076 */ }
  RENDERERS['e-realtor-close'] = function () {
    var RD = window.RouterDiscovery;
    RD.COPY.realtorClose.forEach(function (p) { root.appendChild(bodyText(p)); });
    root.appendChild(continueButton('Continue', function () { go('e-realtor-contact'); }, true));
  };
  RENDERERS['e-realtor-contact'] = function () {
    renderGenericContact({
      role: 'referral_partner',
      partnerIndustry: 're_agent',
      destination: bridge.PARTNER_INDUSTRY_DESTINATIONS.re_agent,
      completeToken: 'e-realtor-contact',
      afterHook: HOOK_partnerSignupComplete
    });
  };

  RENDERERS['e-ins-1'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ1Heading, options: RD.COPY.insQ1Options, onSelect: function (idx) { answers.insQ1 = RD.COPY.insQ1Options[idx - 1]; go('e-ins-2'); } });
  };
  RENDERERS['e-ins-2'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ2Heading, options: RD.COPY.insQ2Options, onSelect: function (idx) { answers.insQ2 = RD.COPY.insQ2Options[idx - 1]; go('e-ins-3'); } });
  };
  RENDERERS['e-ins-3'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ3Heading, options: RD.COPY.insQ3Options, onSelect: function (idx) { answers.insQ3 = RD.COPY.insQ3Options[idx - 1]; go('e-ins-4'); } });
  };
  RENDERERS['e-ins-4'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ4Heading, options: RD.COPY.insQ4Options, onSelect: function (idx) { answers.insQ4 = RD.COPY.insQ4Options[idx - 1]; go('e-ins-5'); } });
  };
  RENDERERS['e-ins-5'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ5Heading, options: RD.COPY.insQ5Options, onSelect: function (idx) { answers.insQ5 = RD.COPY.insQ5Options[idx - 1]; go('e-ins-6'); } });
  };
  RENDERERS['e-ins-6'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ6Heading, options: RD.COPY.insQ6Options, onSelect: function (idx) { answers.insQ6 = RD.COPY.insQ6Options[idx - 1]; go('e-ins-7'); } });
  };
  RENDERERS['e-ins-7'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ7Heading, options: RD.COPY.insQ7Options, onSelect: function (idx) { answers.insQ7 = RD.COPY.insQ7Options[idx - 1]; go('e-ins-close'); } });
  };
  RENDERERS['e-ins-close'] = function () {
    var RD = window.RouterDiscovery;
    RD.COPY.insClose.forEach(function (p) { root.appendChild(bodyText(p)); });
    root.appendChild(continueButton('Continue', function () { go('e-ins-contact'); }, true));
  };
  RENDERERS['e-ins-contact'] = function () {
    renderGenericContact({
      role: 'referral_partner',
      partnerIndustry: 'insurance_agent',
      destination: bridge.PARTNER_INDUSTRY_DESTINATIONS.insurance_agent,
      completeToken: 'e-ins-contact',
      afterHook: HOOK_partnerSignupComplete
    });
  };

  RENDERERS['e-contractor-1'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.contractorQ1Heading, options: RD.COPY.contractorQ1Options, onSelect: function (idx) { answers.contractorQ1 = RD.COPY.contractorQ1Options[idx - 1]; go('e-contractor-2'); } });
  };
  RENDERERS['e-contractor-2'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.contractorQ2Heading, options: RD.COPY.contractorQ2Options, onSelect: function (idx) { answers.contractorQ2 = RD.COPY.contractorQ2Options[idx - 1]; go('e-contractor-3'); } });
  };
  RENDERERS['e-contractor-3'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.contractorQ3Heading, options: RD.COPY.contractorQ3Options, onSelect: function (idx) { answers.contractorQ3 = RD.COPY.contractorQ3Options[idx - 1]; go('e-contractor-4'); } });
  };
  RENDERERS['e-contractor-4'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.contractorQ4Heading, options: RD.COPY.contractorQ4Options, onSelect: function (idx) { answers.contractorQ4 = RD.COPY.contractorQ4Options[idx - 1]; go('e-contractor-5'); } });
  };
  RENDERERS['e-contractor-5'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(bodyText(RD.COPY.contractorQ5Text));
    root.appendChild(continueButton('Continue', function () { go('e-contractor-contact'); }, true));
  };
  RENDERERS['e-contractor-contact'] = function () {
    renderGenericContact({
      role: 'contractor',
      partnerIndustry: null,
      destination: bridge.ROLE_DESTINATIONS.contractor,
      completeToken: 'e-contractor-contact',
      afterHook: null
    });
  };

  // -- Shared name/email/phone contact-capture screen for the
  // professional/contractor tracks -- same shape as
  // js/router-discovery.js's own renderPartnerContact (not exported, so
  // reimplemented here with this file's own DOM ids to avoid any
  // collision), since #2076 does not split contact capture on these
  // tracks the way it does on the homeowner script. Guarded against a
  // double-tap the same way every other single-shot insert screen on
  // this router already is. --
  function renderGenericContact(cfg) {
    var busy = false;
    var nameF = field('eGenName', 'Full Name', 'text', { autocomplete: 'name', maxlength: '200' });
    var emailF = field('eGenEmail', 'Email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '320' });
    var phoneF = field('eGenPhone', 'Phone Number', 'tel', { autocomplete: 'tel', inputmode: 'tel', maxlength: '20' }, true);
    var submitBtn = continueButton('Continue', onSubmit, true);
    root.appendChild(submitBtn);

    function onSubmit() {
      if (busy) return;
      nameF.err.textContent = '';
      emailF.err.textContent = '';
      phoneF.err.textContent = '';
      var nameVal = nameF.input.value.trim();
      var emailVal = emailF.input.value.trim();
      var phoneRaw = phoneF.input.value.trim();
      var hasError = false;
      if (!nameVal) { nameF.err.textContent = 'Please enter your name.'; hasError = true; }
      if (!emailVal || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) { emailF.err.textContent = 'Please enter a valid email address.'; hasError = true; }
      if (phoneRaw && !isValidUsPhone(phoneRaw)) { phoneF.err.textContent = 'Please enter a valid 10-digit US phone number.'; hasError = true; }
      if (hasError) return;
      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }

      busy = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait...';
      var phoneDigits = phoneRaw ? normalizePhone(phoneRaw) : null;

      bridge.insertFreshLead(nameVal, emailVal, phoneDigits).then(function (newId) {
        var payload = { p_lead_id: newId, p_role: cfg.role };
        if (cfg.partnerIndustry) payload.p_partner_industry = cfg.partnerIndustry;

        function proceed() {
          emitComplete(cfg.completeToken);
          if (cfg.afterHook) cfg.afterHook();
          redirectWithLeadId(cfg.destination, newId);
        }
        bridge.sb.rpc('set_lead_role', payload).then(function (res) {
          if (res && res.error) throw res.error;
          proceed();
        }).catch(function (roleErr) {
          console.error('[router-variant-e] set_lead_role failed -- proceeding to destination anyway:', roleErr);
          proceed();
        });
      }).catch(function (err) {
        console.error('[router-variant-e] contact save failed:', err);
        busy = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        bridge.showError('Something went wrong saving your info. Please try again.');
      });
    }
  }

  // -- Lazy-load js/router-discovery.js -- unlike #2075's own
  // loadDiscoveryModule() (called only once a visitor clears
  // d-email/d-name/d-phone), this arm's very FIRST screen (e-p1) is arm
  // C's own role screen and needs RD.COPY/renderSingleSelect
  // immediately, so this file loads it once, at init(), before anything
  // renders -- there is no earlier screen of this arm's own that could
  // render without it. start.html itself still only fetches THIS file
  // (js/router-variant-e.js) for an arm-e visitor, exactly like arm D's
  // own wiring -- js/router-discovery.js is fetched by this module, not
  // by start.html, and only for a visitor who actually lands on arm e. --
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
    loadDiscoveryModule().then(function () {
      show('e-p1');
    }).catch(function (err) {
      console.error('[router-variant-e] failed to load js/router-discovery.js:', err);
      bridge.showError('Something went wrong loading this page. Please refresh and try again.');
    });
  }

  window.RouterVariantE = { init: init };
})();
