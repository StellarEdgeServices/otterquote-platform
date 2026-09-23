// js/router-variant-f.js
//
// gh-2122 (Arm F, D-332, checklist row 1.1 on #2121): the homeowner SHORT
// PATH. Four screens -- funding (one tap), address, name + phone/email,
// thank-you -- and the `leads` row is written on the third screen's submit,
// BEFORE any account exists. Nothing on screens 1-3 touches auth; the
// $15 measurement and the loss-sheet upload are deep links on the thank-you
// screen into the EXISTING app paths (the no-account version is #2121 row
// 3.2 and is NOT part of this issue).
//
// Reachable by URL only (/start?v=f). It is deliberately NOT in start.html's
// LIVE_VARIANTS, so it is not in the random split until Sloane says so on
// #2122 -- see start.html's DIRECT_ONLY_ARMS.
//
// Loaded by start.html's own ARM_F branch (a plain <script> injection, same
// idiom as js/router-variant-d.js / -e.js); it exposes
// window.RouterVariantF.init(bridge, root) once loaded. It reuses the bridge
// every other arm gets (trackRouter / collectAttribution / insertFreshLead /
// appendParams / redirectTo / showError / sb) plus one addition,
// bridge.markLeadSaved(), which tells start.html's shared abandon beacon that
// the visitor has finished (see start.html's own comment on that function).
//
// COPY. Every user-facing string lives in the ONE constants block below,
// keyed exactly as in ARM F COPY -- APPROVED (#2122 comment 5801479035, table
// in 5801132485), so a Sloane copy swap is a one-line change. The two legal
// lines (arm_f_s3_consent_checkbox, arm_f_s3_privacy_line) must stay
// byte-identical to that draft: the R-177 LEGAL-READ checks the shipped text
// against it, and tests/gh2122-arm-f.mjs pins both literally. The one string
// that is not in the approved table is BACK_LABEL, the "Back" affordance every
// other router arm already shows (start.html markup / router-discovery.js).
//
// WHAT THIS DOES NOT DO YET (measured, see the Q on #2122): production
// `leads` has no column for the funding answer, the address, fbc, or the
// D-299 consent evidence (rendered text, timestamp, IP, user agent, page URL).
// So this module writes ONLY existing columns -- name, email, phone, source,
// variant, utm_*, fbclid/gclid, is_synthetic, and `zip` parsed from the
// address -- and sends the funding answer and the consent checkbox state as
// GA4 event parameters. It never sends a column that does not exist: an
// unknown column makes PostgREST reject the whole insert and `leads` has no
// UPDATE policy, so the lead would be destroyed with no retry. The consent
// checkbox is shown and recorded in the event stream only until the companion
// migration lands.
(function () {
  'use strict';

  var COPY = Object.freeze({
    arm_f_s1_headline: "See if storm damage qualifies your roof for a free assessment.",
    arm_f_s1_subhead: "One quick question, then we'll get your info. Takes under a minute.",
    arm_f_s1_question_label: "How will you pay for the repair?",
    arm_f_s1_option_insurance: "Insurance claim",
    arm_f_s1_option_cash: "Paying cash",
    arm_f_s1_option_unsure: "Not sure yet",
    arm_f_s2_headline: "What's the property address?",
    arm_f_s2_subhead: "So we can look up the roof and match you with a local contractor.",
    arm_f_s2_placeholder: "123 Main St, City, State ZIP",
    arm_f_s2_button_continue: "Continue",
    arm_f_s2_error_required: "Please enter the property address.",
    arm_f_s3_headline: "Almost done — how should we reach you?",
    arm_f_s3_subhead: "Enter your name and at least one of phone or email.",
    arm_f_s3_label_name: "First Name",
    arm_f_s3_placeholder_name: "Jane",
    arm_f_s3_label_phone: "Mobile Phone",
    arm_f_s3_placeholder_phone: "(555) 123-4567",
    arm_f_s3_label_email: "Email",
    arm_f_s3_placeholder_email: "jane@example.com",
    arm_f_s3_consent_checkbox: "I agree that OtterQuote / Stellar Edge Services may call or text me at the number above about my roof assessment, including by autodialer or prerecorded/artificial voice. Consent is not a condition of purchase. Msg & data rates may apply.",
    arm_f_s3_privacy_line: "By continuing, you agree to our Privacy Policy and Terms.",
    arm_f_s3_button_submit: "Send My Info",
    arm_f_error_name: "Please enter your first name.",
    arm_f_error_contact_required: "Enter a phone number or email so we can reach you.",
    arm_f_error_phone_invalid: "Please enter a valid phone number.",
    arm_f_error_email_invalid: "Please enter a valid email address.",
    arm_f_error_generic: "Something went wrong. Please try again.",
    arm_f_s4_headline: "You're all set.",
    arm_f_s4_body_in_window: "Dustin will call you within 5 minutes to talk through next steps.",
    arm_f_s4_body_after_hours: "Dustin will call you first thing, between 8 a.m. and 8 p.m.",
    arm_f_s4_button_measure: "Get my roof measured, $15",
    arm_f_s4_button_losssheet: "Upload my insurance loss sheet"
  });

  // Not in the approved table: the shared "Back" affordance used by every
  // other router arm. Not marketing copy.
  var BACK_LABEL = '← Back';

  // ── Non-copy constants. Kept beside COPY so nothing configurable is buried
  // in the flow below. ──
  var FUNDING_OPTIONS = [
    { value: 'insurance', copyKey: 'arm_f_s1_option_insurance' },
    { value: 'cash', copyKey: 'arm_f_s1_option_cash' },
    { value: 'unsure', copyKey: 'arm_f_s1_option_unsure' }
  ];
  // The two thank-you buttons deep-link into the EXISTING app paths. The lead
  // id and attribution are appended the same way every other arm's hand-off
  // does (redirectWithLeadId below).
  var CTA_DESTINATIONS = {
    measure: 'https://app.otterquote.com/help-measurements',
    loss_sheet: 'https://app.otterquote.com/help-estimate'
  };
  // #2121 row 0.7 / Sloane's draft: "call within 5 minutes, 8 a.m. to 8 p.m."
  // Evaluated in the BUSINESS time zone (Dustin's availability is the thing
  // being promised), inclusive start, exclusive end. Time zone is a decision
  // recorded on the PR: the draft says "local time at submit" without naming
  // one. If the zone cannot be resolved the AFTER-HOURS copy is used, because
  // that is the promise that is never wrong.
  var CALL_WINDOW = { timeZone: 'America/Indiana/Indianapolis', startHour: 8, endHour: 20 };
  // set_lead_role is awaited so the #1932 alert (which fires on role NULL ->
  // non-NULL) is not cut off by a fast navigation, but the thank-you screen
  // never waits longer than this for it.
  var ROLE_CALL_GUARD_MS = 4000;

  var STEP_INDEX = { 'f-funding': 1, 'f-address': 2, 'f-contact': 3, 'f-thanks': 4 };

  var bridge = null;
  var root = null;
  var funding = null;
  var address = null;
  var leadId = null;
  var submitting = false;
  var leadEventFired = false;
  var activeToken = null;
  var stack = [];

  // ── DOM helpers (same local-helper convention as router-variant-d.js). ──
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }
  function clearRoot() { while (root.firstChild) root.removeChild(root.firstChild); }
  function heading(text) { return el('h1', null, text); }
  function bodyText(text) { return el('p', 'router-sub', text); }
  function primaryButton(label, onClick) {
    var btn = el('button', 'btn btn-primary router-btn', label);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    return btn;
  }
  function backButton(onClick) {
    var btn = el('button', 'router-back', null);
    btn.type = 'button';
    btn.textContent = BACK_LABEL;
    btn.addEventListener('click', onClick);
    return btn;
  }
  function field(id, labelText, type, extra) {
    var group = el('div', 'form-group');
    var label = el('label', 'form-label', labelText);
    label.setAttribute('for', id);
    var input = el('input', 'form-input');
    input.type = type;
    input.setAttribute('type', type);
    input.id = id;
    input.setAttribute('id', id);
    if (extra) { Object.keys(extra).forEach(function (k) { input.setAttribute(k, extra[k]); }); }
    var err = el('div', 'field-error');
    err.id = id + 'Error';
    group.appendChild(label);
    group.appendChild(input);
    group.appendChild(err);
    root.appendChild(group);
    return { input: input, err: err };
  }
  function setError(errEl, msg) { errEl.textContent = msg; }

  // ── Events. step_index comes from THIS arm's own table, on every event that
  // has a step; variant / ua_context / lead_id are stamped by start.html's
  // shared trackRouter (lead_id only once insertFreshLead has resolved). ──
  function stepParams(token, extra) {
    var p = { step: token, step_index: STEP_INDEX[token] };
    if (extra) { Object.keys(extra).forEach(function (k) { p[k] = extra[k]; }); }
    return p;
  }
  function emitView(token) { bridge.trackRouter('router_step_view', stepParams(token)); }
  function emitComplete(token) { bridge.trackRouter('router_step_complete', stepParams(token)); }

  var RENDERERS = {};
  function show(token) {
    activeToken = token;
    clearRoot();
    emitView(token);
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

  // ── Validation (same rules start.html and router-discovery.js apply). ──
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
  function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  // The only address-derived column that exists today is `zip`.
  function zipFromAddress(addr) {
    var m = /\b(\d{5})(?:-\d{4})?\s*$/.exec(addr || '');
    return m ? m[1] : null;
  }

  // ── Screen 1: funding. One tap, no typing, no role question, no header
  // navigation. ──
  RENDERERS['f-funding'] = function () {
    root.appendChild(heading(COPY.arm_f_s1_headline));
    root.appendChild(bodyText(COPY.arm_f_s1_subhead));
    root.appendChild(bodyText(COPY.arm_f_s1_question_label));
    var wrap = el('div', 'role-options');
    FUNDING_OPTIONS.forEach(function (opt) {
      var btn = el('button', 'role-option', COPY[opt.copyKey]);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        funding = opt.value;
        bridge.trackRouter('router_funding_selected', stepParams('f-funding', { funding_type: funding }));
        go('f-address');
      });
      wrap.appendChild(btn);
    });
    root.appendChild(wrap);
  };

  // ── Screen 2: address. /start has no address autocomplete, so this is the
  // single text field the spec asks for in that case. ──
  RENDERERS['f-address'] = function () {
    root.appendChild(backButton(goBack));
    root.appendChild(heading(COPY.arm_f_s2_headline));
    root.appendChild(bodyText(COPY.arm_f_s2_subhead));
    var f = field('rfAddress', COPY.arm_f_s2_headline, 'text', {
      placeholder: COPY.arm_f_s2_placeholder, autocomplete: 'street-address', maxlength: '200'
    });
    if (address) f.input.value = address;
    var btn = primaryButton(COPY.arm_f_s2_button_continue, function () {
      var v = (f.input.value || '').replace(/^\s+|\s+$/g, '');
      if (v.length < 5) { setError(f.err, COPY.arm_f_s2_error_required); return; }
      setError(f.err, '');
      address = v;
      go('f-contact');
    });
    root.appendChild(btn);
  };

  // ── Screen 3: contact. Phone OR email, first name, an OPTIONAL unchecked
  // consent checkbox (consent is not a condition of submitting -- the approved
  // line itself says so), and the privacy line. ──
  // Renders `text` with its "Privacy Policy" and "Terms" words as same-tab
  // links WITHOUT changing the string: textContent stays byte-identical.
  function linkedPrivacyLine(text) {
    var p = el('p', 'router-sub');
    p.id = 'rfPrivacy';
    p.setAttribute('id', 'rfPrivacy');
    var links = [{ label: 'Privacy Policy', href: 'privacy.html' }, { label: 'Terms', href: 'terms.html' }];
    var rest = text;
    links.forEach(function (l) {
      var i = rest.indexOf(l.label);
      if (i === -1) return;
      if (i > 0) p.appendChild(document.createTextNode(rest.slice(0, i)));
      var a = el('a', null, l.label);
      a.setAttribute('href', l.href); // same tab: spec 8, no new tabs in the in-app browsers
      p.appendChild(a);
      rest = rest.slice(i + l.label.length);
    });
    if (rest) p.appendChild(document.createTextNode(rest));
    return p;
  }

  RENDERERS['f-contact'] = function () {
    root.appendChild(backButton(goBack));
    root.appendChild(heading(COPY.arm_f_s3_headline));
    root.appendChild(bodyText(COPY.arm_f_s3_subhead));
    var nameF = field('rfName', COPY.arm_f_s3_label_name, 'text', { placeholder: COPY.arm_f_s3_placeholder_name, autocomplete: 'given-name', maxlength: '200' });
    var phoneF = field('rfPhone', COPY.arm_f_s3_label_phone, 'tel', { placeholder: COPY.arm_f_s3_placeholder_phone, autocomplete: 'tel', inputmode: 'tel', maxlength: '20' });
    var emailF = field('rfEmail', COPY.arm_f_s3_label_email, 'email', { placeholder: COPY.arm_f_s3_placeholder_email, autocomplete: 'email', inputmode: 'email', maxlength: '320' });

    var consentGroup = el('div', 'form-group');
    var consentInput = el('input', null);
    consentInput.type = 'checkbox';
    consentInput.setAttribute('type', 'checkbox');
    consentInput.id = 'rfConsent';
    consentInput.setAttribute('id', 'rfConsent');
    consentInput.checked = false; // unchecked by default, never pre-ticked
    var consentLabel = el('label', 'form-label', COPY.arm_f_s3_consent_checkbox);
    consentLabel.setAttribute('for', 'rfConsent');
    consentGroup.appendChild(consentInput);
    consentGroup.appendChild(consentLabel);
    root.appendChild(consentGroup);
    root.appendChild(linkedPrivacyLine(COPY.arm_f_s3_privacy_line));

    var formError = el('div', 'field-error');
    formError.id = 'rfFormError';
    root.appendChild(formError);

    var submitBtn = primaryButton(COPY.arm_f_s3_button_submit, function () {
      if (submitting) return;
      var nm = (nameF.input.value || '').replace(/^\s+|\s+$/g, '');
      var phoneRaw = (phoneF.input.value || '').replace(/^\s+|\s+$/g, '');
      var em = (emailF.input.value || '').replace(/^\s+|\s+$/g, '').toLowerCase();
      setError(nameF.err, ''); setError(phoneF.err, ''); setError(emailF.err, ''); setError(formError, '');
      var bad = false;
      if (!nm) { setError(nameF.err, COPY.arm_f_error_name); bad = true; }
      if (!phoneRaw && !em) { setError(formError, COPY.arm_f_error_contact_required); bad = true; }
      if (phoneRaw && !isValidUsPhone(phoneRaw)) { setError(phoneF.err, COPY.arm_f_error_phone_invalid); bad = true; }
      if (em && !isValidEmail(em)) { setError(emailF.err, COPY.arm_f_error_email_invalid); bad = true; }
      if (bad) return;
      saveLead({
        name: nm,
        email: em,
        phone: phoneRaw ? normalizePhone(phoneRaw) : null,
        consentGiven: !!consentInput.checked
      }, submitBtn, formError);
    });
    root.appendChild(submitBtn);
  };

  // ── The save. Order is the point: (1) the leads row, first, before anything
  // else; (2) only if that succeeded, the conversion -- GA4 generate_lead and
  // Meta Lead with ONE shared event_id, exactly once; (3) set_lead_role so the
  // existing #1932 alert fires; (4) the thank-you screen. A failed insert
  // counts NOTHING and leaves the form ready for a retry. ──
  function saveLead(v, submitBtn, formError) {
    submitting = true;
    submitBtn.disabled = true;
    var extra = {};
    var zip = zipFromAddress(address);
    if (zip) extra.zip = zip;
    // leads.email is NOT NULL, so an email-less (phone-only) lead is saved
    // with '' -- never a synthetic address (start.html's own arm-B comment
    // forbids one). The #1932 alert's claim query is NOT ILIKE-based, so ''
    // still alerts; NULL would not.
    bridge.insertFreshLead(v.name, v.email, v.phone, undefined, undefined, extra).then(function (newId) {
      leadId = newId;
      fireConversion(v);
      bridge.markLeadSaved();
      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        go('f-thanks');
      }
      var guard = setTimeout(finish, ROLE_CALL_GUARD_MS);
      var role;
      try { role = bridge.sb.rpc('set_lead_role', { p_lead_id: newId, p_role: 'homeowner' }); } catch (e) { role = null; }
      if (role && typeof role.then === 'function') {
        role.then(function (res) {
          if (res && res.error) console.error('[router-variant-f] set_lead_role failed -- proceeding anyway:', res.error);
          clearTimeout(guard); finish();
        }, function (err) {
          console.error('[router-variant-f] set_lead_role threw -- proceeding anyway:', err);
          clearTimeout(guard); finish();
        });
      } else { clearTimeout(guard); finish(); }
    }, function (err) {
      console.error('[router-variant-f] lead save failed:', err);
      submitting = false;
      submitBtn.disabled = false;
      setError(formError, COPY.arm_f_error_generic);
    });
  }

  function fireConversion(v) {
    if (leadEventFired) return;
    leadEventFired = true;
    var eventId = leadId;
    bridge.trackRouter('router_contact_submitted', stepParams('f-contact', { funding_type: funding, consent_given: v.consentGiven }));
    bridge.trackRouter('generate_lead', stepParams('f-contact', { event_id: eventId, funding_type: funding }));
    try { fbq('track', 'Lead', {}, { eventID: eventId }); } catch (e) {}
  }

  // ── Screen 4: thank-you. The conversion was already counted above; the two
  // buttons only navigate. ──
  function inCallWindow() {
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: CALL_WINDOW.timeZone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') {
          var h = parseInt(parts[i].value, 10);
          return !isNaN(h) && h >= CALL_WINDOW.startHour && h < CALL_WINDOW.endHour;
        }
      }
    } catch (e) { /* fall through */ }
    return false;
  }
  function redirectWithLeadId(destBase) {
    var sep = destBase.indexOf('?') === -1 ? '?' : '&';
    var withLead = destBase + sep + 'lead=' + encodeURIComponent(leadId);
    bridge.redirectTo(bridge.appendParams(withLead, bridge.collectAttribution()), true);
  }
  RENDERERS['f-thanks'] = function () {
    root.appendChild(heading(COPY.arm_f_s4_headline));
    root.appendChild(bodyText(inCallWindow() ? COPY.arm_f_s4_body_in_window : COPY.arm_f_s4_body_after_hours));
    root.appendChild(primaryButton(COPY.arm_f_s4_button_measure, function () {
      bridge.trackRouter('router_f_cta_clicked', stepParams('f-thanks', { cta: 'measure' }));
      redirectWithLeadId(CTA_DESTINATIONS.measure);
    }));
    root.appendChild(primaryButton(COPY.arm_f_s4_button_losssheet, function () {
      bridge.trackRouter('router_f_cta_clicked', stepParams('f-thanks', { cta: 'loss_sheet' }));
      redirectWithLeadId(CTA_DESTINATIONS.loss_sheet);
    }));
  };

  function init(injectedBridge, mountEl) {
    bridge = injectedBridge;
    root = mountEl || document.getElementById('routerFRoot');
    if (!root) { return; }
    root.setAttribute('data-rd-root', '1');
    show('f-funding');
  }

  window.RouterVariantF = { init: init, COPY: COPY, STEP_INDEX: STEP_INDEX };
})();
