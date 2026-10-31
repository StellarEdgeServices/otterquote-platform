/**
 * js/contractor-sms-verify.js -- D-391 layer 3 (#2875, pairs with #1916): the contractor
 * "verify a number for text alerts" step at signup (contractor-pre-approval.html, step 3).
 *
 * THIS FILE CONTAINS NO CONSENT OR LEGAL WORDING. The consent sentence the contractor sees is the
 * `disclosure_text` of the current row in public.sms_disclosure_versions, rendered verbatim with
 * textContent. The same row is what contractor-sms-verify (the Edge Function) copies onto the
 * per-number consent record, so the words on the screen and the words on the record cannot drift.
 * If no current row exists the screen offers nothing (fails closed): no box, no field, no text.
 *
 * What it guarantees (pinned by tests/gh1916-pre-approval-sms-consent.mjs):
 *   - the consent box is NEVER pre-ticked;
 *   - "Send code" and "Verify" make NO request unless the box is ticked (the Edge Function refuses a
 *     request without consent_checked === true as well, so this is defence in depth);
 *   - nothing is recorded, and no number becomes textable, until the Edge Function answers success
 *     for a correct code. This file writes nothing to the database itself;
 *   - texts are optional: skipping the step costs the contractor nothing (D-391 Amendment 1, #2877).
 *
 * Only functional, non-legal screen text lives here (button labels, error explanations).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OQSmsVerify = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FUNCTION_NAME = 'contractor-sms-verify';
  var SOURCE = 'signup';

  // Functional explanations of the Edge Function's machine codes. Not consent text.
  var ERROR_TEXT = {
    consent_required: 'Tick the box above to receive a code.',
    bad_phone: 'Enter a valid US mobile number.',
    bad_code: 'Enter the 6-digit code from the text.',
    wrong_code: 'That code is not right. Check it and try again.',
    no_pending_code: 'That code has expired. Send a new code.',
    too_many_attempts: 'Too many tries. Wait a few minutes, then send a new code.',
    rate_limited: 'Too many requests. Wait a few minutes and try again.',
    // Wording from the D-391 spec rule 5: "Re-adding an opted-out number requires texting START first." The code cannot reach an opted-out number.
    number_suppressed: "This number has opted out of texts. Re-adding an opted-out number requires texting START first, because the code can't reach an opted-out number.",
    number_paused: 'This number is under review, so we cannot send it a code right now.',
    disclosure_stale: 'The text-alerts terms changed. Reload the page and try again.',
    disclosure_unavailable: 'Text alerts are not available yet. We will use email.',
    verify_not_configured: 'Text alerts are not available yet. We will use email.',
    code_not_sent: 'We could not send the code. Try again in a minute.',
    not_owner: 'You are not signed in to this account.',
    auth_required: 'Please sign in again.',
    auth_invalid: 'Please sign in again.'
  };
  var GENERIC_ERROR = 'Something went wrong. Try again, or skip this step and we will use email.';

  function errorText(code) {
    return Object.prototype.hasOwnProperty.call(ERROR_TEXT, code) ? ERROR_TEXT[code] : GENERIC_ERROR;
  }

  /**
   * supabase-js hides a non-2xx JSON body behind error.context (a Response). Pull the machine
   * error_code out of whichever place it is in.
   */
  async function extractErrorCode(result) {
    try {
      if (result && result.data && typeof result.data.error_code === 'string') return result.data.error_code;
      var ctx = result && result.error && result.error.context;
      if (ctx && typeof ctx.json === 'function') {
        var j = await ctx.json();
        if (j && typeof j.error_code === 'string') return j.error_code;
      }
    } catch (e) { /* fall through */ }
    return 'unknown';
  }

  /**
   * The state machine, free of the DOM so tests can drive it with fakes.
   * deps: { loadDisclosure(): Promise<{id, disclosure_text}|null>,
   *         invoke(body): Promise<{data, error}>,   // supabase.functions.invoke('contractor-sms-verify', { body })
   *         contractorId: string }
   */
  function createController(deps) {
    var state = {
      disclosure: null,   // { id, disclosure_text } or null => nothing is offered
      consentChecked: false, // never pre-ticked
      codeSent: false,
      verified: false,
      verifiedPhone: null,
      busy: false
    };

    function body(action, phone, extra) {
      var b = {
        action: action,
        contractor_id: deps.contractorId,
        phone: phone,
        source: SOURCE,
        consent_checked: state.consentChecked === true,
        disclosure_version_id: state.disclosure ? state.disclosure.id : ''
      };
      if (extra) for (var k in extra) b[k] = extra[k];
      return b;
    }

    async function init() {
      state.disclosure = null;
      try {
        var d = await deps.loadDisclosure();
        if (d && typeof d.id === 'string' && d.id && typeof d.disclosure_text === 'string' && d.disclosure_text.trim() !== '') {
          state.disclosure = { id: d.id, disclosure_text: d.disclosure_text };
        }
      } catch (e) { state.disclosure = null; } // unknown => offer nothing
      return state.disclosure !== null;
    }

    function setConsent(checked) {
      state.consentChecked = checked === true;
      if (!state.consentChecked) state.codeSent = false; // un-ticking withdraws the pending request
    }

    async function sendCode(phone) {
      if (!state.disclosure) return { ok: false, error_code: 'disclosure_unavailable', message: errorText('disclosure_unavailable') };
      if (state.consentChecked !== true) return { ok: false, error_code: 'consent_required', message: errorText('consent_required') };
      if (state.busy) return { ok: false, error_code: 'busy', message: GENERIC_ERROR };
      state.busy = true;
      try {
        var res = await deps.invoke(body('start', phone));
        if (!res.error && res.data && res.data.success === true) { state.codeSent = true; return { ok: true }; }
        var code = await extractErrorCode(res);
        return { ok: false, error_code: code, message: errorText(code) };
      } catch (e) {
        return { ok: false, error_code: 'network', message: GENERIC_ERROR };
      } finally { state.busy = false; }
    }

    async function checkCode(phone, code) {
      if (!state.disclosure) return { ok: false, error_code: 'disclosure_unavailable', message: errorText('disclosure_unavailable') };
      if (state.consentChecked !== true) return { ok: false, error_code: 'consent_required', message: errorText('consent_required') };
      if (state.busy) return { ok: false, error_code: 'busy', message: GENERIC_ERROR };
      state.busy = true;
      try {
        var res = await deps.invoke(body('check', phone, { code: String(code || '').trim() }));
        if (!res.error && res.data && res.data.success === true) {
          state.verified = true; state.verifiedPhone = phone;
          return { ok: true, number_id: res.data.number_id, reconfirmed: res.data.reconfirmed === true };
        }
        var c = await extractErrorCode(res);
        return { ok: false, error_code: c, message: errorText(c) };
      } catch (e) {
        return { ok: false, error_code: 'network', message: GENERIC_ERROR };
      } finally { state.busy = false; }
    }

    return { state: state, init: init, setConsent: setConsent, sendCode: sendCode, checkCode: checkCode };
  }

  /** Current, un-retired disclosure -- the same selection the Edge Function makes. */
  function makeLoadDisclosure(sb) {
    return async function () {
      var r = await sb.from('sms_disclosure_versions')
        .select('id, disclosure_text')
        .is('retired_at', null)
        .lte('effective_at', new Date().toISOString())
        .order('effective_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return r && r.data ? r.data : null;
    };
  }

  function el(doc, tag, attrs, text) {
    var n = doc.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /**
   * Build the screen inside `mountEl`. Returns the controller. Idempotent per element.
   * With no current disclosure row the mount shows one plain line and no controls.
   */
  async function mount(mountEl, sb, contractorId) {
    if (!mountEl || mountEl.getAttribute('data-oq-sms-mounted') === '1') return null;
    mountEl.setAttribute('data-oq-sms-mounted', '1');
    var doc = mountEl.ownerDocument;
    var ctl = createController({
      contractorId: contractorId,
      loadDisclosure: makeLoadDisclosure(sb),
      invoke: function (b) { return sb.functions.invoke(FUNCTION_NAME, { body: b }); }
    });
    var available = await ctl.init();

    mountEl.textContent = '';
    mountEl.appendChild(el(doc, 'strong', null, 'Text alerts (optional)'));
    if (!available) {
      mountEl.appendChild(el(doc, 'p', { 'data-oq-sms': 'unavailable' },
        'Text alerts are not available yet. We will use email.'));
      return ctl;
    }

    var row = el(doc, 'div', { 'class': 'check-group' });
    var box = el(doc, 'input', { type: 'checkbox', id: 'smsVerifyConsent' }); // no `checked`: never pre-ticked
    box.checked = false;
    var label = el(doc, 'label', { 'for': 'smsVerifyConsent' }, ctl.state.disclosure.disclosure_text); // verbatim, as text
    row.appendChild(box); row.appendChild(label);
    mountEl.appendChild(row);

    var links = el(doc, 'p', { 'data-oq-sms': 'links' });
    var a1 = el(doc, 'a', { href: 'sms-terms', target: '_blank', rel: 'noopener' }, 'SMS Terms');
    var a2 = el(doc, 'a', { href: 'privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy Policy');
    links.appendChild(a1); links.appendChild(doc.createTextNode(' · ')); links.appendChild(a2);
    mountEl.appendChild(links);

    var phone = el(doc, 'input', { type: 'tel', id: 'smsVerifyPhone', placeholder: '(555) 123-4567', autocomplete: 'tel', 'aria-label': 'Mobile number for text alerts' });
    var send = el(doc, 'button', { type: 'button', id: 'smsVerifySend' }, 'Send code');
    var codeIn = el(doc, 'input', { type: 'text', id: 'smsVerifyCode', inputmode: 'numeric', maxlength: '6', placeholder: '6-digit code', autocomplete: 'one-time-code', 'aria-label': 'Verification code' });
    var verify = el(doc, 'button', { type: 'button', id: 'smsVerifyCheck' }, 'Verify');
    var status = el(doc, 'p', { id: 'smsVerifyStatus', role: 'status', 'aria-live': 'polite' });
    var entry = el(doc, 'div', { id: 'smsVerifyEntry' });
    entry.appendChild(phone); entry.appendChild(send);
    var codeRow = el(doc, 'div', { id: 'smsVerifyCodeRow' });
    codeRow.style.display = 'none';
    codeRow.appendChild(codeIn); codeRow.appendChild(verify);
    mountEl.appendChild(entry); mountEl.appendChild(codeRow); mountEl.appendChild(status);

    function sync() {
      var on = ctl.state.consentChecked === true;
      send.disabled = !on || ctl.state.verified;
      verify.disabled = !on || ctl.state.verified;
      phone.disabled = !on || ctl.state.verified;
      codeRow.style.display = (on && ctl.state.codeSent && !ctl.state.verified) ? '' : 'none';
    }
    sync();
    box.addEventListener('change', function () { ctl.setConsent(box.checked); status.textContent = ''; sync(); });
    send.addEventListener('click', async function () {
      status.textContent = 'Sending…';
      var r = await ctl.sendCode(phone.value);
      status.textContent = r.ok ? 'Code sent. Enter it below.' : r.message;
      sync();
    });
    verify.addEventListener('click', async function () {
      status.textContent = 'Checking…';
      var r = await ctl.checkCode(phone.value, codeIn.value);
      status.textContent = r.ok ? 'Number verified and saved.' : r.message;
      sync();
    });
    return ctl;
  }

  return {
    FUNCTION_NAME: FUNCTION_NAME,
    SOURCE: SOURCE,
    errorText: errorText,
    extractErrorCode: extractErrorCode,
    createController: createController,
    makeLoadDisclosure: makeLoadDisclosure,
    mount: mount
  };
}));
