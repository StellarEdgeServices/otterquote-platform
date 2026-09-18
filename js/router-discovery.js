// gh-2017: Variant C -- the Sandler-style discovery engine, its shared entry
// screen, and the homeowner track (8 screens, 4 disqualifier branches).
//
// This is a MODULE, not a second page (issue #2011's own URL requirement is
// what decides that -- /start?v=c has to stay /start). start.html loads this
// file by injecting a <script> element ONLY when variant === 'c', then calls
// window.RouterDiscovery.init(bridge, root) once it has loaded. Arms A and B
// never fetch or execute this file at all (#2015: /start?v=a must render
// exactly what /start renders).
//
// This module owns its OWN ordered-array screen sequencer and its OWN
// rendering. It does not touch, extend, or call into start.html's
// steps/renderStep/doneCount/popstate machinery (that file's own three
// "fix round" comment blocks record how bug-scarred that code already is
// for a flat 4-key object -- #2017 explicitly rejects growing its state
// space tenfold). Everything this module needs FROM start.html arrives
// through the `bridge` object passed to init() -- called, never copied:
// sb, trackRouter, collectAttribution, insertFreshLead, appendParams,
// redirectTo, showError, ROLE_DESTINATIONS, PARTNER_INDUSTRY_DESTINATIONS,
// NO_LEAD_ID_DESTINATIONS.
//
// Contact capture: public.leads.email is NOT NULL (verified live against
// project yeszghaspzwwstvsrioa, 2026-09-18) with no default, so screens
// c-entry through c-home-7 write NOTHING to the database -- every answer is
// held in the `answers` object below, client-side only, until c-home-8's
// contact submit. Never invent a placeholder email to insert earlier; a
// synthetic address corrupts the table the funnel reports from.
//
// THE CARVE-OUT (draft #2019, not yet landed): every disqualifier screen's
// option 2 ("Yes, please send me their contact information.") is D-8 and
// belongs to #2019. This module builds the capture (one field, email only,
// no name, no phone, no second screen, no new tab -- 78% of this traffic is
// mobile and 39% is the Facebook in-app browser) and wires router_disqualified,
// but the outbound message a homeowner would receive is Tier C copy that
// belongs to Dustin, not this module -- see the QUESTIONS field in this PR's
// report. DO NOT point live ad traffic at /start?v=c until #2019 lands.
//
// Step tokens (exact, namespaced so they cannot collide with arm A's
// 1/2/2a/3 or arm B's b-*): c-entry, c-home-1..c-home-8,
// c-home-dq-4/5/6/7. router_step_view fires on entry to EVERY token in that
// list (dq screens included). router_step_complete fires on leaving one.
// router_disqualified fires on entry to a c-home-dq-* screen, carrying the
// ORIGINAL screen's token (e.g. step: 'c-home-7', not 'c-home-dq-7') -- this
// is the D-2 control's own shape (issue #2017's closes-on control 1) and is
// how the funnel learns WHICH question ended the session. Never emit a
// guessed step token -- a missing event is a hole we can see; a wrong one
// is not.
(function () {
  'use strict';

  var bridge = null;
  var root = null;

  // Every answer is held here, client-side, only for as long as the
  // session lasts -- cleared implicitly on page reload (no resume-a-
  // session feature is asked for). None of these six fields is written
  // to public.leads by this issue: the table has no column for any of
  // them (verified live, 2026-09-18 -- trades/payer/hidden-cost/
  // time-investment/selection-criteria/online-comfort do not exist as
  // leads columns), and the work order's own contact-capture section
  // scopes the c-home-8 insert to insertFreshLead()+set_lead_role() only.
  // Held here anyway (rather than discarded on read) so a later issue
  // that DOES need this scope-of-work detail -- c-home-8's own copy says
  // "we will get additional information about your job" as a step AFTER
  // this one -- has it in one place instead of re-deriving it.
  var answers = {
    trades: [],
    payer: null,
    hiddenCosts: [],
    timeInvestment: null,
    selectionCriteria: [],
    online: null
  };

  // Module-owned navigation stack (NOT the browser's history/popstate --
  // this module does not push history entries; a hardware/browser Back
  // simply leaves /start?v=c, which is an acceptable default for this
  // build). `activeToken` is the screen currently rendered; `stack` holds
  // the tokens to return to when this module's own on-screen "Back"
  // control is used.
  var activeToken = null;
  var stack = [];

  // Maps a disqualifier screen's own view token to the ORIGINAL screen
  // token that fired it -- the value router_disqualified's `step` carries
  // (D-2 control: option 1 on c-home-7 -> router_disqualified step=c-home-7,
  // not step=c-home-dq-7).
  var DQ_SOURCE = {
    'c-home-dq-4': 'c-home-4',
    'c-home-dq-5': 'c-home-5',
    'c-home-dq-6': 'c-home-6',
    'c-home-dq-7': 'c-home-7'
  };

  // ── Approved copy -- ship verbatim, byte-exact. Dustin has declined
  // three times in his own voice to alter these words on this build
  // (#2011 D-1, D-4; #2019 "A."). Screen 4 option 3's EN DASH (U+2013,
  // "10–15%") is intentional and must not be normalized to a hyphen by an
  // editor/linter -- byte-verified in this PR's evidence. ──
  var COPY = {
    entryIntro: 'Thanks for coming. Please tell us why you are here:',
    entryOptions: [
      'I am a homeowner looking for competitive bids on an upcoming project.',
      'I am a professional interested in new ways to help my clients.',
      'I am a contractor interested in bidding on pre-scoped jobs.'
    ],
    home1: 'Great. Thank you for being here. Before we ask you for anything, we want to make sure this is a good fit for you and for us. So we just have a few questions to make sure we can serve your needs. If it\'s a great fit, we\'d love to help. If it\'s not, we\'d love to recommend someone who can. If that sounds fair, let\'s begin.',
    home2Heading: 'What kind of work do you need done (check all that apply).',
    home2Options: ['Roofing', 'Siding', 'Gutters', 'Windows', 'Other'],
    home3Heading: 'Who is paying for this work?',
    home3Options: ['Me', 'Insurance'],
    home4Heading: 'Every job includes the cost of labor and material. Which additional expenses would you like to have hidden in each line item (check all that apply):',
    // gh-2017: option 3's en dash is a real Unicode EN DASH (U+2013), not a
    // hyphen-minus -- copied here directly from the exec:cro-approved
    // source (issue #2011 body / #2017 comment 5731882071), not retyped.
    home4Options: [
      'Marketing expenses',
      'A $1000 / month truck payment',
      'A 10–15% commission for the sales rep',
      'An extra 40% for the general contractor',
      'None of the above'
    ],
    dq4Text: 'Otter Quotes is designed for homeowners who are trying to avoid the unnecessary costs in home renovation. If these things matter to you, we would be happy to send you the contact information for contractors who include these costs in their jobs.',
    dq4Opt1: 'Of course I want to save money - let\'s continue.',
    home5Heading: 'How much time do you want to invest in picking a contractor?',
    home5Options: [
      'As little as possible. Just get it done.',
      'I want to make a well informed decision, but I don\'t want to waste time.',
      'I love sitting at my kitchen table with sales people. How many can you send?'
    ],
    // OWED 1 -- exec:cro sign-off, #2017 comment 5731882071.
    dq5Text: 'Otter Quotes is built to get you good bids without the sales calls. If you would rather work with a sales rep at your kitchen table, we would be happy to send you the contact information for contractors who work that way.',
    dq5Opt1: 'I\'d rather skip the sales calls - let\'s continue.',
    home6Heading: 'What is important to you in selecting a contractor? (Select all that apply)',
    home6Options: [
      'Great Reviews',
      'Known and recommended by people in the industry',
      'Materials',
      'Warranties',
      'Quality of work',
      'The sales rep\'s brand of truck',
      'The truck wrap',
      'Whether the sales rep used the right sales technique to make me feel warm and fuzzy',
      'Price'
    ],
    // OWED 2 -- exec:cro sign-off, #2017 comment 5731882071.
    dq6Text: 'Otter Quotes is designed for homeowners who choose a contractor on the work - reviews, materials, warranties, and price. If the truck and the sales pitch are what matter to you, we would be happy to send you the contact information for contractors who spend their money there.',
    dq6Opt1: 'I\'d rather judge the work - let\'s continue.',
    home7Heading: 'How do you feel about doing business online?',
    home7Options: [
      'It\'s a fad. I need to look someone\'s sales rep in the eye before I do business with their company.',
      'It allows me to get relevant data and make relevant comparisons without the pressure of someone sitting at my kitchen table.'
    ],
    // OWED 3 -- exec:cro sign-off, #2017 comment 5731882071. Fires on
    // option 1 (D-2, ruled) -- option 2 QUALIFIES and continues to c-home-8.
    dq7Text: 'Otter Quotes is an online service, so everything happens here on the site. If you would rather have a sales rep in your living room before you decide, we would be happy to send you the contact information for contractors who do business that way.',
    dq7Opt1: 'I\'ll give the online version a try - let\'s continue.',
    // Shared verbatim across all four disqualifier screens (ruled on #2019,
    // Dustin verbatim: "A." -- reproduced, not reworded, on all four).
    dqOpt2: 'Yes, please send me their contact information.',
    home8Text: 'From our stand point, it seems like you would be a good fit. You are a tech savvy homeowner who wants to save time and money. The next steps are: 1. We will get additional information about your job; 2. We will create a scope of work and submit it to multiple contractors for bids. 3. Their bids will appear here on the site. 4. If one of the bids suits your needs, you select your contractor on the site and schedule your job. There is no obligation to work with us or our contractors. They don\'t get your information unless you select them. Our service is free to homeowners. To get started we need the following information:'
  };

  // ── Small DOM helpers. Reuse the CSS classes start.html's own <style>
  // block already defines (.role-options/.role-option/.router-sub/
  // .form-group/.form-label/.form-input/.field-error/.router-btn/
  // .router-back) rather than adding a stylesheet -- this file's whitelist
  // is js/router-discovery.js and start.html only, no .css file. Any
  // "selected" row highlight below is applied as inline style using the
  // same CSS variables/values that class's own :hover rule already uses
  // (var(--amber) / rgba(224,123,0,0.08)), not a new visual language. ──
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function clearRoot() {
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  function heading(text) { return el('h1', null, text); }
  function bodyText(text) { return el('p', 'router-sub', text); }

  function optionsWrap() { return el('div', 'role-options'); }

  // A single tappable row. `onActivate` fires on click unless the row is
  // disabled. `showArrow` draws the same "&rarr;" affordance start.html's
  // own arm A/B role rows already use; multi-select rows draw a checkmark
  // slot instead, toggled by setRowSelected().
  function optionRow(label, optionIndex, opts) {
    opts = opts || {};
    var btn = el('button', 'role-option', null);
    btn.type = 'button';
    btn.setAttribute('data-rd-option', String(optionIndex));
    var labelSpan = el('span', null, label);
    btn.appendChild(labelSpan);
    var marker = el('span', 'role-arrow', opts.multi ? '' : '→');
    marker.setAttribute('data-rd-marker', '1');
    btn.appendChild(marker);
    if (opts.disabled) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
    } else if (typeof opts.onActivate === 'function') {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        opts.onActivate(btn);
      });
    }
    return btn;
  }

  function setRowSelected(btn, selected) {
    btn.setAttribute('data-rd-selected', selected ? '1' : '0');
    btn.style.borderColor = selected ? 'var(--amber)' : '';
    btn.style.background = selected ? 'rgba(224,123,0,0.08)' : '';
    var marker = btn.querySelector('[data-rd-marker]');
    if (marker) marker.textContent = selected ? '✓' : '';
  }

  function continueButton(label, onClick, startEnabled) {
    var btn = el('button', 'btn btn-primary router-btn', label || 'Continue');
    btn.type = 'button';
    btn.setAttribute('data-rd-continue', '1');
    btn.disabled = !startEnabled;
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      onClick();
    });
    return btn;
  }

  // ── Tracking. Every call goes through the bridged trackRouter -- this
  // module never calls gtag directly and never touches start.html's
  // trackStepComplete/renderStep (those two are no-ops for arm C anyway,
  // per start.html's own ARM_C guards, precisely so this module's calls
  // through bridge.redirectTo below cannot double-emit a wrong token). ──
  function emitView(token) { bridge.trackRouter('router_step_view', { step: token }); }
  function emitComplete(token) { bridge.trackRouter('router_step_complete', { step: token }); }
  function emitDisqualified(sourceToken) { bridge.trackRouter('router_disqualified', { step: sourceToken }); }

  var RENDERERS = {}; // populated below, keyed by token

  function show(token) {
    activeToken = token;
    clearRoot();
    emitView(token);
    var dqSource = DQ_SOURCE[token];
    if (dqSource) emitDisqualified(dqSource);
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

  function backButton() {
    var btn = el('button', 'router-back', null);
    btn.type = 'button';
    btn.innerHTML = '&larr; Back';
    btn.addEventListener('click', goBack);
    return btn;
  }

  // ── Multi-select screens (2, 4, 6): large tappable rows + a persistent
  // Continue button, never a native <select multiple> -- close to
  // unusable in the Facebook in-app browser (39% of this traffic). ──
  function renderMultiSelect(cfg) {
    var wrap = optionsWrap();
    var selected = {};
    cfg.options.forEach(function (label, i) {
      var idx = i + 1;
      var row = optionRow(label, idx, {
        multi: true,
        onActivate: function (btn) {
          selected[idx] = !selected[idx];
          setRowSelected(btn, selected[idx]);
          var any = Object.keys(selected).some(function (k) { return selected[k]; });
          continueBtn.disabled = !any;
        }
      });
      wrap.appendChild(row);
    });
    var continueBtn = continueButton('Continue', function () {
      var chosen = Object.keys(selected).filter(function (k) { return selected[k]; }).map(Number);
      cfg.onContinue(chosen);
    });
    if (cfg.backTo) root.appendChild(backButton());
    root.appendChild(heading(cfg.heading));
    root.appendChild(wrap);
    root.appendChild(continueBtn);
  }

  // ── Single-select screens (3, 5, 7, entry): tapping a row advances
  // immediately -- same one-tap convention start.html's own arm A/B role
  // rows already use, and the fastest path on the mobile rail this arm
  // has to cover (78% mobile). ──
  function renderSingleSelect(cfg) {
    var wrap = optionsWrap();
    cfg.options.forEach(function (option, i) {
      var idx = i + 1;
      var label = typeof option === 'string' ? option : option.label;
      var disabled = typeof option === 'object' && option.disabled;
      var row = optionRow(label, idx, {
        disabled: disabled,
        onActivate: function () { cfg.onSelect(idx); }
      });
      wrap.appendChild(row);
    });
    if (cfg.backTo) root.appendChild(backButton());
    root.appendChild(heading(cfg.heading));
    if (cfg.sub) root.appendChild(bodyText(cfg.sub));
    root.appendChild(wrap);
  }

  // ── The carve-out (draft #2019 owns the outbound message; this module
  // owns the capture + the router_disqualified wiring only). Renders IN
  // PLACE inside the current disqualifier screen -- no second screen, no
  // new tab, one field. ──
  function renderCarveOutCapture(container) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var group = el('div', 'form-group');
    var label = el('label', 'form-label required', 'Email');
    label.setAttribute('for', 'rdCarveOutEmail');
    var input = el('input', 'form-input');
    input.type = 'email';
    input.id = 'rdCarveOutEmail';
    input.setAttribute('autocomplete', 'email');
    input.setAttribute('inputmode', 'email');
    input.placeholder = 'jane@example.com';
    input.maxLength = 320;
    var err = el('div', 'field-error');
    err.id = 'rdCarveOutEmailError';
    group.appendChild(label);
    group.appendChild(input);
    group.appendChild(err);
    var submitBtn = el('button', 'btn btn-primary router-btn', 'Send it to me');
    submitBtn.type = 'button';
    container.appendChild(group);
    container.appendChild(submitBtn);

    submitBtn.addEventListener('click', function () {
      err.textContent = '';
      var email = input.value.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        err.textContent = 'Please enter a valid email address.';
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';
      if (!bridge.sb) {
        bridge.showError('Something went wrong loading the form. Please refresh and try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send it to me';
        return;
      }
      // gh-2017: name and phone are both nullable on public.leads (verified
      // live, 2026-09-18) -- only email is nullable=NO. insertFreshLead is
      // called exactly as start.html's own call sites call it (name, email,
      // phoneDigits), just with null for the two fields this screen never
      // asks for. This does NOT call set_lead_role -- a disqualified
      // visitor asking for a referral is not a qualified homeowner lead
      // reaching a destination, and set_lead_role's OLD.role IS NULL ->
      // NEW.role IS NOT NULL transition is what fires the EXISTING
      // notify-admin-new-homeowner trigger (supabase/migrations/
      // 20260917010217_gh1994_router_lead_alert.sql) -- a trigger built and
      // worded for a qualified role destination, not this carve-out. A
      // dedicated admin alert for this row shape is real, out-of-scope
      // backend work (outside this issue's file whitelist of
      // js/router-discovery.js + start.html) -- flagged as a QUESTION in
      // this PR, not built here.
      bridge.insertFreshLead(null, email, null).then(function () {
        while (container.firstChild) container.removeChild(container.firstChild);
        container.appendChild(bodyText('Thanks — we have your email on file.'));
      }).catch(function (insertErr) {
        console.error('[router-discovery] carve-out email insert failed:', insertErr);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send it to me';
        bridge.showError('Something went wrong saving your info. Please try again.');
      });
    });
  }

  // ── Disqualifier screens (4, 5, 6, 7's dq siblings): the same large
  // tappable rows as every qualifying screen -- never a modal, never
  // confirm(), which traps focus in the Facebook in-app webview (this
  // arm's single worst mobile failure mode). ──
  function renderDisqualifier(cfg) {
    var textEl = bodyText(cfg.text);
    root.appendChild(textEl);
    var wrap = optionsWrap();
    var opt1 = optionRow(cfg.opt1, 1, { onActivate: function () { cfg.onContinue(); } });
    var opt2 = optionRow(COPY.dqOpt2, 2, {
      onActivate: function () {
        renderCarveOutCapture(wrap);
      }
    });
    wrap.appendChild(opt1);
    wrap.appendChild(opt2);
    root.appendChild(wrap);
  }

  // ── Contact screen (8): same field set/shape as the existing homeowner
  // flow's Step 1 (name, email, phone) -- reusing bridge.insertFreshLead's
  // exact signature, just with this module's own DOM ids (rd*) so it never
  // collides with the hidden #step1 form's ids elsewhere in the document. ──
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

  function renderContact() {
    root.appendChild(bodyText(COPY.home8Text));

    function field(id, labelText, type, extra) {
      var group = el('div', 'form-group');
      var label = el('label', 'form-label required', labelText);
      label.setAttribute('for', id);
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

    var nameF = field('rdName', 'Full Name', 'text', { autocomplete: 'name', maxlength: '200' });
    var emailF = field('rdEmail', 'Email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '320' });
    var phoneF = field('rdPhone', 'Phone Number', 'tel', { autocomplete: 'tel', inputmode: 'tel', maxlength: '20' });

    var submitBtn = el('button', 'btn btn-primary router-btn', 'Continue');
    submitBtn.type = 'button';
    submitBtn.id = 'rdContactSubmit';
    root.appendChild(submitBtn);

    submitBtn.addEventListener('click', function () {
      nameF.err.textContent = '';
      emailF.err.textContent = '';
      phoneF.err.textContent = '';

      var name = nameF.input.value.trim();
      var email = emailF.input.value.trim();
      var phoneRaw = phoneF.input.value.trim();

      var hasError = false;
      if (!name) { nameF.err.textContent = 'Please enter your name.'; hasError = true; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { emailF.err.textContent = 'Please enter a valid email address.'; hasError = true; }
      if (!phoneRaw || !isValidUsPhone(phoneRaw)) { phoneF.err.textContent = 'Please enter a valid 10-digit US phone number.'; hasError = true; }
      if (hasError) return;

      if (!bridge.sb) { bridge.showError('Something went wrong loading the form. Please refresh and try again.'); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Please wait…';

      var phoneDigits = normalizePhone(phoneRaw);

      bridge.insertFreshLead(name, email, phoneDigits).then(function (newId) {
        // gh-2017: leads_force_safe_insert_defaults() forces role NULL on
        // every raw insert regardless of arm, so this RPC is mandatory
        // here exactly as it is on arms A/B -- not extra work this arm
        // avoids. Same payload shape as start.html's own set_lead_role
        // call sites (p_lead_id/p_role). Never rejects the flow forward --
        // a failed role write must not strand a visitor on the router,
        // same rule arms A/B already follow.
        function proceed() {
          emitComplete('c-home-8');
          bridge.redirectTo(
            bridge.appendParams(bridge.ROLE_DESTINATIONS.homeowner, bridge.collectAttribution()),
            !!bridge.NO_LEAD_ID_DESTINATIONS.homeowner
          );
        }
        bridge.sb.rpc('set_lead_role', { p_lead_id: newId, p_role: 'homeowner' }).then(proceed).catch(function (roleErr) {
          console.error('[router-discovery] set_lead_role failed -- proceeding to destination anyway:', roleErr);
          proceed();
        });
      }).catch(function (err) {
        console.error('[router-discovery] contact save failed:', err);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        bridge.showError('Something went wrong saving your info. Please try again.');
      });
    });
  }

  // ── Screen registry ──
  RENDERERS['c-entry'] = function () {
    renderSingleSelect({
      heading: COPY.entryIntro,
      options: [
        { label: COPY.entryOptions[0], disabled: false },
        // gh-2017: options 2 (professional) and 3 (contractor) are shared
        // entry-screen copy that #2018 and Draft 5 each consume for their
        // own tracks -- neither track exists yet, so these two rows render
        // (the entry screen is shared, per spec) but are inert rather than
        // leading nowhere on click. Flagged as a QUESTION in this PR: best
        // guess is that #2018/Draft 5 wire these in directly, since #2017
        // has no destination to send them to.
        { label: COPY.entryOptions[1], disabled: true },
        { label: COPY.entryOptions[2], disabled: true }
      ],
      onSelect: function (idx) {
        if (idx !== 1) return; // only the homeowner row is enabled/wired
        go('c-home-1');
      }
    });
  };

  RENDERERS['c-home-1'] = function () {
    root.appendChild(bodyText(COPY.home1));
    // Starts enabled -- this screen asks no question, so there is nothing
    // to gate it on (unlike the multi-select Continue buttons below).
    root.appendChild(continueButton('Continue', function () { go('c-home-2'); }, true));
  };

  RENDERERS['c-home-2'] = function () {
    renderMultiSelect({
      heading: COPY.home2Heading,
      options: COPY.home2Options,
      backTo: true,
      onContinue: function (chosen) {
        answers.trades = chosen.map(function (i) { return COPY.home2Options[i - 1]; });
        go('c-home-3');
      }
    });
  };

  RENDERERS['c-home-3'] = function () {
    renderSingleSelect({
      heading: COPY.home3Heading,
      options: COPY.home3Options,
      backTo: true,
      onSelect: function (idx) {
        answers.payer = COPY.home3Options[idx - 1];
        go('c-home-4');
      }
    });
  };

  RENDERERS['c-home-4'] = function () {
    renderMultiSelect({
      heading: COPY.home4Heading,
      options: COPY.home4Options,
      backTo: true,
      onContinue: function (chosen) {
        answers.hiddenCosts = chosen;
        // Qualifies only when the selection is EXACTLY {5} ("None of the
        // above") and nothing else -- "fires on anything but option 5"
        // read against a multi-select: any of 1-4 present, alone or
        // alongside 5, disqualifies.
        var qualifies = chosen.length === 1 && chosen[0] === 5;
        if (qualifies) { go('c-home-5'); } else { go('c-home-dq-4'); }
      }
    });
  };

  RENDERERS['c-home-dq-4'] = function () {
    renderDisqualifier({
      text: COPY.dq4Text,
      opt1: COPY.dq4Opt1,
      onContinue: function () { go('c-home-5'); }
    });
  };

  RENDERERS['c-home-5'] = function () {
    renderSingleSelect({
      heading: COPY.home5Heading,
      options: COPY.home5Options,
      backTo: true,
      onSelect: function (idx) {
        answers.timeInvestment = COPY.home5Options[idx - 1];
        if (idx === 3) { go('c-home-dq-5'); } else { go('c-home-6'); }
      }
    });
  };

  RENDERERS['c-home-dq-5'] = function () {
    renderDisqualifier({
      text: COPY.dq5Text,
      opt1: COPY.dq5Opt1,
      onContinue: function () { go('c-home-6'); }
    });
  };

  RENDERERS['c-home-6'] = function () {
    renderMultiSelect({
      heading: COPY.home6Heading,
      options: COPY.home6Options,
      backTo: true,
      onContinue: function (chosen) {
        answers.selectionCriteria = chosen;
        var disqualifyingChoice = chosen.some(function (n) { return n === 6 || n === 7 || n === 8; });
        if (disqualifyingChoice) { go('c-home-dq-6'); } else { go('c-home-7'); }
      }
    });
  };

  RENDERERS['c-home-dq-6'] = function () {
    renderDisqualifier({
      text: COPY.dq6Text,
      opt1: COPY.dq6Opt1,
      onContinue: function () { go('c-home-7'); }
    });
  };

  RENDERERS['c-home-7'] = function () {
    renderSingleSelect({
      heading: COPY.home7Heading,
      options: COPY.home7Options,
      backTo: true,
      onSelect: function (idx) {
        answers.online = COPY.home7Options[idx - 1];
        // D-2, ruled: option 1 disqualifies, option 2 QUALIFIES and
        // continues to c-home-8. This is the single highest-risk line in
        // this build -- see the D-2 control in this PR's evidence.
        if (idx === 1) { go('c-home-dq-7'); } else { go('c-home-8'); }
      }
    });
  };

  RENDERERS['c-home-dq-7'] = function () {
    renderDisqualifier({
      text: COPY.dq7Text,
      opt1: COPY.dq7Opt1,
      onContinue: function () { go('c-home-8'); }
    });
  };

  RENDERERS['c-home-8'] = renderContact;

  function init(injectedBridge, mountEl) {
    bridge = injectedBridge;
    root = mountEl || document.getElementById('routerCRoot');
    if (!root) { return; }
    root.setAttribute('data-rd-root', '1');
    show('c-entry');
  }

  window.RouterDiscovery = { init: init };
})();
