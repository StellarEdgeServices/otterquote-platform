// js/oq-lead-core.js
//
// gh-2378 (HO-6): the lead machinery /start Arm F uses, as a standalone shared module so a new lead page (today /ho6/start) does not
// copy Arm F's screens. It is a deliberate port of the SAME logic that lives inline in start.html and js/router-variant-f.js:
//   collectAttribution, insertFreshLead (incl. the X-OQ-Internal header + is_synthetic), set_lead_role(homeowner) (the #1932 alert),
//   the record-lead-details Edge Function call (keepalive fetch, one retry, sendBeacon on pagehide), and the analytics wrapper.
// start.html and router-variant-f.js are NOT edited and do not load this file, so every /start arm stays byte-identical (#2378).
// If Arm F's machinery ever changes, this file is the second place to look; tests/gh2378-ho6.mjs H9 asserts the payload shapes.
//
// Usage:  var core = OQLeadCore.create({ variant: 'ho6', campaign: 'ho-6' });
// PII DISCIPLINE (same as Arm F): contact details and the consent text go ONLY to the leads insert and the Edge Function. Analytics
// events carry variant / step / step_index / ua_context / lead_id (and event_id on generate_lead) and nothing else.
(function () {
  'use strict';

  var ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
  var CLICK_ID_KEYS = { fbclid: true, gclid: true };
  var DETAILS_FUNCTION = 'record-lead-details';
  var DETAILS_RETRIES = 1;
  var DETAILS_RETRY_DELAY_MS = 800;

  function create(opts) {
    var variant = opts.variant;
    var forcedCampaign = opts.campaign || null;   // when set, leads.utm_campaign is always this value (HO-6: 'ho-6')
    var leadId = null;
    var sb = null;
    var pendingDetails = [];
    var detailsInFlight = [];

    // ── Supabase client: created lazily on first use (the UMD bundle is deferred), never at parse time. Same as start.html ensureSb().
    function ensureSb() {
      if (sb) return sb;
      try {
        if (typeof supabase !== 'undefined' && typeof CONFIG !== 'undefined') {
          sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON, {
            auth: { storage: window.OtterQuoteCookieStorage, storageKey: window.OTTERQUOTE_AUTH_STORAGE_KEY || 'sb-otterquote-auth' }
          });
        }
      } catch (e) { /* null-checked at every use */ }
      return sb;
    }

    // ── Internal-traffic marker (gh-2068): attached to the leads insert ONLY, never client-wide.
    function internalWalk() {
      try { return new URLSearchParams(window.location.search).get('oq_internal') === '1'; } catch (e) { return false; }
    }
    function internalHeader() {
      try {
        var cookieMatch = document.cookie.match(/(?:^|; )oq_internal=([^;]*)/);
        var cookieFlag = !!(cookieMatch && decodeURIComponent(cookieMatch[1]) === '1');
        return (internalWalk() || cookieFlag || !!window.OQ_INTERNAL) ? { 'x-oq-internal': '1' } : {};
      } catch (e) { return window.OQ_INTERNAL ? { 'x-oq-internal': '1' } : {}; }
    }

    // ── Attribution ──
    function cleanAttrValue(raw, max) {
      if (typeof raw !== 'string') return null;
      var v = raw.replace(/[^\x20-\x7E]/g, '').trim().slice(0, max || 200);
      return v || null;
    }
    function readCookie(name) {
      try {
        var m = String(document.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
      } catch (e) { return null; }
    }
    function readFirstTouch() {
      try {
        var raw = readCookie('oq_ft');
        var obj = raw ? JSON.parse(raw) : null;
        return obj && typeof obj === 'object' ? obj : null;
      } catch (e) { return null; }
    }
    function collectAttribution() {
      var params = new URLSearchParams(window.location.search);
      var ft = readFirstTouch();
      var out = {};
      ATTR_KEYS.forEach(function (k) {
        var max = CLICK_ID_KEYS[k] ? 1000 : 200;
        out[k] = cleanAttrValue(params.get(k), max) || (ft ? cleanAttrValue(ft[k], max) : null) || null;
      });
      if (forcedCampaign) out.utm_campaign = forcedCampaign;
      out.v = variant;
      return out;
    }
    function deriveFbc() {
      var c = readCookie('_fbc');
      if (c) return c;
      try {
        var id = new URLSearchParams(window.location.search).get('fbclid');
        if (id) return 'fb.1.' + Date.now() + '.' + id;
      } catch (e) { /* no fbclid */ }
      return null;
    }

    // ── Analytics ──
    var uaContext = (function () {
      try {
        var ua = navigator.userAgent || '';
        if (/FBAN|FBAV|FB_IAB/.test(ua)) return 'fb_iab';
        if (/Instagram/.test(ua)) return 'ig_iab';
        return 'other';
      } catch (e) { return 'other'; }
    })();
    function trackEvent(name, extra) {
      try {
        var p = extra || {};
        p.variant = variant;
        p.ua_context = uaContext;
        if (leadId) p.lead_id = leadId;
        if (p.step !== undefined && p.step !== null) {
          try {
            if (window.clarity) {
              clarity('set', 'step', String(p.step));
              clarity('event', 'ho6_' + p.step);
              if (internalWalk()) clarity('set', 'internal', '1');
            }
          } catch (e2) {}
        }
        gtag('event', name, p);
      } catch (e) { /* analytics must never break the page */ }
    }

    // ── The lead row (existing columns only: an unknown column makes PostgREST reject the whole insert) ──
    function insertFreshLead(name, email, phoneDigits) {
      var newId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : (
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        })
      );
      var attr = collectAttribution();
      var payload = {
        id: newId, name: name, email: email, phone: phoneDigits, source: 'router',
        utm_source: attr.utm_source, utm_medium: attr.utm_medium, utm_campaign: attr.utm_campaign,
        utm_content: attr.utm_content, utm_term: attr.utm_term, fbclid: attr.fbclid, gclid: attr.gclid,
        variant: variant
      };
      if (internalWalk() || window.OQ_INTERNAL) { payload.is_synthetic = true; }
      var client = ensureSb();
      var leadInsert = client.from('leads').insert(payload);
      var hdr = internalHeader();
      if (hdr['x-oq-internal']) { leadInsert.setHeader('x-oq-internal', hdr['x-oq-internal']); }
      return leadInsert.then(function (res) {
        if (res && res.error) throw res.error;
        leadId = newId;
        try { if (window.clarity) { clarity('identify', newId); } } catch (e2) {}
        return newId;
      });
    }

    // ── Failure reporting: lead id, attempt count and error class only, never personal data ──
    function reportFailure(what, newId, attempts, err) {
      var msg = 'oq-lead-core (' + variant + '): ' + what + ' failed after ' + attempts + ' attempt(s)';
      try {
        if (window.Sentry && typeof window.Sentry.captureMessage === 'function') {
          window.Sentry.captureMessage(msg, { level: 'error', extra: { lead_id: newId, attempts: attempts, reason: err && err.name ? String(err.name) : 'unknown' } });
        } else if (window._oqErrorBuffer) {
          window._oqErrorBuffer.push({ type: 'error', message: msg + ' (lead_id ' + newId + ')' });
        }
      } catch (e) { /* never throw */ }
    }
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

    // ── set_lead_role(homeowner): trips the #1932 new-lead alert ──
    function setRole(newId) {
      return callWithRetry('set_lead_role (the new-lead alert will not fire)', newId,
        function () { return ensureSb().rpc('set_lead_role', { p_lead_id: newId, p_role: 'homeowner' }); },
        function (res) { return !!res && !res.error && res.data !== false; });
    }

    // ── record-lead-details: a SIMPLE cross-origin request (text/plain, no custom headers, anon key in the query) with keepalive ──
    function detailsUrl() {
      if (typeof CONFIG === 'undefined' || !CONFIG.SUPABASE_URL) return null;
      var base = String(CONFIG.SUPABASE_URL).replace(/\/+$/, '') + '/functions/v1/' + DETAILS_FUNCTION;
      var key = CONFIG.SUPABASE_ANON;
      return key ? base + '?apikey=' + encodeURIComponent(key) : base;
    }
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
      return ensureSb().functions.invoke(DETAILS_FUNCTION, { body: body });
    }
    function sendDetails(body, newId) {
      var entry = { body: body, beaconSent: false };
      pendingDetails.push(entry);
      var p = callWithRetry('record-lead-details', newId,
        function () { return postDetails(body); },
        function (res) {
          var ok = !!res && !res.error && !!res.data && res.data.ok === true;
          if (ok) { var i = pendingDetails.indexOf(entry); if (i !== -1) pendingDetails.splice(i, 1); }
          return ok;
        },
        function (res) { return !!(res && res.data && res.data.reason === 'lead_out_of_scope'); });
      detailsInFlight.push(p);
      function done() { var i = detailsInFlight.indexOf(p); if (i !== -1) detailsInFlight.splice(i, 1); }
      p.then(done, done);
      return p;
    }
    // The tab-close net: an unconfirmed details body is re-sent once with sendBeacon (server is first-write-wins, so a duplicate is harmless).
    function beaconDetails() {
      var url = detailsUrl();
      if (!url) return;
      pendingDetails.slice().forEach(function (entry) {
        if (entry.beaconSent) return;
        try {
          if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([JSON.stringify(entry.body)], { type: 'text/plain;charset=UTF-8' }))) { entry.beaconSent = true; }
        } catch (e) { /* best-effort */ }
      });
    }
    function installUnloadNet() {
      try { window.addEventListener('pagehide', beaconDetails); } catch (e) {}
      try { document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') beaconDetails(); }); } catch (e) {}
    }

    return {
      variant: variant,
      get leadId() { return leadId; },
      collectAttribution: collectAttribution, deriveFbc: deriveFbc, readCookie: readCookie,
      trackEvent: trackEvent, insertFreshLead: insertFreshLead, setRole: setRole,
      sendDetails: sendDetails, beaconDetails: beaconDetails, installUnloadNet: installUnloadNet
    };
  }

  window.OQLeadCore = { create: create };
})();
