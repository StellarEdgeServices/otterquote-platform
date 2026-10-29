// gh-2075 (D-327): Variant D -- role tap first, one email field, everything
// else deferred to after that first commitment. Filed by Ben (CEO RUN 57)
// from Dustin's verbatim decision, 2026-09-21: A/B lose 90%+ of visitors at
// the very first screen; D is the stripped-down, best-practice replacement.
//
// This is a MODULE, not a second page (same constraint #2011/#2017 impose
// on arm C -- /start?v=d has to stay /start). start.html loads this file by
// injecting a <script> element ONLY when variant === 'd' (dormant today --
// see start.html's own ARM_D/LIVE_VARIANTS comments: `variant` cannot be
// 'd' until the orchestrator flips LIVE_VARIANTS at merge), then calls
// window.RouterVariantD.init(bridge, root) once it has loaded.
//
// Screens, in order (gh-3136 / P14 shortened flow; was issue #2075's longer list):
//   1. d-role    -- three tap targets, no typing: Homeowner / Professional
//                   (real estate or insurance) / Contractor. Skipped on
//                   ?entry=home (homeowner is implied).
//   2. d-email   -- ONE input + Continue. First commitment: writes the
//                   leads row (variant 'd', role, email, the utm/first-touch
//                   fields the router already captures) and emits Meta Lead.
//                   Contractor branches straight to the existing
//                   contractor-join path from here.
//   3. d-contact -- name (required) + phone (optional) on ONE screen. For
//                   homeowners it also shows RouterDiscovery.COPY.home8Text
//                   verbatim (C4, Tier C legal/fee text, relocated from the
//                   cut d-summary screen). Continue hands off to get-started.
//   Professionals: d-professional-industry (real estate or insurance), then
//      arm C's realtor or insurance question set verbatim, then arm C's own
//      close paragraphs. Every heading/option/close string for those
//      reused screens is read from window.RouterDiscovery.COPY (js/router-
//      discovery.js) -- this file defines no new copy for them.
//   CUT in gh-3136: the six homeowner screening questions (d-trades,
//      d-payer, d-hidden-costs, d-time, d-criteria, d-online), the four
//      d-dq-* "not a fit" interstitials, d-summary, and the separate
//      d-name / d-phone screens (merged into d-contact).
//
// Contact capture: d-email creates the lead row (email only; leads.email is
// NOT NULL, leads.name/phone are nullable -- verified against supabase/
// migrations/20260101000000_v000_baseline_schema.sql); d-contact PATCHes
// that same row via update_lead_contact (name, then phone -- gh-2042: phone
// optional there too), never a second insert.
//
// Analytics: router_step_view fires on every screen view, router_step_
// complete on leaving one -- step tokens are `d-role`, `d-email`,
// `d-contact`, `d-<question>`. router_disqualified is no longer emitted for
// the homeowner track (DQ_SOURCE below is empty after the screening cut).
//
// gh-2078 (gh-2011's sub-issue, NOT this issue): the two conversion events
// -- measurement_purchase (homeowner) and partner_signup_complete
// (professional) -- gh-2078 SHIPPED: neither is emitted anywhere in this
// file. Both fire on OTHER pages, downstream of every hand-off this file
// performs (measurement_purchase from the React measurement-checkout
// success callback, help-measurements/page.tsx; partner_signup_complete
// from the referral-agent signup confirmation screen, partner-re.html /
// partner-insurance.html). This file marks where its own responsibility
// ends with a named, no-op hook function at each hand-off point -- see
// HOOK_measurementPurchase / HOOK_partnerSignupComplete below -- so the
// boundary is visible in code, not just in an issue cross-reference. Do
// not implement either event here; it would double-count.
//
// Performance (#2075's own budget, #2063/#2083's shared fix): the role
// screen (d-role) must paint and be tappable before ANY third-party tag
// executes, and no Supabase client is needed until d-email's submit.
// This file achieves both by construction, not by a special-case guard:
// - It is loaded directly by start.html (not chained after js/router-
//   discovery.js), so d-role's render waits on exactly one script fetch,
//   the same as arm C's single-file load.
//   window.RouterVariantD.init() below.
// - js/router-discovery.js -- the file this module reuses COPY/rendering
//   from for every screen AFTER d-contact (and the home8Text on d-contact itself) -- is fetched lazily, on demand,
//   only when a visitor actually reaches the first reused question screen
//   (loadDiscoveryModule() below), never at d-role's paint. A visitor who
//   never gets that far (drops at d-role/d-email, or is
//   the contractor branch, which never reaches a reused screen at all)
//   never fetches it.
// - bridge.sb (below) is the same lazy `ensureSb()` getter every other
//   arm on this page already uses -- the Supabase client is created on
//   FIRST USE (d-email's submit), never at load.
(function () {
  'use strict';

  var bridge = null;
  var root = null;

  // ── State, held client-side only for the lifetime of this page load
  // (cleared implicitly on reload -- no resume-a-session feature is asked
  // for, same as arm C). `role` is the mapped DB value (leads.role's own
  // three-value CHECK: 'homeowner' | 'contractor' | 'referral_partner'),
  // set at d-role; `partnerIndustry` ('re_agent' | 'insurance_agent') is
  // set one screen later, at d-professional-industry, once known. ──
  var role = null;
  var partnerIndustry = null;
  var leadId = null;
  var email = null;
  var name = null;
  // gh-2075 round 2, review report ceo57-review-pr2086-20260921 finding 2:
  // Back-from-d-name then resubmitting the email must not create a second
  // leads row / second Meta Lead / second admin alert (leads insert fires
  // trg_notify_admin_new_router_lead). Guards both.
  var leadEventFired = false;

  // Same per-screen answer bag as arm C keeps (js/router-discovery.js),
  // for the same reason stated there: none of these fields has a column
  // on public.leads today, so they are held here rather than discarded,
  // in case a later issue needs the scope-of-work detail.
  var answers = {
    trades: [],
    payer: null,
    hiddenCosts: [],
    timeInvestment: null,
    selectionCriteria: [],
    online: null
  };

  // Module-owned navigation stack -- NOT the browser's history/popstate,
  // same as arm C (js/router-discovery.js's own comment on this same
  // pattern applies verbatim here: a hardware/browser Back simply leaves
  // /start?v=d, an acceptable default matching the existing precedent).
  var activeToken = null;
  var stack = [];
  var disqualifiedFired = {};
  // gh-3136 (P14): the four d-dq-* interstitials are cut with the screening questions.
  var DQ_SOURCE = {};


  // gh-2096 item 4: step_index (1-based), one lookup table for this arm,
  // same depth-within-track convention as js/router-discovery.js's own
  // STEP_INDEX (see that file's comment) -- d-role/d-email/d-name/d-phone
  // are shared by every role, then the homeowner/realtor/insurance
  // tracks each restart their own count from the screen right after
  // d-phone, so e.g. d-trades and d-professional-industry (the first
  // screen of their own tracks) share an index. Disqualifier tokens are
  // derived from DQ_SOURCE above, never hand-duplicated.
  var STEP_INDEX = {
    // gh-3136 (P14): d-name + d-phone merged into d-contact; the homeowner
    // track is now d-role(1, skipped on ?entry=home) -> d-email(2) ->
    // d-contact(3) -> redirect. Indexes are consecutive.
    'd-role': 1, 'd-email': 2, 'd-contact': 3,
    // Professional entry.
    'd-professional-industry': 4,
    // Realtor track.
    'd-realtor-1': 5, 'd-realtor-2': 6, 'd-realtor-3': 7, 'd-realtor-4': 8,
    'd-realtor-close': 9,
    // Insurance track.
    'd-ins-1': 5, 'd-ins-2': 6, 'd-ins-3': 7, 'd-ins-4': 8, 'd-ins-5': 9,
    'd-ins-6': 10, 'd-ins-7': 11, 'd-ins-close': 12
  };
  Object.keys(DQ_SOURCE).forEach(function (dqToken) { STEP_INDEX[dqToken] = STEP_INDEX[DQ_SOURCE[dqToken]]; });

  // ── DOM helpers. Kept local (not imported from RouterDiscovery) because
  // d-role/d-email/d-name/d-phone render BEFORE that module is ever
  // fetched (see the lazy-load comment at the top of this file) -- this
  // file cannot depend on it for those four screens. Reuses the exact same
  // CSS classes start.html's own <style> block and js/router-discovery.js
  // both already rely on (.role-options/.role-option/.router-sub/
  // .form-group/.form-label/.form-input/.field-error/.btn.btn-primary.
  // router-btn/.router-back) -- no new class, no new stylesheet. ──
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

  // gh-1940: GA4 router_contact_submitted + Meta Lead, once per page life,
  // the first time this arm's first commitment (the d-email submit that
  // creates the leads row) succeeds. Arms C/E/F already fire the GA4 event at
  // their equivalent point (gh-2096 item 1); arm D, a live random arm, fired
  // only the Meta Lead, so the funnel's contact count by variant read 0 for D
  // (GA4 2026-09-21 -> 2026-10-05: router_contact_submitted c 13, e 28, f 4,
  // d 0 beside 193 d step views). Shares the existing leadEventFired guard, so
  // a typo-correction resubmit never fires a second event. Params are the
  // closed step/step_index pair only -- no field value reaches GA4.
  function fireContactSubmitted() {
    if (leadEventFired) return;
    leadEventFired = true;
    bridge.trackRouter('router_contact_submitted', { step: 'd-email', step_index: STEP_INDEX['d-email'] });
    try { fbq('track', 'Lead'); } catch (e) {}
  }
  function emitDisqualified(sourceToken) { bridge.trackRouter('router_disqualified', { step: sourceToken, step_index: STEP_INDEX[sourceToken] }); }

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

  // ── gh-2042 precedent: phone is optional everywhere on this router.
  // Duplicated locally (not imported) for the same reason start.html and
  // js/router-discovery.js each keep their own copy: neither of those
  // files loads before this one for every screen this validator is
  // needed on (d-phone renders before router-discovery.js is fetched). ──
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
    root.appendChild(group);
    return { input: input, err: err };
  }

  // ══════════════════════ Screen 1: role tap ══════════════════════
  // No typing, three large tap targets (#2075's own labels, verbatim from
  // the issue body) -- tapping advances immediately, same one-tap
  // convention arm A/B/C's own role rows already use.
  var ROLE_TAP = [
    { label: 'Homeowner', role: 'homeowner' },
    { label: 'Professional (real estate or insurance)', role: 'referral_partner' },
    { label: 'Contractor', role: 'contractor' }
  ];
  RENDERERS['d-role'] = function () {
    // "I am a..." matches start.html's own #step2 heading verbatim (not
    // new copy -- an existing structural label already shipped on this
    // same page for the same question).
    root.appendChild(heading('I am a…'));
    var wrap = el('div', 'role-options');
    ROLE_TAP.forEach(function (opt) {
      var btn = el('button', 'role-option', null);
      btn.type = 'button';
      btn.appendChild(document.createTextNode(opt.label + ' '));
      btn.appendChild(el('span', 'role-arrow', '→'));
      btn.addEventListener('click', function () {
        role = opt.role;
        // gh-2096 item 2: step -- role is always picked on d-role.
        bridge.trackRouter('router_role_selected', { role: role, step: 'd-role', step_index: STEP_INDEX['d-role'] });
        go('d-email');
      });
      wrap.appendChild(btn);
    });
    root.appendChild(wrap);
  };

  // ══════════════════════ Screen 2: one email field ══════════════════════
  // The first commitment. Nothing else on this screen -- no name, no
  // phone, no role confirmation text (#2075: "One email field ... Nothing
  // else on the screen"). Writes the leads row and sets role immediately
  // (role is already known from d-role, unlike arm C where a homeowner's
  // role is implicit and a professional's role write waits for the
  // industry pick -- D's own d-role screen already captured it).
  RENDERERS['d-email'] = function () {
    root.appendChild(backButton(goBack));
    root.appendChild(heading('What is your email?'));
    var emailF = field('dEmail', 'Email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '320' });
    var submitBtn = continueButton('Continue', onSubmit, true);
    root.appendChild(submitBtn);

    function onSubmit() {
      emailF.err.textContent = '';
      var value = emailF.input.value.trim();
      if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        emailF.err.textContent = 'Please enter a valid email address.';
        return;
      }
      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }

      // gh-2075 round 2, review report ceo57-review-pr2086-20260921
      // finding 2 (blocking, real-browser evidence: role -> email -> Back
      // -> corrected email produced TWO leads rows, TWO admin alerts, TWO
      // Meta Lead events): a lead row already exists once `leadId` is
      // set -- resubmitting here (the realistic trigger is a typo
      // correction) must PATCH it, not insert again. Arm A already solved
      // this exact problem with its own sessionStorage resubmit path; arm
      // C cannot hit it because its contact capture is its LAST screen.
      //
      // gh-2075 round 3, re-review report ceo57-review2-pr2086-20260921,
      // additional finding (a): round 2 guarded this with
      // `role !== 'contractor'`, on the theory that the contractor branch
      // below is terminal and this screen would never be re-entered with
      // role='contractor'. That theory was wrong: Back all the way to
      // d-role, tapping Contractor, then Back to d-email and resubmitting
      // reaches this exact function with `leadId` already set AND
      // role==='contractor' -- round 2's guard excluded that case, so it
      // fell through to the full insert path below and created a SECOND
      // leads row and a second admin alert, the same bug this branch
      // exists to prevent for every other role. The role guard is gone;
      // this branch now handles every role, including contractor, and
      // dispatches to the SAME next step a fresh submit would reach for
      // whatever role is currently selected -- d-name's own
      // update_lead_contact call (which always sends `p_email: email`)
      // is what actually writes the corrected address for the
      // homeowner/professional paths.
      //
      // gh-2075 round 3 BLOCKER fix (re-review finding, real-browser
      // evidence: `.catch is not a function` thrown on this exact line,
      // trapping the visitor on d-email with every further tap also
      // throwing): supabase-js 2.112.4's `.rpc(...)` call returns a
      // then-able with a `.then(onFulfilled, onRejected)` method but NO
      // `.catch()` -- `.catch()` only exists once something has already
      // called `.then()` on it and gotten back a real native Promise (see
      // every OTHER `bridge.sb.rpc(...)` call site in this file, which
      // all chain `.then(fn).catch(fn)` and are therefore safe -- this
      // was the one call site in this file that skipped straight to
      // `.catch()`). Two-argument `.then(onFulfilled, onRejected)` is the
      // form every thenable, including this one, is required to support.
      if (leadId) {
        email = value;
        bridge.sb.rpc('set_lead_role', { p_lead_id: leadId, p_role: role }).then(null, function () {});
        if (role === 'contractor') {
          fireContactSubmitted();
          redirectWithLeadId(bridge.ROLE_DESTINATIONS.contractor, leadId);
          return;
        }
        go('d-contact');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';

      // gh-2598 slice 6: the homepage ZIP (validated five digits, read-and-cleared by start.html) rides on a HOMEOWNER's row only, in the
      // existing allow-listed `zip` column. Anyone else (role changed via Back) gets exactly the insert they always did.
      var homeZipExtra = (role === 'homeowner' && bridge.homeEntry && bridge.homeEntry.zip) ? { zip: bridge.homeEntry.zip } : undefined;
      bridge.insertFreshLead(null, value, null, undefined, undefined, homeZipExtra).then(function (newId) {
        email = value;
        leadId = newId;

        function proceed() {
          // Meta Lead -- same bare call as start.html's own Step 1 and
          // contractor-join.html:376's precedent, no PII payload. Guarded
          // to fire AT MOST ONCE per page life (gh-2075 round 2 finding
          // 2) -- the resubmit branch above already returns before
          // reaching here, but this also covers a bfcache restore or any
          // other path that could otherwise reach `proceed()` twice.
          fireContactSubmitted();

          if (role === 'contractor') {
            // #2075: "Contractor role routes to the existing
            // contractor-join path after the email screen" -- no name,
            // phone, or questions for this role. redirectWithLeadId
            // mirrors arm C's own helper of the same name. Terminal
            // (no go() call follows), so this IS the one place that
            // emits d-email's own router_step_complete.
            emitComplete('d-email');
            redirectWithLeadId(bridge.ROLE_DESTINATIONS.contractor, leadId);
            return;
          }
          // Not emitComplete()'d here -- go() below already emits
          // router_step_complete for 'd-email' (activeToken is still
          // 'd-email' until show() runs). See d-professional-industry's
          // own comment on this exact pattern.
          go('d-contact');
        }

        bridge.sb.rpc('set_lead_role', { p_lead_id: newId, p_role: role }).then(function (res) {
          if (res && res.error) throw res.error;
          proceed();
        }).catch(function (roleErr) {
          console.error('[router-variant-d] set_lead_role failed -- proceeding anyway:', roleErr);
          proceed();
        });
      }).catch(function (err) {
        console.error('[router-variant-d] email save failed:', err);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        bridge.showError('Something went wrong saving your info. Please try again.');
      });
    }
  };

  // ══════════════════════ Screen 3: contact (name + optional phone) ══════
  // gh-3136 (P14): d-name and d-phone merged into one screen. Both
  // update_lead_contact writes are kept, in the same order as before (name
  // first with p_phone null, then name+phone), with the same validation.
  // C4 (Tier C, legal/fee text): RD.COPY.home8Text, byte-identical, moved
  // here from the cut d-summary screen. Homeowners only (as d-summary was);
  // professionals never saw it and still do not.
  RENDERERS['d-contact'] = function () {
    root.appendChild(backButton(goBack));
    root.appendChild(heading('What is your name?'));
    if (role === 'homeowner') {
      root.appendChild(bodyText(window.RouterDiscovery.COPY.home8Text));
    }
    var nameF = field('dName', 'Full Name', 'text', { autocomplete: 'name', maxlength: '200' });
    var phoneF = field('dPhone', 'Phone Number', 'tel', { autocomplete: 'tel', inputmode: 'tel', maxlength: '20' }, true);
    var submitBtn = continueButton('Continue', onSubmit, true);
    root.appendChild(submitBtn);

    function afterContact() {
      // Button stays disabled ("Please wait...") for the rest of this
      // screen's life: the next step is a redirect or a lazy-load (same
      // reasoning as the old d-phone screen, gh-2075 round 2 finding 3).
      if (role === 'referral_partner') { go('d-professional-industry'); return; }
      // Homeowner: identical to the old d-summary Continue.
      emitComplete('d-contact');
      HOOK_measurementPurchase();
      redirectWithLeadId(bridge.ROLE_DESTINATIONS.homeowner, leadId);
    }

    function onSubmit() {
      nameF.err.textContent = '';
      phoneF.err.textContent = '';
      var value = nameF.input.value.trim();
      var raw = phoneF.input.value.trim();
      if (!value) { nameF.err.textContent = 'Please enter your name.'; return; }
      if (raw && !isValidUsPhone(raw)) {
        phoneF.err.textContent = 'Please enter a valid 10-digit US phone number.';
        return;
      }
      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';

      var phoneDigits = raw ? normalizePhone(raw) : null;
      function writePhone() {
        bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: name, p_email: email, p_phone: phoneDigits }).then(function (res) {
          if (res && res.error) {
            console.error('[router-variant-d] update_lead_contact (phone) failed -- proceeding anyway:', res.error);
          }
          afterContact();
        }).catch(function (err) {
          console.error('[router-variant-d] update_lead_contact (phone) threw -- proceeding anyway:', err);
          afterContact();
        });
      }
      bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: value, p_email: email, p_phone: null }).then(function (res) {
        name = value;
        if (res && res.error) {
          console.error('[router-variant-d] update_lead_contact (name) failed -- proceeding anyway:', res.error);
        }
        writePhone();
      }).catch(function (err) {
        console.error('[router-variant-d] update_lead_contact (name) threw -- proceeding anyway:', err);
        name = value;
        writePhone();
      });
    }
  };

  // ══════════ Lazy-load js/router-discovery.js (see this file's own
  // top-of-file comment for why this happens only here, not at init()) ══
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

  // Every reused screen below is only ever entered through go(), which
  // only ever runs after loadDiscoveryModule() has already resolved once
  // (see d-trades'/d-professional-industry's own go() call sites), so
  // COPY/renderMultiSelect/renderSingleSelect/renderDisqualifier are safe
  // to read from window.RouterDiscovery directly inside these RENDERERS.

  // gh-3136 (P14): d-trades, d-payer, d-hidden-costs, d-time, d-criteria, d-online,
  // the four d-dq-* interstitials and d-summary are removed (screening cut; the
  // C4 paragraph now renders on d-contact).
  // gh-2078 HOOK POINT (not implemented here, on purpose): a homeowner's
  // real conversion event -- measurement_purchase -- fires downstream, in
  // the React app's measurement-checkout success callback, once #2078
  // lands. This no-op documents exactly where D's own responsibility ends:
  // the redirect below hands the visitor to /get-started carrying
  // variant='d' (via bridge.collectAttribution()), which is what lets that
  // downstream event attribute back to this arm. Do not implement the
  // actual event here -- #2078 owns it.
  function HOOK_measurementPurchase() { /* see gh-2078; the real event fires from help-measurements/page.tsx's checkout success, not here */ }
  // ══════════════════ Professional track ══════════════════
  // #2075's own role tap combines real estate and insurance into one
  // "Professional" target; this screen is the one extra question needed
  // to split them, restricted to the two industries #2075 names (arm C's
  // own c-prof-entry offers all five agent-types; D's tap target does
  // not, so its industry picker does not either). Heading/sub copy and
  // option labels both come from the same sources arm C already uses
  // (RD.COPY.profEntryHeading/profEntrySub, window.AgentTypes.CHOOSER_LABELS)
  // -- no new copy.
  RENDERERS['d-professional-industry'] = function () {
    var RD = window.RouterDiscovery;
    var labels = (window.AgentTypes && window.AgentTypes.CHOOSER_LABELS) || {};
    var order = ['re_agent', 'insurance_agent'];
    // gh-2075 round 2, review report ceo57-review-pr2086-20260921 finding
    // 4 (blocking, real-browser evidence: a second tap 150ms after the
    // first, with set_lead_role delayed 1.5s, produced set_lead_role
    // {re_agent} twice and a duplicate d-realtor-1 view/complete/view):
    // renderSingleSelect's rows advance on a single tap by design (see
    // that function's own comment in js/router-discovery.js) with no
    // built-in re-entrancy guard, and this is the one screen in this
    // module with an RPC between the tap and the next screen -- same
    // class of bug as start.html's own setIndustryButtonsDisabled()
    // exists to prevent on its own industry picker. C's own c-prof-entry
    // has no RPC at this point, so it is not exposed there.
    var busy = false;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, {
      heading: RD.COPY.profEntryHeading,
      sub: RD.COPY.profEntrySub,
      options: order.map(function (code) { return labels[code] || code; }),
      onSelect: function (idx) {
        if (busy) return;
        busy = true;
        partnerIndustry = order[idx - 1];
        // Not emitComplete()'d here -- the go() call inside
        // proceedToTrack() below already emits router_step_complete for
        // this token (activeToken is still 'd-professional-industry'
        // until show() runs). Emitting it here too would double-count.
        bridge.sb.rpc('set_lead_role', { p_lead_id: leadId, p_role: 'referral_partner', p_partner_industry: partnerIndustry }).then(function (res) {
          if (res && res.error) console.error('[router-variant-d] set_lead_role (industry) failed -- proceeding anyway:', res.error);
          proceedToTrack();
        }).catch(function (err) {
          console.error('[router-variant-d] set_lead_role (industry) threw -- proceeding anyway:', err);
          proceedToTrack();
        });
        function proceedToTrack() {
          if (partnerIndustry === 're_agent') { go('d-realtor-1'); return; }
          go('d-ins-1');
        }
      }
    });
  };

  RENDERERS['d-realtor-1'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.realtorQ1Heading, options: RD.COPY.realtorQ1Options, onSelect: function (idx) { answers.realtorQ1 = RD.COPY.realtorQ1Options[idx - 1]; go('d-realtor-2'); } });
  };
  RENDERERS['d-realtor-2'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.realtorQ2Heading, options: RD.COPY.realtorQ2Options, onSelect: function (idx) { answers.realtorQ2 = RD.COPY.realtorQ2Options[idx - 1]; go('d-realtor-3'); } });
  };
  RENDERERS['d-realtor-3'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.realtorQ3Heading, options: RD.COPY.realtorQ3Options, onSelect: function (idx) { answers.realtorQ3 = RD.COPY.realtorQ3Options[idx - 1]; go('d-realtor-4'); } });
  };
  RENDERERS['d-realtor-4'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.realtorQ4Heading, options: RD.COPY.realtorQ4Options, onSelect: function (idx) { answers.realtorQ4 = RD.COPY.realtorQ4Options[idx - 1]; go('d-realtor-close'); } });
  };
  // gh-2078 HOOK POINT (not implemented here, on purpose): a professional's
  // real conversion event -- partner_signup_complete -- fires downstream
  // once the referral_agents row exists and the confirmation screen
  // renders on partner-re.html/partner-insurance.html, once #2078 lands.
  // See HOOK_measurementPurchase's own comment above -- same boundary,
  // same reason it is a no-op here.
  function HOOK_partnerSignupComplete() { /* see gh-2078; the real event fires on the partner page's confirmation screen, not here */ }
  RENDERERS['d-realtor-close'] = function () {
    var RD = window.RouterDiscovery;
    RD.COPY.realtorClose.forEach(function (p) { root.appendChild(bodyText(p)); });
    root.appendChild(continueButton('Continue', function () {
      emitComplete('d-realtor-close');
      HOOK_partnerSignupComplete();
      redirectWithLeadId(bridge.PARTNER_INDUSTRY_DESTINATIONS.re_agent, leadId);
    }, true));
  };

  RENDERERS['d-ins-1'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ1Heading, options: RD.COPY.insQ1Options, onSelect: function (idx) { answers.insQ1 = RD.COPY.insQ1Options[idx - 1]; go('d-ins-2'); } });
  };
  RENDERERS['d-ins-2'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ2Heading, options: RD.COPY.insQ2Options, onSelect: function (idx) { answers.insQ2 = RD.COPY.insQ2Options[idx - 1]; go('d-ins-3'); } });
  };
  RENDERERS['d-ins-3'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ3Heading, options: RD.COPY.insQ3Options, onSelect: function (idx) { answers.insQ3 = RD.COPY.insQ3Options[idx - 1]; go('d-ins-4'); } });
  };
  RENDERERS['d-ins-4'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ4Heading, options: RD.COPY.insQ4Options, onSelect: function (idx) { answers.insQ4 = RD.COPY.insQ4Options[idx - 1]; go('d-ins-5'); } });
  };
  RENDERERS['d-ins-5'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ5Heading, options: RD.COPY.insQ5Options, onSelect: function (idx) { answers.insQ5 = RD.COPY.insQ5Options[idx - 1]; go('d-ins-6'); } });
  };
  RENDERERS['d-ins-6'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ6Heading, options: RD.COPY.insQ6Options, onSelect: function (idx) { answers.insQ6 = RD.COPY.insQ6Options[idx - 1]; go('d-ins-7'); } });
  };
  RENDERERS['d-ins-7'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, { heading: RD.COPY.insQ7Heading, options: RD.COPY.insQ7Options, onSelect: function (idx) { answers.insQ7 = RD.COPY.insQ7Options[idx - 1]; go('d-ins-close'); } });
  };
  RENDERERS['d-ins-close'] = function () {
    var RD = window.RouterDiscovery;
    RD.COPY.insClose.forEach(function (p) { root.appendChild(bodyText(p)); });
    root.appendChild(continueButton('Continue', function () {
      emitComplete('d-ins-close');
      HOOK_partnerSignupComplete();
      redirectWithLeadId(bridge.PARTNER_INDUSTRY_DESTINATIONS.insurance_agent, leadId);
    }, true));
  };

  // Mirrors js/router-discovery.js's own redirectWithLeadId exactly (same
  // reason it exists there: this file also never lets start.html's own
  // module-level `leadId`/`ROLE_DESTINATIONS` auto-append machinery run --
  // bridge.redirectTo(dest, preBuilt) is always called with preBuilt=true
  // here, and the lead id is appended by hand first).
  function redirectWithLeadId(destBase, id) {
    var sep = destBase.indexOf('?') === -1 ? '?' : '&';
    var withLead = destBase + sep + 'lead=' + encodeURIComponent(id);
    bridge.redirectTo(bridge.appendParams(withLead, bridge.collectAttribution()), true);
  }

  // go() past d-phone always targets a RENDERERS key that needs
  // window.RouterDiscovery -- ensure it is loaded before entering any of
  // those tokens. Wrapping `go` itself (rather than every call site above)
  // keeps this a single choke point.
  var realGo = go;
  go = function (token) {
    var needsDiscovery = token !== 'd-role' && token !== 'd-email';
    if (!needsDiscovery) { realGo(token); return; }
    loadDiscoveryModule().then(function () { realGo(token); }).catch(function (err) {
      console.error('[router-variant-d] failed to load js/router-discovery.js:', err);
      bridge.showError('Something went wrong loading this page. Please refresh and try again.');
    });
  };

  function init(injectedBridge, mountEl) {
    bridge = injectedBridge;
    root = mountEl || document.getElementById('routerDRoot');
    if (!root) { return; }
    root.setAttribute('data-rd-root', '1');
    // gh-2598 slice 6: a visitor sent here by a homeowner button on the new homepage (?entry=home) has already said who they are, so the
    // "I am a..." screen is skipped. 'd-role' goes on the back stack, so Back from d-email still reaches it. No role-selected event is
    // emitted: nobody tapped d-role. start.html reads and clears the stored ZIP; bridge.homeEntry carries the result.
    if (bridge.homeEntry && bridge.homeEntry.skipRole) {
      role = 'homeowner';
      stack.push('d-role');
      show('d-email');
      return;
    }
    show('d-role');
  }

  window.RouterVariantD = { init: init };
})();
