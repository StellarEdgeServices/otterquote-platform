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
// WHERE THE DETAILS GO (Ben's ruling on #2122, comment 5802853627). Production
// `leads` has no column for the funding answer, the address, fbc/fbp, or the
// D-299 consent evidence, and an anon client cannot write them (no UPDATE policy
// on `leads`, and the client IP is not visible to page JS). The companion
// migration PR (#2126) adds the columns, the lead_consents table and the
// record_lead_details() RPC, and the record-lead-details Edge Function reads the
// IP and user agent from the request. So this module does, in this order:
//   1. insert the lead -- EXISTING columns only (name, email, phone, source,
//      variant, utm_*, fbclid/gclid, is_synthetic, and `zip` parsed from the
//      address). It never sends a column that does not exist: an unknown column
//      makes PostgREST reject the whole insert and `leads` has no UPDATE
//      policy, so the lead would be destroyed with no retry;
//   2. AT THE SAME MOMENT (no wait, D-299: a consent record lost to a closed tab is a
//      compliance failure, ruling #2122 comment 5803979399) start two calls in parallel:
//      set_lead_role(homeowner), which trips the #1932 new-lead alert, and
//   3. the record-lead-details Edge Function, sent as a keepalive fetch (a simple
//      request, no CORS preflight) with a sendBeacon fallback on pagehide, carrying the funding answer, the
//      address, fbc/fbp and the consent record. One retry; if it still fails
//      it is reported to Sentry (the lead id, the attempt count and the error
//      class -- no personal data) and the flow carries on -- the lead is saved
//      and the visitor is never blocked. set_lead_role gets the same one retry
//      and the same report, because the #1932 new-lead alert only fires when it
//      succeeds.
// PII DISCIPLINE: the address, the consent text and the funding answer go ONLY
// to that Edge Function. They are never GA4 or Meta event parameters (GA4
// prohibits PII). Analytics events carry variant / step / step_index /
// ua_context / lead_id, plus event_id on generate_lead, and nothing else.
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

  // DRAFT, NOT APPROVED. LEGAL-READ B1 on #2127 (D-299 / D-332): the two call-promise bodies above must not be shown to a
  // lead the system cannot or may not call (no phone, or the consent box left unticked). No approved string covers those
  // leads, so this one is a DRAFT proposed on #2122 (Q 5804527005) and awaits Sloane's approval or replacement. It is a
  // separate block ON PURPOSE: COPY stays the 32 approved keys, byte for byte. It promises no call, timing, price or coverage.
  var DRAFT_COPY = Object.freeze({
    arm_f_s4_body_no_call: "Thanks. We have your information and will be in touch."
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
  // The details call starts the moment the insert resolves and does NOT wait for set_lead_role (see the header). The
  // thank-you screen appears when both calls have settled, and never later than FLOW_GUARD_MS: a hung request must
  // not strand a visitor whose lead is already saved. Both calls keep running in the background if it appears first.
  var FLOW_GUARD_MS = 6000;
  // A thank-you button navigates the page. The details request is keepalive so the browser lets it finish, but a RETRY
  // (after a failure) would not survive navigation, so the buttons wait for an in-flight call, capped at this.
  var CTA_WAIT_MS = 2500;
  var DETAILS_FUNCTION = 'record-lead-details';
  var DETAILS_RETRIES = 1;
  var DETAILS_RETRY_DELAY_MS = 800;
  var CONSENT_KEY = 'arm_f_s3_consent_checkbox';

  var STEP_INDEX = { 'f-funding': 1, 'f-address': 2, 'f-contact': 3, 'f-thanks': 4 };

  var bridge = null;
  var root = null;
  var funding = null;
  var address = null;
  var addressRaw = null; // the address exactly as typed (D-299 form payload); `address` is the trimmed value used for the zip
  var leadId = null;
  var submitting = false;
  var detailsInFlight = null; // a promise while the details call is running, else null
  var callPromiseAllowed = false; // set at submit: a phone was typed AND the consent box is ticked (LEGAL-READ B1)
  var pendingDetails = null; // { body } until the Edge Function has confirmed the write; the pagehide beacon re-sends it
  var beaconSent = false;
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
        funding = opt.value; // held in memory; goes only to the details Edge Function
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
      addressRaw = f.input.value || '';
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
    var backBtn3 = backButton(goBack);
    root.appendChild(backBtn3);
    root.appendChild(heading(COPY.arm_f_s3_headline));
    root.appendChild(bodyText(COPY.arm_f_s3_subhead));
    var nameF = field('rfName', COPY.arm_f_s3_label_name, 'text', { placeholder: COPY.arm_f_s3_placeholder_name, autocomplete: 'given-name', maxlength: '200' });
    var phoneF = field('rfPhone', COPY.arm_f_s3_label_phone, 'tel', { placeholder: COPY.arm_f_s3_placeholder_phone, autocomplete: 'tel', inputmode: 'tel', maxlength: '20' });
    var emailF = field('rfEmail', COPY.arm_f_s3_label_email, 'email', { placeholder: COPY.arm_f_s3_placeholder_email, autocomplete: 'email', inputmode: 'email', maxlength: '320' });

    var consentGroup = el('div', 'form-group rf-consent');
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
      // The thank-you screen promises a call only to a lead that has a number AND said yes to being called (D-299).
      callPromiseAllowed = !!phoneRaw && !!consentInput.checked;
      saveLead({
        name: nm,
        email: em,
        phone: phoneRaw ? normalizePhone(phoneRaw) : null,
        consentGiven: !!consentInput.checked,
        // AS TYPED, before trimming or normalising: D-299 section 2 (the form payload and "the phone number as typed").
        nameTyped: nameF.input.value || '',
        phoneTyped: phoneF.input.value || '',
        emailTyped: emailF.input.value || ''
      }, submitBtn, formError, backBtn3);
    });
    root.appendChild(submitBtn);
  };

  // ── The save. Order is the point: (1) the leads row, first, before anything
  // else; (2) only if that succeeded, the conversion -- GA4 generate_lead and
  // Meta Lead with ONE shared event_id, exactly once; (3) set_lead_role so the
  // existing #1932 alert fires; (4) the details + consent call; (5) the thank-you
  // screen. A failed insert counts NOTHING and leaves the form ready for a retry. ──
  function readCookie(name) {
    try {
      var m = String(document.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  // fbc: the _fbc cookie when Meta's pixel has set it, else built from the fbclid in
  // the URL in Meta's documented format (fb.<subdomain index>.<creation ms>.<fbclid>).
  function deriveFbc() {
    var c = readCookie('_fbc');
    if (c) return c;
    try {
      var id = new URLSearchParams(window.location.search).get('fbclid');
      if (id) return 'fb.1.' + Date.now() + '.' + id;
    } catch (e) { /* no fbclid */ }
    return null;
  }
  function buildDetailsBody(v, newId) {
    var fields = ['name'];
    if (v.phone) fields.push('phone');
    if (v.email) fields.push('email');
    fields.push('address', 'funding');
    var pageUrl = null;
    // Capped client-side (the server caps it at 2000 too): an over-long URL must not push the body past the 64 KB keepalive limit,
    // which would make both the fetch and the beacon fail and lose the consent record.
    try { pageUrl = (window.location.href || '').slice(0, 2000) || null; } catch (e) { /* none */ }
    return {
      lead_id: newId,
      funding_type: funding,
      property_address: address,
      fbc: deriveFbc(),
      fbp: readCookie('_fbp'),
      // The exact string rendered next to the checkbox, byte-identical to the approved copy.
      consent: { key: CONSENT_KEY, given: v.consentGiven, text: COPY.arm_f_s3_consent_checkbox },
      page_url: pageUrl,
      submitted_fields: fields,
      // D-299 section 2, ruling #2122 comment 5803979399: the phone number AS TYPED and the submitted form VALUES. They go to
      // the Edge Function only -- never into a GA4, Meta or Clarity call.
      phone_as_typed: v.phoneTyped,
      form_payload: { name: v.nameTyped, phone: v.phoneTyped, email: v.emailTyped, address: addressRaw, funding_type: funding }
    };
  }
  // Surfaced to Sentry with the lead id, the attempt count and the error class only -- never the address,
  // the consent text, the funding answer or any contact detail.
  function reportFailure(what, newId, attempts, err) {
    var msg = 'router-arm-f: ' + what + ' failed after ' + attempts + ' attempt(s)';
    try {
      if (window.Sentry && typeof window.Sentry.captureMessage === 'function') {
        window.Sentry.captureMessage(msg, { level: 'error', extra: { lead_id: newId, attempts: attempts, reason: err && err.name ? String(err.name) : 'unknown' } });
      } else if (window._oqErrorBuffer) {
        window._oqErrorBuffer.push({ type: 'error', message: msg + ' (lead_id ' + newId + ')' });
      }
    } catch (e) { /* reporting must never throw */ }
  }
  // One call plus DETAILS_RETRIES retries, shared by set_lead_role and the details call. `invoke` returns a
  // thenable; `isOk(res)` says whether it worked; `notRetryable(res)` marks a result that cannot succeed on retry.
  // Resolves true on success, false after the final failure (which is reported to Sentry).
  function callWithRetry(what, newId, invoke, isOk, notRetryable) {
    return new Promise(function (resolve) {
      var attempts = 0;
      function fail(err, stop) {
        if (!stop && attempts <= DETAILS_RETRIES) { setTimeout(attempt, DETAILS_RETRY_DELAY_MS); return; }
        reportFailure(what, newId, attempts, err);
        resolve(false);
      }
      function attempt() {
        attempts++;
        var call = null;
        try { call = invoke(); } catch (e) { call = null; }
        if (!call || typeof call.then !== 'function') { fail({ name: 'NoClient' }, true); return; }
        call.then(function (res) {
          if (isOk(res)) { resolve(true); return; }
          fail(res && res.error ? res.error : { name: 'NotOk' }, !!(notRetryable && notRetryable(res)));
        }, function (err) { fail(err, false); });
      }
      attempt();
    });
  }
  function setRole(newId) {
    return callWithRetry('set_lead_role (the new-lead alert will not fire)', newId,
      function () { return bridge.sb.rpc('set_lead_role', { p_lead_id: newId, p_role: 'homeowner' }); },
      function (res) { return !!res && !res.error && res.data !== false; });
  }
  // Where the details request goes, or null when the bridge does not supply it (then the supabase-js invoke path is used).
  function detailsUrl() {
    var base = bridge.detailsUrl;
    if (!base) return null;
    var key = bridge.anonKey;
    return key ? base + (base.indexOf('?') === -1 ? '?' : '&') + 'apikey=' + encodeURIComponent(key) : base;
  }
  // A SIMPLE cross-origin request on purpose: Content-Type text/plain and no custom headers, so the browser sends it with no
  // CORS preflight (the Edge Function parses the body as JSON whatever the content type says), and keepalive:true so it can
  // finish after the page is gone. The anon key rides as a query parameter for the same reason (a header would force a
  // preflight, which does not survive unload). Falls back to supabase-js when there is no fetch or no URL.
  function postDetails(body) {
    var url = detailsUrl();
    if (url && typeof fetch === 'function') {
      return fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) }).then(
        function (r) {
          return r.json().then(
            function (d) { return { data: d, error: r.ok ? null : { name: 'HttpError', status: r.status } }; },
            function () { return { data: null, error: { name: r.ok ? 'BadJson' : 'HttpError', status: r.status } }; });
        },
        function (e) { return { data: null, error: { name: e && e.name ? e.name : 'FetchError' } }; });
    }
    return bridge.sb.functions.invoke(DETAILS_FUNCTION, { body: body });
  }
  function sendDetails(body, newId) {
    pendingDetails = { body: body };
    return callWithRetry('record-lead-details', newId,
      function () { return postDetails(body); },
      function (res) {
        var ok = !!res && !res.error && !!res.data && res.data.ok === true;
        if (ok) pendingDetails = null; // confirmed: nothing left for the unload beacon to re-send
        return ok;
      },
      // a 200 with reason lead_out_of_scope (unknown / too old / already redeemed lead) cannot succeed on retry
      function (res) { return !!(res && res.data && res.data.reason === 'lead_out_of_scope'); });
  }
  // The tab-close net (Ben, ruling #2122 comment 5803979399): if the page is going away (or has been hidden) while the details
  // write is NOT yet confirmed, re-send the same body with navigator.sendBeacon. The body is text/plain for the same no-preflight
  // reason as above. The server keeps the first write and ignores a duplicate, so a beacon that races the fetch is harmless.
  function beaconDetails() {
    if (!pendingDetails || beaconSent) return;
    var url = detailsUrl();
    if (!url) return;
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([JSON.stringify(pendingDetails.body)], { type: 'text/plain;charset=UTF-8' }))) {
        beaconSent = true;
      }
    } catch (e) { /* the beacon is best-effort */ }
  }

  function saveLead(v, submitBtn, formError, backBtn) {
    submitting = true;
    submitBtn.disabled = true;
    // Going Back while the save is in flight would let the visitor change the address or funding answer after the lead
    // row was written, so the details call could disagree with the row.
    if (backBtn) backBtn.disabled = true;
    function saveFailed(err) {
      console.error('[router-variant-f] lead save failed:', err);
      submitting = false;
      submitBtn.disabled = false;
      if (backBtn) backBtn.disabled = false;
      setError(formError, COPY.arm_f_error_generic);
    }
    var extra = {};
    var zip = zipFromAddress(address);
    if (zip) extra.zip = zip;
    // leads.email is NOT NULL, so an email-less (phone-only) lead is saved
    // with '' -- never a synthetic address (start.html's own arm-B comment
    // forbids one). The #1932 alert's claim query is NOT ILIKE-based, so ''
    // still alerts; NULL would not.
    var saving;
    try {
      saving = bridge.insertFreshLead(v.name, v.email, v.phone, undefined, undefined, extra);
    } catch (e) {
      // insertFreshLead can throw SYNCHRONOUSLY (its supabase client is null when the deferred CDN script did
      // not load); without this the button would stay disabled with no message.
      saveFailed(e);
      return;
    }
    saving.then(function (newId) {
      leadId = newId;
      fireConversion();
      bridge.markLeadSaved();
      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        go('f-thanks');
      }
      setTimeout(finish, FLOW_GUARD_MS);
      // D-299: the consent record waits for NOTHING. Start it in the same tick the insert resolved, then run set_lead_role
      // (the #1932 alert) in parallel; the thank-you screen follows when both have settled, or at the flow guard.
      var running = sendDetails(buildDetailsBody(v, newId), newId);
      detailsInFlight = running;
      function detailsDone() { if (detailsInFlight === running) detailsInFlight = null; }
      running.then(detailsDone, detailsDone);
      var role = setRole(newId);
      Promise.all([running, role]).then(finish, finish);
    }, saveFailed);
  }

  // The conversion. Events carry step / step_index (and variant, ua_context, lead_id, added by
  // start.html's trackRouter) -- and event_id on generate_lead so GA4 and Meta share one id. No
  // funding, address, consent or fbc/fbp value ever goes into an analytics event.
  function fireConversion() {
    if (leadEventFired) return;
    leadEventFired = true;
    var eventId = leadId;
    bridge.trackRouter('router_contact_submitted', stepParams('f-contact'));
    bridge.trackRouter('generate_lead', stepParams('f-contact', { event_id: eventId }));
    try { fbq('track', 'Lead', {}, { eventID: eventId }); } catch (e) {}
  }

  // ── Screen 4: thank-you. The conversion was already counted above; the two
  // buttons only navigate. ──
  function inCallWindow() {
    try {
      // hour12:false (not hourCycle, which pre-2019 WebKit ignores, returning "09" for 21:00); some engines
      // then report midnight as "24"; the hour is taken modulo 24 (24 is already outside the window, so this is belt and braces).
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: CALL_WINDOW.timeZone, hour: '2-digit', hour12: false }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') {
          var h = parseInt(parts[i].value, 10) % 24;
          return !isNaN(h) && h >= CALL_WINDOW.startHour && h < CALL_WINDOW.endHour;
        }
      }
    } catch (e) { /* fall through */ }
    return false;
  }
  // Runs `cb` once a details call that is still in flight has settled, or after CTA_WAIT_MS, whichever is first.
  function afterDetails(cb) {
    if (!detailsInFlight) { cb(); return; }
    var done = false;
    function run() { if (done) return; done = true; cb(); }
    setTimeout(run, CTA_WAIT_MS);
    detailsInFlight.then(run, run);
  }
  function redirectWithLeadId(destBase) {
    var sep = destBase.indexOf('?') === -1 ? '?' : '&';
    var withLead = destBase + sep + 'lead=' + encodeURIComponent(leadId);
    bridge.redirectTo(bridge.appendParams(withLead, bridge.collectAttribution()), true);
  }
  RENDERERS['f-thanks'] = function () {
    root.appendChild(heading(COPY.arm_f_s4_headline));
    root.appendChild(bodyText(!callPromiseAllowed ? DRAFT_COPY.arm_f_s4_body_no_call : inCallWindow() ? COPY.arm_f_s4_body_in_window : COPY.arm_f_s4_body_after_hours));
    root.appendChild(primaryButton(COPY.arm_f_s4_button_measure, function () {
      // The choice is in the event NAME, not a parameter: analytics carries only the allow-listed keys.
      bridge.trackRouter('router_f_cta_measure', stepParams('f-thanks'));
      afterDetails(function () { redirectWithLeadId(CTA_DESTINATIONS.measure); });
    }));
    root.appendChild(primaryButton(COPY.arm_f_s4_button_losssheet, function () {
      bridge.trackRouter('router_f_cta_loss_sheet', stepParams('f-thanks'));
      afterDetails(function () { redirectWithLeadId(CTA_DESTINATIONS.loss_sheet); });
    }));
  };

  function init(injectedBridge, mountEl) {
    bridge = injectedBridge;
    root = mountEl || document.getElementById('routerFRoot');
    if (!root) { return; }
    root.setAttribute('data-rd-root', '1');
    // Clarity session replay records button text and click targets; the funding answer IS a button label, and
    // screens 2-3 hold an address and contact details. Mask this whole arm (the same attribute auth pages use).
    root.setAttribute('data-clarity-mask', 'true');
    // The unload net for the details write (see beaconDetails).
    try { window.addEventListener('pagehide', beaconDetails); } catch (e) { /* none */ }
    try { document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') beaconDetails(); }); } catch (e) { /* none */ }
    show('f-funding');
  }

  window.RouterVariantF = { init: init, COPY: COPY, DRAFT_COPY: DRAFT_COPY, STEP_INDEX: STEP_INDEX };
})();
