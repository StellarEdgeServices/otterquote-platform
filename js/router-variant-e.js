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
// variant c." Screen 1 (role tap) and the contractor track are therefore
// arm C's own screens, unchanged, reused via window.RouterDiscovery's
// exported COPY/renderMultiSelect/renderSingleSelect/renderDisqualifier/
// renderPartnerContact and its exported PARTNER_INDUSTRY_ORDER/
// REALTOR_TRACK/INSURANCE_TRACK/CONTRACTOR_TRACK track definitions
// (PR #2088 round 1, item 6). This file adds NOT ONE WORD of new copy
// for any reused C question/option screen.
//
// gh-2084 (this file's own professional-path build, Sloane's approved
// script, #2077 close): the Professional -> Real Estate and Professional
// -> Insurance branches now get the SAME exposition-before-question
// treatment as the homeowner path above, using Sloane's approved copy
// (ceo57-sloane-variant-e-pro-20260921.md, quoted verbatim in PRO_COPY
// below). Every existing arm C professional question/option stays
// verbatim, read from window.RouterDiscovery.COPY/REALTOR_TRACK/
// INSURANCE_TRACK exactly as the contractor track already does -- only
// the exposition screens between them are new. Locked defaults (Dustin,
// #2077, "Approved. No edits."):
//   1. Page 4(a) opener is Alt A ("kill a deal or delay closing").
//   2. The fee sentence stays confined to the two close screens only
//      (RD.COPY.realtorClose[1]/insClose[1]) -- never repeated, never
//      paraphrased, never moved to an exposition screen.
//   3. Page 14(b) is the safe default (competing-bids-vs-pitch); the
//      "Nearly 40%" stat (E_COPY.p11, homeowner-only) is NOT approved
//      for the professional surface and must never appear here.
//   4. Hand-off skips the phone re-ask entirely and goes straight to
//      partner-re.html/partner-insurance.html once name (captured at the
//      *-5-5 screen) and email (captured at the *-9-5 screen) are known
//      -- no phone field exists anywhere on this path.
//   5. Home Inspector/Adjuster/Other stay on arm C's own flow (unchanged
//      direct redirect) -- out of scope for #2084.
// Unlike the homeowner path's split insert-then-PATCH (#2076), the
// professional path holds name/email as client-side state only (proName/
// proEmail below) and makes exactly ONE lead-row commitment, at the
// close screen's own "Next" tap (e-pro-12a / e-pro-18b) -- there is no
// earlier row to correct, so none of e-p7-5's/e-p13's resubmit/PATCH
// machinery applies here.
//
// gh-2078 (gh-2011's sub-issue, NOT this issue) -- SHIPPED, repointed:
// partner_signup_complete does NOT fire from this router file. It fires
// from the STATIC PARTNER PAGE this file hands off to
// (partner-re.html / partner-insurance.html), immediately after that
// page's own register_partner call succeeds and its confirmation UI
// renders (GA4 partner_signup_complete + Meta CompleteRegistration; see
// those files' own firePartnerSignupComplete()). The router never learns
// whether signup actually completed -- proCloseRenderer's finish() below
// only knows the HAND-OFF happened, not the outcome -- so it cannot be
// the right place to emit this event. HOOK_partnerSignupComplete() below
// is kept as a documented no-op (not removed) so anyone re-reading this
// file sees a pointer to where the real event lives instead of a second,
// competing implementation; do not add a real emit here.
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
// numbered pages, 'e-p4a'/'e-p4b' for the payer-branch pair). The
// professional path (#2084) uses its own 'e-pro-<n>' tokens, matching
// Sloane's script's own page numbers (e.g. 'e-pro-4a', 'e-pro-5-5a'),
// on every page including exposition pages.
// router_disqualified fires once per (session, source screen), identical
// semantics to arms C/D's own dedupe (see DQ_SOURCE below).
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

  // gh-2084 -- Professional-path exposition copy, Sloane's approved
  // script (ceo57-sloane-variant-e-pro-20260921.md), quoted verbatim
  // including punctuation/spacing, cleared via #2077's "Approved. No
  // edits." close. Pages 12(a)/18(b) are NOT here -- they reuse
  // RD.COPY.realtorClose/insClose verbatim (see proCloseRenderer below).
  var PRO_COPY = {
    p2: 'Otter Quotes helps your clients get better bids on repair work. We build the scope of work, send it to multiple contractors, and they bid right here on our site — so you\'re not the one chasing quotes for them.',
    // Real Estate branch -- Alt A (locked default 1).
    p4a: 'A home that fails inspection over a roof or repair issue can kill a deal or delay closing. When you can hand your client one place to get it fixed fast, the deal keeps moving instead of stalling.',
    p6a: 'Finding a contractor your client can trust takes calls, research, and follow-up — time you don\'t have between showings and closings. Otter Quotes does that legwork for you.',
    p8a: 'Who you send a client to reflects on you. If the job goes badly, your client remembers who referred them. When contractors compete for the work, no single name is riding on the outcome.',
    p10a: 'You\'re already doing this for your clients — finding them a contractor after an inspection, a repair need, or a deal that\'s stuck. It costs you time. This next question is about getting something back for it.',
    // Insurance branch.
    p4b: 'Contractors often tell your policyholder their only cost is the deductible, then quietly upcharge for better materials or warranties. When contractors compete for the job, those upgrades stop costing your client extra.',
    p6b: 'Explaining the claims process and vetting a contractor for every policyholder eats into your day. Sending one link lets Otter Quotes do that legwork instead of you.',
    p8b: 'The contractor a client works with reflects on you too. If the job goes badly, your client remembers who they called first. Competition among contractors takes that risk off you.',
    p10b: 'The shingle a contractor installs affects how long your client\'s roof lasts. Give them a reason to choose the option that holds up, not just the cheapest one.',
    p12b: 'A warranty is only as good as the company standing behind it once the contractor is gone. Competing bids let your client see the warranty before they need it.',
    // Locked default 3 -- Alt A (safe default). Alt B ("Nearly 40%") is
    // NOT approved for this surface and must never be used here.
    p14b: 'A contractor who wins the job on the pitch alone hasn\'t proven anything about the work. Competing bids let your client judge on materials and price instead.',
    p16b: 'You\'re already trying to get your clients the best outcome after a claim — recommending contractors, suggesting they get bids. Otter Quotes gives you one link that does it automatically.'
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

  // gh-2084 -- professional-path client-side state. Distinct from the
  // homeowner path's own name/email/answers above so neither path can
  // ever cross-contaminate the other's in-memory state, even though only
  // one role's screens ever run in a given page load.
  var proName = null;
  var proEmail = null;
  var proAnswers = {};

  var activeToken = null;
  var stack = [];
  var disqualifiedFired = {};
  var DQ_SOURCE = {
    'e-dq-p6': 'e-p6',
    'e-dq-p8': 'e-p8',
    'e-dq-p10': 'e-p10',
    'e-dq-p12': 'e-p12'
  };

  // gh-2096 item 4: step_index (1-based), one lookup table for this arm,
  // same depth-within-track convention as js/router-discovery.js and
  // js/router-variant-d.js (see the former's own comment) -- e-p1 is the
  // shared entry, then the homeowner/professional/contractor tracks each
  // restart their own depth count from the screen right after it, so
  // e.g. e-p2, e-pro-2 and e-contractor-1 (each track's own first screen)
  // share index 2. Realtor/insurance run in lockstep through their
  // shared question shape (e-pro-Na/e-pro-Nb) until insurance keeps
  // going past the realtor track's own close. Disqualifier tokens are
  // derived from DQ_SOURCE above, never hand-duplicated. Contractor's
  // own e-contractor-1..4 are registered dynamically (registerReusedTracks
  // below), not as literal RENDERERS[...] assignments, but their tokens
  // are fixed (prefix 'e-contractor-' + 1-based question number) and
  // listed here the same as every other token.
  var STEP_INDEX = {
    'e-p1': 1,
    // Homeowner track.
    'e-p2': 2, 'e-p3': 3, 'e-p4a': 4, 'e-p4b': 4, 'e-p5': 5, 'e-p5-5': 6,
    'e-p6': 7, 'e-p7': 8, 'e-p7-5': 9, 'e-p8': 10, 'e-p9': 11, 'e-p10': 12,
    'e-p11': 13, 'e-p12': 14, 'e-p13': 15,
    // Professional entry (parallel to e-p2/e-contractor-1).
    'e-pro-2': 2, 'e-pro-3': 3,
    // Realtor branch.
    'e-pro-4a': 4, 'e-pro-5a': 5, 'e-pro-5-5a': 6, 'e-pro-6a': 7,
    'e-pro-7a': 8, 'e-pro-8a': 9, 'e-pro-9a': 10, 'e-pro-9-5a': 11,
    'e-pro-10a': 12, 'e-pro-11a': 13, 'e-pro-12a': 14,
    // Insurance branch (longer than realtor's).
    'e-pro-4b': 4, 'e-pro-5b': 5, 'e-pro-5-5b': 6, 'e-pro-6b': 7,
    'e-pro-7b': 8, 'e-pro-8b': 9, 'e-pro-9b': 10, 'e-pro-9-5b': 11,
    'e-pro-10b': 12, 'e-pro-11b': 13, 'e-pro-12b': 14, 'e-pro-13b': 15,
    'e-pro-14b': 16, 'e-pro-15b': 17, 'e-pro-16b': 18, 'e-pro-17b': 19,
    'e-pro-18b': 20,
    // Contractor track (parallel to e-p2/e-pro-2).
    'e-contractor-1': 2, 'e-contractor-2': 3, 'e-contractor-3': 4,
    'e-contractor-4': 5, 'e-contractor-5': 6, 'e-contractor-contact': 7
  };
  Object.keys(DQ_SOURCE).forEach(function (dqToken) { STEP_INDEX[dqToken] = STEP_INDEX[DQ_SOURCE[dqToken]]; });

  // gh-2096 item 1: fires GA4 router_contact_submitted + Meta Lead
  // exactly once per session, the first time ANY track's first
  // commitment (e-p7-5's fresh insert for homeowner, proEmailRenderer's
  // fresh insert for realtor/insurance, or router-discovery.js's shared
  // renderPartnerContact for contractor) successfully creates the lead
  // row -- mirroring js/router-variant-d.js's own `leadEventFired` guard,
  // so a later resubmit/PATCH on the same screen (a typo correction) can
  // never fire a second Lead event for the same person.
  var leadEventFired = false;
  function fireContactSubmitted(step) {
    bridge.trackRouter('router_contact_submitted', { step: step, step_index: STEP_INDEX[step] });
    if (!leadEventFired) {
      leadEventFired = true;
      try { fbq('track', 'Lead'); } catch (e) {}
    }
  }

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

  // gh-2084 (review round 1, item 1): the professional path's lead row
  // is now written at the EMAIL screen (e-pro-9-5a/e-pro-9-5b), the same
  // point arm D/E's homeowner path commits its own first row -- ruling
  // recorded on #2084: an early row means a drop-off after the email
  // screen still leaves a lead. proEmailInsertPromise is that screen's
  // own in-flight guard, same defensive shape as p75InsertPromise.
  var proEmailInsertPromise = null;

  // gh-2084 (review round 1, item 1): the close screen (e-pro-12a /
  // e-pro-18b) no longer inserts -- leadId already exists by the time a
  // visitor reaches it. Its own "Next" tap PATCHes via
  // update_lead_contact (falling back to insertLeadAndSetRole on
  // data:false, exactly as e-p13 does) and redirects with that same
  // leadId. proCloseSubmitPromise is that screen's own in-flight guard.
  var proCloseSubmitPromise = null;

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

  // gh-2096 item 4: step_index attached here, from STEP_INDEX above.
  function emitView(token) { bridge.trackRouter('router_step_view', { step: token, step_index: STEP_INDEX[token] }); }
  function emitComplete(token) { bridge.trackRouter('router_step_complete', { step: token, step_index: STEP_INDEX[token] }); }
  function emitDisqualified(sourceToken) { bridge.trackRouter('router_disqualified', { step: sourceToken, step_index: STEP_INDEX[sourceToken] }); }

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
  // e-p4b, e-p7, e-p9, e-p11, and every gh-2084 'e-pro-*' exposition
  // screen) advance with a single synchronous go() call and no network
  // round-trip, so a fast real double-tap can land its second tap on
  // whatever the NEXT screen renders at the same on-screen position
  // (round 1's repro: e-p11 -> e-p12, second tap lands on e-p12's own
  // first, disqualifying option). A per-render `fired` flag alone does
  // not stop this -- the second tap hits a DIFFERENT element (the next
  // screen's), not the same button twice. The actual guard is the
  // capturing-phase listener init() attaches to `root` (see below): it
  // drops any click within a short window of the CURRENT screen having
  // been shown, so the accidental second tap is swallowed before it ever
  // reaches the newly-rendered screen's own handler, for every screen
  // this file renders (its own exposition buttons AND arm C's own reused
  // option rows), without needing any change to arm C's code.
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
        // gh-2084: Professional now leads with its own shared exposition
        // (e-pro-2) before arm C's own industry picker (e-pro-3).
        if (idx === 2) { go('e-pro-2'); return; }
        role = 'contractor';
        go('e-contractor-1');
      }
    });
  };

  // ====== Exposition screens (pages 2, 4a, 4b, 7, 9, 11) -- one
  // paragraph, one guarded Continue tap, nothing else. ======
  function expositionRenderer(text, nextToken, label) {
    return function () {
      root.appendChild(bodyText(text));
      var fired = false;
      root.appendChild(continueButton(label || 'Continue', function () {
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
  // gh-2084 review round 1, item 4: Sloane's script labels every
  // professional-path exposition tap "Next", not "Continue" -- the
  // homeowner path's own exposition screens (E_COPY.*, above) keep
  // "Continue" unchanged.
  function proExpositionRenderer(text, nextToken) {
    return expositionRenderer(text, nextToken, 'Next');
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
  //
  // gh-2084: generalized (was insertFreshLeadAndSetRole(nm, em,
  // phoneDigits), hardcoded to p_role:'homeowner') to accept the role/
  // partnerIndustry to write, so the professional path's own single
  // hand-off commitment (see proCloseRenderer below) can share this same
  // insert-then-set-role sequence rather than duplicating it. Every
  // existing homeowner call site below now passes ('homeowner', null)
  // explicitly.
  function insertLeadAndSetRole(nm, em, phoneDigits, roleForRpc, partnerIndustryForRpc) {
    return bridge.insertFreshLead(nm, em, phoneDigits, bridge.oqInternalOverride).then(function (newId) {
      return new Promise(function (resolve) {
        var payload = { p_lead_id: newId, p_role: roleForRpc };
        if (partnerIndustryForRpc) payload.p_partner_industry = partnerIndustryForRpc;
        bridge.sb.rpc('set_lead_role', payload).then(function (res) {
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
          return insertLeadAndSetRole(name, email, null, 'homeowner', null).then(function (newId) { leadId = newId; });
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
      // (Threaded inside insertLeadAndSetRole, shared with both
      // `data:false` fallbacks above/below.)
      var p = insertLeadAndSetRole(name, value, null, 'homeowner', null).then(function (newId) {
        email = value;
        leadId = newId;
        // gh-2096 item 1: this is the homeowner track's own first
        // commitment (this screen's own top-of-file comment) -- the same
        // moment js/router-variant-d.js fires its own Lead event.
        fireContactSubmitted('e-p7-5');
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

  // gh-2078 -- SHIPPED, repointed (see this file's top-of-file comment):
  // partner_signup_complete fires from partner-re.html/partner-insurance.html's
  // own confirmation screen, not from this router. This stays a deliberate
  // no-op -- do not implement the emit here, it would double-count
  // alongside the static pages' own firePartnerSignupComplete().
  function HOOK_partnerSignupComplete() { /* see gh-2078; the real event fires on the partner page's confirmation screen, not here */ }

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
        return insertLeadAndSetRole(name, email, phoneDigits, 'homeowner', null).then(function (newId) {
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

  // ====== gh-2084 -- Professional path: Real Estate / Insurance
  // branches. Every existing arm C professional question/option below is
  // read live from window.RouterDiscovery.COPY/REALTOR_TRACK/
  // INSURANCE_TRACK at RENDER time (never retyped) -- only the
  // exposition screens interspersed between them (PRO_COPY above) are
  // new. Home Inspector/Adjuster/Other and the contractor track are
  // OUT OF SCOPE for #2084 and stay exactly as arm C already handles
  // them (see e-pro-3 and the "Professional / contractor tracks"
  // registration below). ======

  // One professional-track question screen, reading arm C's own
  // REALTOR_TRACK/INSURANCE_TRACK entry `idx` at render time (RD is
  // always loaded by the time any e-pro-* screen renders).
  function proQuestionRenderer(trackName, idx, nextToken) {
    return function () {
      var RD = window.RouterDiscovery;
      var q = RD[trackName][idx];
      root.appendChild(backButton(goBack));
      RD.renderSingleSelect(root, {
        heading: RD.COPY[q.headingKey],
        options: RD.COPY[q.optionsKey],
        onSelect: function (choice) {
          proAnswers[q.answerKey] = RD.COPY[q.optionsKey][choice - 1];
          go(nextToken);
        }
      });
    };
  }

  // New name-capture screen (gh-2084 pages 5.5a/5.5b) -- client-side
  // only, no leads row yet, same reasoning as e-p5-5 above.
  function proNameRenderer(nextToken) {
    return function () {
      root.appendChild(backButton(goBack));
      root.appendChild(heading('What\'s your name?'));
      var form = wrapInForm(onSubmit);
      root.appendChild(form);
      var nameF = field('eProName', 'Name', 'text', { autocomplete: 'name', maxlength: '200' }, false, form);
      nameF.input.value = proName || '';
      form.appendChild(continueButton('Continue', onSubmit, true));
      function onSubmit() {
        nameF.err.textContent = '';
        var value = nameF.input.value.trim();
        if (!value) { nameF.err.textContent = 'Please enter your name.'; return; }
        proName = value;
        go(nextToken);
      }
    };
  }

  // Email-capture screen (gh-2084 pages 9.5a/9.5b) -- gh-2084 review
  // round 1, item 1: this is now the professional path's FIRST
  // COMMITMENT, exactly the role e-p7-5 plays for the homeowner path --
  // it writes the leads row (insert + set_lead_role, role=
  // 'referral_partner', the given partnerIndustryKey) with the name
  // already captured at the previous screen. Ruling recorded on #2084:
  // an early row here means a visitor who drops off after this screen
  // still leaves a lead, instead of only ever writing one at the close
  // screen a drop-off would never reach. Same defensive shape as
  // e-p7-5: a re-entry while a fresh insert is still pending renders a
  // wait state and resolves forward once that SAME request settles;
  // resubmit-after-Back (leadId already set) PATCHes via
  // update_lead_contact, falling back to a fresh insertLeadAndSetRole on
  // a `data:false` result, mirroring e-p7-5's own resubmit path exactly.
  function proEmailRenderer(nextToken, partnerIndustryKey) {
    return function () {
      var myToken = activeToken;

      if (proEmailInsertPromise) {
        root.appendChild(heading('What\'s a good email address to reach you?'));
        root.appendChild(continueButton('Please wait…', function () {}, false));
        proEmailInsertPromise.then(function () {
          if (activeToken === myToken) go(nextToken);
        }, function () { /* the original submit's own handler already surfaced the error */ });
        return;
      }

      var backBtn = backButton(goBack);
      root.appendChild(backBtn);
      root.appendChild(heading('What\'s a good email address to reach you?'));
      var form = wrapInForm(onSubmit);
      root.appendChild(form);
      var emailF = field('eProEmail', 'Email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '320' }, false, form);
      emailF.input.value = proEmail || '';
      var submitBtn = continueButton('Continue', onSubmit, true);
      form.appendChild(submitBtn);

      function onSubmit() {
        if (proEmailInsertPromise) return;

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
        emailF.input.readOnly = true;

        if (leadId) {
          proEmail = value;
          var patchP = bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: proName, p_email: proEmail, p_phone: null }).then(function (res) {
            if (res && res.data === true) { return; }
            return insertLeadAndSetRole(proName, proEmail, null, 'referral_partner', partnerIndustryKey).then(function (newId) { leadId = newId; });
          }, function () { /* thrown/rejected rpc -- proceed anyway */ }).then(function () {
            if (activeToken === myToken) go(nextToken);
          }, function () {
            if (activeToken === myToken) go(nextToken);
          });
          proEmailInsertPromise = patchP;
          patchP.then(function () { proEmailInsertPromise = null; }, function () { proEmailInsertPromise = null; });
          return;
        }

        var p = insertLeadAndSetRole(proName, value, null, 'referral_partner', partnerIndustryKey).then(function (newId) {
          proEmail = value;
          leadId = newId;
          // gh-2096 item 1: the professional path's own first commitment
          // (this function's own top-of-file comment) -- `myToken` is
          // whichever of e-pro-9-5a/e-pro-9-5b this screen actually is,
          // captured at the top of this renderer.
          fireContactSubmitted(myToken);
          return newId;
        });

        proEmailInsertPromise = p;
        p.then(function () {
          proEmailInsertPromise = null;
          if (activeToken === myToken) go(nextToken);
        }, function (err) {
          proEmailInsertPromise = null;
          console.error('[router-variant-e] professional email save failed:', err);
          if (activeToken === myToken) {
            submitBtn.disabled = false;
            backBtn.disabled = false;
            submitBtn.textContent = 'Continue';
            emailF.input.readOnly = false;
            bridge.showError('Something went wrong saving your info. Please try again.');
          }
        });
      }
    };
  }

  // Hand-off / close screen (gh-2084 pages 12(a)/18(b)) -- renders arm
  // C's own realtorClose/insClose paragraphs VERBATIM (fee sentence +
  // D-266 disclaimer stay exactly where those arrays already show them,
  // never repositioned). gh-2084 review round 1, item 1: the lead row
  // already exists by the time a visitor reaches this screen (written
  // at the email screen above), so "Next" no longer inserts -- it
  // PATCHes via update_lead_contact (the same call e-p13 makes, and the
  // same `data:false` -> insertLeadAndSetRole fallback e-p13 falls back
  // to) and redirects with the existing leadId (or the fallback's new
  // one). Same defensive in-flight guard (proCloseSubmitPromise) as
  // every other submit on this router -- Back and Next are both
  // disabled for the duration, and a second Enter/click while the
  // request is in flight is a complete no-op. No phone field exists on
  // this screen or anywhere else on the professional path (locked
  // default 4).
  function proCloseRenderer(copyKey, partnerIndustryKey, completeToken) {
    return function () {
      var myToken = activeToken;
      var RD = window.RouterDiscovery;
      RD.COPY[copyKey].forEach(function (p) { root.appendChild(bodyText(p)); });
      var backBtn = backButton(goBack);
      root.appendChild(backBtn);
      var submitBtn = continueButton('Next', onSubmit, true);
      root.appendChild(submitBtn);

      function finish(newId) {
        emitComplete(completeToken);
        // gh-2078: partner_signup_complete fires on the destination
        // page's own confirmation screen, not here -- see
        // HOOK_partnerSignupComplete's own comment above.
        HOOK_partnerSignupComplete();
        redirectWithLeadId(bridge.PARTNER_INDUSTRY_DESTINATIONS[partnerIndustryKey], newId);
      }

      function onSubmit() {
        if (proCloseSubmitPromise) return;
        if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }
        partnerIndustry = partnerIndustryKey;
        submitBtn.disabled = true;
        backBtn.disabled = true;
        submitBtn.textContent = 'Please wait…';
        var p = bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: proName, p_email: proEmail, p_phone: null }).then(function (res) {
          if (res && res.data === true) { return leadId; }
          // Same data:false fallback as e-p13/e-p7-5: the guard (30-
          // minute window, or prefill already used) refused the write --
          // fall back to a fresh row via the shared helper (which also
          // calls set_lead_role) rather than stranding this visitor.
          return insertLeadAndSetRole(proName, proEmail, null, 'referral_partner', partnerIndustryKey).then(function (newId) {
            leadId = newId;
            return newId;
          });
        }, function (err) {
          console.error('[router-variant-e] professional hand-off update_lead_contact threw -- proceeding anyway:', err);
          return leadId;
        });
        proCloseSubmitPromise = p;
        p.then(function (newId) {
          proCloseSubmitPromise = null;
          if (activeToken === myToken) finish(newId);
        }, function (err) {
          proCloseSubmitPromise = null;
          console.error('[router-variant-e] professional hand-off save failed:', err);
          if (activeToken === myToken) {
            submitBtn.disabled = false;
            backBtn.disabled = false;
            submitBtn.textContent = 'Next';
            bridge.showError('Something went wrong saving your info. Please try again.');
          }
        });
      }
    };
  }

  // -- Shared exposition + industry picker (gh-2084 pages 2 and 3) --
  RENDERERS['e-pro-2'] = proExpositionRenderer(PRO_COPY.p2, 'e-pro-3');
  RENDERERS['e-pro-3'] = function () {
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
        if (industry === 're_agent') { go('e-pro-4a'); return; }
        if (industry === 'insurance_agent') { go('e-pro-4b'); return; }
        // home_inspector/adjuster/other -- locked default 5: stay on arm
        // C's own flow, unchanged -- straight to their destination page
        // with attribution only, no lead id, exactly as arm C's own
        // c-prof-entry already does.
        emitComplete('e-pro-3');
        var dest = bridge.PARTNER_INDUSTRY_DESTINATIONS[industry];
        bridge.redirectTo(bridge.appendParams(dest, bridge.collectAttribution()), true);
      }
    });
  };

  // -- Real Estate branch (gh-2084 pages 4(a)-12(a), 11 pages) --
  RENDERERS['e-pro-4a'] = proExpositionRenderer(PRO_COPY.p4a, 'e-pro-5a');
  RENDERERS['e-pro-5a'] = proQuestionRenderer('REALTOR_TRACK', 0, 'e-pro-5-5a');
  RENDERERS['e-pro-5-5a'] = proNameRenderer('e-pro-6a');
  RENDERERS['e-pro-6a'] = proExpositionRenderer(PRO_COPY.p6a, 'e-pro-7a');
  RENDERERS['e-pro-7a'] = proQuestionRenderer('REALTOR_TRACK', 1, 'e-pro-8a');
  RENDERERS['e-pro-8a'] = proExpositionRenderer(PRO_COPY.p8a, 'e-pro-9a');
  RENDERERS['e-pro-9a'] = proQuestionRenderer('REALTOR_TRACK', 2, 'e-pro-9-5a');
  RENDERERS['e-pro-9-5a'] = proEmailRenderer('e-pro-10a', 're_agent');
  RENDERERS['e-pro-10a'] = proExpositionRenderer(PRO_COPY.p10a, 'e-pro-11a');
  RENDERERS['e-pro-11a'] = proQuestionRenderer('REALTOR_TRACK', 3, 'e-pro-12a');
  RENDERERS['e-pro-12a'] = proCloseRenderer('realtorClose', 're_agent', 'e-pro-12a');

  // -- Insurance branch (gh-2084 pages 4(b)-18(b), 17 pages) --
  RENDERERS['e-pro-4b'] = proExpositionRenderer(PRO_COPY.p4b, 'e-pro-5b');
  RENDERERS['e-pro-5b'] = proQuestionRenderer('INSURANCE_TRACK', 0, 'e-pro-5-5b');
  RENDERERS['e-pro-5-5b'] = proNameRenderer('e-pro-6b');
  RENDERERS['e-pro-6b'] = proExpositionRenderer(PRO_COPY.p6b, 'e-pro-7b');
  RENDERERS['e-pro-7b'] = proQuestionRenderer('INSURANCE_TRACK', 1, 'e-pro-8b');
  RENDERERS['e-pro-8b'] = proExpositionRenderer(PRO_COPY.p8b, 'e-pro-9b');
  RENDERERS['e-pro-9b'] = proQuestionRenderer('INSURANCE_TRACK', 2, 'e-pro-9-5b');
  RENDERERS['e-pro-9-5b'] = proEmailRenderer('e-pro-10b', 'insurance_agent');
  RENDERERS['e-pro-10b'] = proExpositionRenderer(PRO_COPY.p10b, 'e-pro-11b');
  RENDERERS['e-pro-11b'] = proQuestionRenderer('INSURANCE_TRACK', 3, 'e-pro-12b');
  RENDERERS['e-pro-12b'] = proExpositionRenderer(PRO_COPY.p12b, 'e-pro-13b');
  RENDERERS['e-pro-13b'] = proQuestionRenderer('INSURANCE_TRACK', 4, 'e-pro-14b');
  // Locked default 3: Alt A only (safe default) -- see PRO_COPY.p14b's
  // own comment above. The "Nearly 40%" alternative is never wired here.
  RENDERERS['e-pro-14b'] = proExpositionRenderer(PRO_COPY.p14b, 'e-pro-15b');
  RENDERERS['e-pro-15b'] = proQuestionRenderer('INSURANCE_TRACK', 5, 'e-pro-16b');
  RENDERERS['e-pro-16b'] = proExpositionRenderer(PRO_COPY.p16b, 'e-pro-17b');
  RENDERERS['e-pro-17b'] = proQuestionRenderer('INSURANCE_TRACK', 6, 'e-pro-18b');
  RENDERERS['e-pro-18b'] = proCloseRenderer('insClose', 'insurance_agent', 'e-pro-18b');

  // ====== Contractor track -- arm C's own screens, unchanged, reused via
  // js/router-discovery.js's exported renderPartnerContact and
  // CONTRACTOR_TRACK (#2088 round 1, item 6). Registered once RD has
  // loaded (registerReusedTracks(), called from init()'s own
  // loadDiscoveryModule().then()) since it reads that export at
  // REGISTRATION time, not at render time. Out of scope for #2084. ======
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
    registerQuestionTrack('e-contractor', RD.CONTRACTOR_TRACK, 'e-contractor-5', RD);
  }

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
      completeToken: 'e-contractor-contact',
      stepIndex: STEP_INDEX['e-contractor-contact'],
      // gh-2096 REVIEW finding 2 (PR #2114, comment 5796844493, non-
      // blocking): router-discovery.js's shared renderPartnerContact fires
      // Meta Lead unconditionally by default -- correct for C's own three
      // tracks, which have no other Lead-firing path, but this track is
      // reached from E, where e-p7-5/proEmailRenderer's own commitment may
      // already have fired Lead for this session (leadEventFired above).
      // Route this call site through that SAME guard instead of a second,
      // undeduped fbq call, so a visitor who already fired Lead on one
      // track and then also completes the contractor track (e.g. via Back
      // navigation) does not get counted twice.
      fireLead: function () {
        if (!leadEventFired) {
          leadEventFired = true;
          try { fbq('track', 'Lead'); } catch (e) {}
        }
      }
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
    //
    // gh-2084 (review round 1, item 2): the professional close screens
    // (e-pro-12a / e-pro-18b) have the exact same in-flight-submit-then-
    // bfcache-restore exposure as e-p13 -- add them to the same
    // recovery list rather than a second listener. leadId is module
    // state, unaffected by the restore, so the re-rendered screen's own
    // "Next" tap still reuses it (via proCloseRenderer's own PATCH path)
    // instead of ever inserting a second row.
    var BFCACHE_RECOVERABLE = { 'e-p13': true, 'e-pro-12a': true, 'e-pro-18b': true };
    window.addEventListener('pageshow', function (e) {
      if (e.persisted && BFCACHE_RECOVERABLE[activeToken]) { show(activeToken); }
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
