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
// Screens, in order (brief, issue #2075):
//   1. d-role    -- three tap targets, no typing: Homeowner / Professional
//                   (real estate or insurance) / Contractor.
//   2. d-email   -- ONE input + Continue. Nothing else. First commitment:
//                   writes the leads row (variant 'd', role, email, the
//                   utm/first-touch fields the router already captures)
//                   and emits Meta Lead. Contractor branches straight to
//                   the existing contractor-join path from here -- no
//                   name/phone/questions for that role (brief, issue body).
//   3. d-name    -- one field, required.
//   4. d-phone   -- one field, optional/skippable (gh-2042 precedent: phone
//                   is optional everywhere else on this router already).
//   5+ role-specific questions -- REUSED, not reauthored: homeowner gets
//      arm C's home2-home7 question set verbatim (trades/payer/hidden-
//      costs/time-investment/selection-criteria/online-comfort, same four
//      disqualifier branches), then a closing screen using arm C's own
//      home8 paragraph; professional picks real estate or insurance, then
//      gets arm C's realtor or insurance question set verbatim, then arm
//      C's own close paragraphs. Every heading/option/disqualifier/close
//      string below is read from window.RouterDiscovery.COPY (js/router-
//      discovery.js) -- this file does not define a single word of new
//      copy for any reused screen, per the work order ("reuse C's step
//      components and copy verbatim -- no new copy in D").
//
// Contact capture is SPLIT across d-email/d-name/d-phone (unlike arm C,
// which collects name+email+phone together at the very end) -- that split
// is D's entire point (#2075: "no typing until a single email field, defer
// name/phone/all other data to after that first commitment"). A lead row
// exists after d-email (email only; leads.email is NOT NULL, leads.name/
// phone are nullable -- verified against supabase/migrations/
// 20260101000000_v000_baseline_schema.sql); d-name and d-phone each PATCH
// that same row via update_lead_contact (gh-2042: phone optional there
// too), never a second insert.
//
// Analytics: router_step_view fires on every screen view, router_step_
// complete on leaving one -- step tokens are `d-role`, `d-email`, `d-name`,
// `d-phone`, `d-<question>` (issue #2075's own naming). router_disqualified
// fires once per (session, source screen), identical semantics to arm C's
// own dedupe (see DQ_SOURCE below) -- carries the ORIGINAL screen's token,
// never the dq screen's own token, matching arm C's D-2 control.
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
//   from for every screen AFTER d-phone -- is fetched lazily, on demand,
//   only when a visitor actually reaches the first reused question screen
//   (loadDiscoveryModule() below), never at d-role's paint. A visitor who
//   never gets that far (drops at d-role/d-email/d-name/d-phone, or is
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
  var DQ_SOURCE = {
    'd-dq-hidden-costs': 'd-hidden-costs',
    'd-dq-time': 'd-time',
    'd-dq-criteria': 'd-criteria',
    'd-dq-online': 'd-online'
  };

  // gh-2096 item 4: step_index (1-based), one lookup table for this arm,
  // same depth-within-track convention as js/router-discovery.js's own
  // STEP_INDEX (see that file's comment) -- d-role/d-email/d-name/d-phone
  // are shared by every role, then the homeowner/realtor/insurance
  // tracks each restart their own count from the screen right after
  // d-phone, so e.g. d-trades and d-professional-industry (the first
  // screen of their own tracks) share an index. Disqualifier tokens are
  // derived from DQ_SOURCE above, never hand-duplicated.
  var STEP_INDEX = {
    'd-role': 1, 'd-email': 2, 'd-name': 3, 'd-phone': 4,
    // Homeowner track.
    'd-trades': 5, 'd-payer': 6, 'd-hidden-costs': 7, 'd-time': 8,
    'd-criteria': 9, 'd-online': 10, 'd-summary': 11,
    // Professional entry (parallel to d-trades).
    'd-professional-industry': 5,
    // Realtor track.
    'd-realtor-1': 6, 'd-realtor-2': 7, 'd-realtor-3': 8, 'd-realtor-4': 9,
    'd-realtor-close': 10,
    // Insurance track.
    'd-ins-1': 6, 'd-ins-2': 7, 'd-ins-3': 8, 'd-ins-4': 9, 'd-ins-5': 10,
    'd-ins-6': 11, 'd-ins-7': 12, 'd-ins-close': 13
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
          if (!leadEventFired) {
            leadEventFired = true;
            try { fbq('track', 'Lead'); } catch (e) {}
          }
          redirectWithLeadId(bridge.ROLE_DESTINATIONS.contractor, leadId);
          return;
        }
        go('d-name');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';

      bridge.insertFreshLead(null, value, null).then(function (newId) {
        email = value;
        leadId = newId;

        function proceed() {
          // Meta Lead -- same bare call as start.html's own Step 1 and
          // contractor-join.html:376's precedent, no PII payload. Guarded
          // to fire AT MOST ONCE per page life (gh-2075 round 2 finding
          // 2) -- the resubmit branch above already returns before
          // reaching here, but this also covers a bfcache restore or any
          // other path that could otherwise reach `proceed()` twice.
          if (!leadEventFired) {
            leadEventFired = true;
            try { fbq('track', 'Lead'); } catch (e) {}
          }

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
          go('d-name');
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

  // ══════════════════════ Screen 3: name ══════════════════════
  RENDERERS['d-name'] = function () {
    root.appendChild(backButton(goBack));
    root.appendChild(heading('What is your name?'));
    var nameF = field('dName', 'Full Name', 'text', { autocomplete: 'name', maxlength: '200' });
    var submitBtn = continueButton('Continue', onSubmit, true);
    root.appendChild(submitBtn);

    function onSubmit() {
      nameF.err.textContent = '';
      var value = nameF.input.value.trim();
      if (!value) { nameF.err.textContent = 'Please enter your name.'; return; }
      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';

      bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: value, p_email: email, p_phone: null }).then(function (res) {
        name = value;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        if (res && res.error) {
          console.error('[router-variant-d] update_lead_contact (name) failed -- proceeding anyway:', res.error);
        }
        // Not emitComplete()'d here -- go() below already emits it.
        go('d-phone');
      }).catch(function (err) {
        console.error('[router-variant-d] update_lead_contact (name) threw -- proceeding anyway:', err);
        name = value;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        go('d-phone');
      });
    }
  };

  // ══════════════════════ Screen 4: phone (optional/skippable) ══════════
  // #2075: "name, phone (skippable where C allows)" -- gh-2042 already
  // made phone optional everywhere else on this router; this screen is
  // never gated on it being filled in.
  RENDERERS['d-phone'] = function () {
    root.appendChild(backButton(goBack));
    root.appendChild(heading('What is your phone number?'));
    var phoneF = field('dPhone', 'Phone Number', 'tel', { autocomplete: 'tel', inputmode: 'tel', maxlength: '20' }, true);
    var submitBtn = continueButton('Continue', onSubmit, true);
    root.appendChild(submitBtn);

    function afterPhone() {
      // gh-2075 round 2, review report ceo57-review-pr2086-20260921
      // finding 3 (blocking, real-browser evidence on a 2.5s-delayed
      // fetch: the button read {disabled:false} 500ms after the first
      // tap, a second tap produced a duplicate update_lead_contact call
      // and a phantom d-trades view/complete/view, and corrupted the
      // back stack): this is the one network wait inside the funnel --
      // go() below triggers js/router-discovery.js's lazy fetch (see
      // that file's own top-of-file comment) -- so the button must NOT
      // re-enable here. It stays disabled/"Please wait..." for the
      // remainder of this screen's life; on success the screen is
      // replaced entirely by show(), and on a load failure the go()
      // wrapper's own bridge.showError(...) already covers it (a fresh
      // page load is then the recovery path, same as every other
      // unrecoverable error on this page).
      //
      // Not emitComplete()'d here -- go() below already emits it (same
      // pattern as d-email/d-name above, and d-professional-industry
      // further down).
      if (role === 'referral_partner') { go('d-professional-industry'); return; }
      go('d-trades'); // homeowner
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
      submitBtn.textContent = 'Please wait…';

      var phoneDigits = raw ? normalizePhone(raw) : null;
      bridge.sb.rpc('update_lead_contact', { p_lead_id: leadId, p_name: name, p_email: email, p_phone: phoneDigits }).then(function (res) {
        if (res && res.error) {
          console.error('[router-variant-d] update_lead_contact (phone) failed -- proceeding anyway:', res.error);
        }
        afterPhone();
      }).catch(function (err) {
        console.error('[router-variant-d] update_lead_contact (phone) threw -- proceeding anyway:', err);
        afterPhone();
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

  // ══════════════════════ Homeowner track (reused from arm C verbatim) ═
  RENDERERS['d-trades'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderMultiSelect(root, {
      heading: RD.COPY.home2Heading,
      options: RD.COPY.home2Options,
      onContinue: function (chosen) {
        answers.trades = chosen.map(function (i) { return RD.COPY.home2Options[i - 1]; });
        go('d-payer');
      }
    });
  };
  RENDERERS['d-payer'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, {
      heading: RD.COPY.home3Heading,
      options: RD.COPY.home3Options,
      onSelect: function (idx) {
        answers.payer = RD.COPY.home3Options[idx - 1];
        go('d-hidden-costs');
      }
    });
  };
  RENDERERS['d-hidden-costs'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderMultiSelect(root, {
      heading: RD.COPY.home4Heading,
      options: RD.COPY.home4Options,
      onContinue: function (chosen) {
        answers.hiddenCosts = chosen;
        var qualifies = chosen.length === 1 && chosen[0] === 5;
        if (qualifies) { go('d-time'); } else { go('d-dq-hidden-costs'); }
      }
    });
  };
  RENDERERS['d-dq-hidden-costs'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderDisqualifier(root, {
      text: RD.COPY.dq4Text,
      opt1: RD.COPY.dq4Opt1,
      onContinue: function () { go('d-time'); }
    });
  };
  RENDERERS['d-time'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, {
      heading: RD.COPY.home5Heading,
      options: RD.COPY.home5Options,
      onSelect: function (idx) {
        answers.timeInvestment = RD.COPY.home5Options[idx - 1];
        if (idx === 3) { go('d-dq-time'); } else { go('d-criteria'); }
      }
    });
  };
  RENDERERS['d-dq-time'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderDisqualifier(root, {
      text: RD.COPY.dq5Text,
      opt1: RD.COPY.dq5Opt1,
      onContinue: function () { go('d-criteria'); }
    });
  };
  RENDERERS['d-criteria'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderMultiSelect(root, {
      heading: RD.COPY.home6Heading,
      options: RD.COPY.home6Options,
      onContinue: function (chosen) {
        answers.selectionCriteria = chosen;
        var disqualifyingChoice = chosen.some(function (n) { return n === 6 || n === 7 || n === 8; });
        if (disqualifyingChoice) { go('d-dq-criteria'); } else { go('d-online'); }
      }
    });
  };
  RENDERERS['d-dq-criteria'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderDisqualifier(root, {
      text: RD.COPY.dq6Text,
      opt1: RD.COPY.dq6Opt1,
      onContinue: function () { go('d-online'); }
    });
  };
  RENDERERS['d-online'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(backButton(goBack));
    RD.renderSingleSelect(root, {
      heading: RD.COPY.home7Heading,
      options: RD.COPY.home7Options,
      onSelect: function (idx) {
        answers.online = RD.COPY.home7Options[idx - 1];
        // D-2 (issue #2011/#2017): option 1 disqualifies, option 2
        // qualifies -- identical logic to arm C's own c-home-7.
        if (idx === 1) { go('d-dq-online'); } else { go('d-summary'); }
      }
    });
  };
  RENDERERS['d-dq-online'] = function () {
    var RD = window.RouterDiscovery;
    RD.renderDisqualifier(root, {
      text: RD.COPY.dq7Text,
      opt1: RD.COPY.dq7Opt1,
      onContinue: function () { go('d-summary'); }
    });
  };
  // gh-2078 HOOK POINT (not implemented here, on purpose): a homeowner's
  // real conversion event -- measurement_purchase -- fires downstream, in
  // the React app's measurement-checkout success callback, once #2078
  // lands. This no-op documents exactly where D's own responsibility ends:
  // the redirect below hands the visitor to /get-started carrying
  // variant='d' (via bridge.collectAttribution()), which is what lets that
  // downstream event attribute back to this arm. Do not implement the
  // actual event here -- #2078 owns it.
  function HOOK_measurementPurchase() { /* see gh-2078; the real event fires from help-measurements/page.tsx's checkout success, not here */ }
  RENDERERS['d-summary'] = function () {
    var RD = window.RouterDiscovery;
    root.appendChild(bodyText(RD.COPY.home8Text));
    root.appendChild(continueButton('Continue', function () {
      emitComplete('d-summary');
      HOOK_measurementPurchase();
      redirectWithLeadId(bridge.ROLE_DESTINATIONS.homeowner, leadId);
    }, true));
  };

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
    var needsDiscovery = token !== 'd-role' && token !== 'd-email' && token !== 'd-name' && token !== 'd-phone';
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
    show('d-role');
  }

  window.RouterVariantD = { init: init };
})();
