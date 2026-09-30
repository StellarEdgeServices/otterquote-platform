// js/ho6-start.js
//
// gh-2378 (HO-6): /ho6/start, the contact page the /ho6 landing buttons lead to. One screen (contact) plus a thank-you, built as a STEP
// CONTAINER: the steps live in the STEPS table below, so "tell us about your job" and the loss sheet / measurement upload (Dustin's
// stated next builds, #2371 5898973136) register one entry each and never rewrite this file's flow.
//
// Lead machinery comes from js/oq-lead-core.js (the Arm F machinery as a shared module). leads.variant = 'ho6', leads.utm_campaign = 'ho-6'.
//
// CONSENT (Tier C, APPROVED by Dustin 2026-09-29, #2378 comment 5899644479, "Consent as recommended"). ONE constant, pinned by an md5 test
// (tests/gh2378-ho6.mjs H-consent), exactly like Arm F's consent is pinned. Do not edit these strings without a new ruling and a new LEGAL-READ.
//   - phone is optional
//   - the email line is always shown
//   - the checkbox is unchecked by default and is the ONLY thing that consents to text/call
//   - stored via record-lead-details as {key, given (checkbox state), text (the exact strings shown, joined by one space)}; the Edge
//     Function stamps the timestamp, IP and user agent, same as Arm F / HO-2.
(function () {
  'use strict';

  var CONSENT = Object.freeze({
    key: 'ho6_contact_consent',
    email_line: 'Otter Quotes may email me about my project.',
    checkbox_label: 'Also text or call me at the number above about my project.'
  });
  var CONSENT_TEXT = CONSENT.email_line + ' ' + CONSENT.checkbox_label;

  var COPY = Object.freeze({
    error_first: 'Please enter your first name.',
    error_last: 'Please enter your last name.',
    error_email: 'Please enter a valid email address.',
    error_phone: 'Please enter a valid phone number, or leave it blank.',
    error_phone_needed: 'Add a phone number, or uncheck the box.',
    error_generic: 'Something went wrong. Please try again.',
    thanks_suffix: ". We'll email you your next steps."   // "Thanks, [first name]" + this. No call promise anywhere (H16).
  });

  var CORE = window.OQLeadCore.create({ variant: 'ho6', campaign: 'ho-6' });
  var STEP_INDEX = { contact: 1, thanks: 2 };
  var submitting = false;
  var eventFired = false;
  var current = null;
  var firstName = '';

  function $(id) { return document.getElementById(id); }
  function stepParams(step, extra) {
    var p = { step: step, step_index: STEP_INDEX[step] };
    if (extra) { Object.keys(extra).forEach(function (k) { p[k] = extra[k]; }); }
    return p;
  }

  // ── The step container. Each step: the id of its <section data-ho6-step>, and an optional onShow. ──
  var STEPS = {
    contact: { el: 'ho6StepContact' },
    thanks: {
      el: 'ho6StepThanks',
      onShow: function () { $('ho6ThanksLine').textContent = 'Thanks, ' + firstName + COPY.thanks_suffix; }
    }
  };
  function showStep(name) {
    if (!STEPS[name]) return;
    Object.keys(STEPS).forEach(function (k) { $(STEPS[k].el).hidden = (k !== name); });
    current = name;
    if (STEPS[name].onShow) STEPS[name].onShow();
    try { window.scrollTo(0, 0); } catch (e) {}
    CORE.trackEvent('ho6_step_view', stepParams(name));
  }

  // ── Validation (same phone rules as Arm F / start.html: 10 US digits, NANP-shaped, not one repeated digit) ──
  function normalizePhone(raw) {
    var d = (raw || '').replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d;
  }
  function isValidUsPhone(raw) {
    var d = normalizePhone(raw);
    return d.length === 10 && !/^(\d)\1{9}$/.test(d) && /^[2-9]\d{2}[2-9]\d{6}$/.test(d);
  }
  function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
  function setErr(id, msg) { $(id).textContent = msg || ''; }

  function buildDetailsBody(v, newId) {
    var fields = ['name', 'email'];
    if (v.phoneTyped) fields.push('phone');
    var pageUrl = null;
    try { pageUrl = (window.location.href || '').slice(0, 2000) || null; } catch (e) {}
    return {
      lead_id: newId,
      funding_type: null,
      property_address: null,
      fbc: CORE.deriveFbc(),
      fbp: CORE.readCookie('_fbp'),
      consent: { key: CONSENT.key, given: v.callTextConsent, text: CONSENT_TEXT },
      page_url: pageUrl,
      submitted_fields: fields,
      phone_as_typed: v.phoneTyped,
      form_payload: { name: v.nameTyped, phone: v.phoneTyped, email: v.emailTyped }
    };
  }

  // The conversion: GA4 generate_lead + Meta Lead, exactly once, sharing ONE event id. Fires only after the leads row is saved.
  function fireConversion(leadId) {
    if (eventFired) return;
    eventFired = true;
    CORE.trackEvent('ho6_contact_submitted', stepParams('contact'));
    CORE.trackEvent('generate_lead', stepParams('contact', { event_id: leadId }));
    try { fbq('track', 'Lead', {}, { eventID: leadId }); } catch (e) {}
  }

  function onSubmit(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (submitting) return;
    var first = ($('ho6First').value || '').trim();
    var last = ($('ho6Last').value || '').trim();
    var email = ($('ho6Email').value || '').trim();
    var phoneTyped = $('ho6Phone').value || '';
    var phoneTrim = phoneTyped.trim();
    var checked = !!$('ho6TextCall').checked;
    ['ho6FirstErr', 'ho6LastErr', 'ho6EmailErr', 'ho6PhoneErr', 'ho6FormErr'].forEach(function (id) { setErr(id, ''); });
    var bad = false;
    if (!first) { setErr('ho6FirstErr', COPY.error_first); bad = true; }
    if (!last) { setErr('ho6LastErr', COPY.error_last); bad = true; }
    if (!isValidEmail(email)) { setErr('ho6EmailErr', COPY.error_email); bad = true; }
    if (phoneTrim && !isValidUsPhone(phoneTrim)) { setErr('ho6PhoneErr', COPY.error_phone); bad = true; }
    else if (checked && !phoneTrim) { setErr('ho6PhoneErr', COPY.error_phone_needed); bad = true; }
    if (bad) return;

    var v = {
      phoneTyped: phoneTyped, nameTyped: first + ' ' + last, emailTyped: $('ho6Email').value || '',
      callTextConsent: checked && !!phoneTrim
    };
    submitting = true;
    var btn = $('ho6Submit'); btn.disabled = true;
    function failed(err) {
      try { console.error('[ho6-start] lead save failed:', err); } catch (e) {}
      submitting = false; btn.disabled = false;
      setErr('ho6FormErr', COPY.error_generic);
    }
    var saving;
    try {
      saving = CORE.insertFreshLead(first + ' ' + last, email, phoneTrim ? normalizePhone(phoneTrim) : null);
    } catch (e) { failed(e); return; }   // the supabase client is null when the deferred CDN script did not load
    saving.then(function (leadId) {
      firstName = first;
      fireConversion(leadId);
      // The consent record waits for NOTHING: start it in the same tick the insert resolved, with set_lead_role (the #1932 alert) in parallel.
      CORE.sendDetails(buildDetailsBody(v, leadId), leadId);
      CORE.setRole(leadId);
      showStep('thanks');
    }, failed);
  }

  function init() {
    var root = $('ho6Steps');
    if (!root) return;
    root.setAttribute('data-clarity-mask', 'true');   // session replay must not record names, emails or phone numbers
    $('ho6TextCall').checked = false;
    $('ho6Form').addEventListener('submit', onSubmit);
    $('ho6Submit').disabled = false;   // ships disabled in the markup; enabled only once this handler is attached
    CORE.installUnloadNet();
    showStep('contact');
    function tagClarity() { try { if (window.clarity) { clarity('set', 'variant', 'ho6'); } } catch (e) {} }
    if (window.__oqGateReady) { tagClarity(); } else { (window.__oqOnGateReady = window.__oqOnGateReady || []).push(tagClarity); }
  }

  window.Ho6Start = { CONSENT: CONSENT, CONSENT_TEXT: CONSENT_TEXT, COPY: COPY, STEPS: STEPS, showStep: showStep };
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
