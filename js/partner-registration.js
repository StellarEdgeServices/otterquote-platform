/**
 * gh-2282 follow-up -- finish a partner registration for a signed-in user who has
 * an auth account but no referral_agents row.
 *
 * How that state arises: the partner signup pages run Auth.signUpWithPassword()
 * BEFORE the register_partner RPC (so a duplicate email can never leave an orphan
 * referral_agents row, #2282). If register_partner then fails (rate limit, network,
 * rejected email) the visitor has an auth account and no partner row. The signup
 * pages leave a pending marker in localStorage; partner-dashboard.html's
 * "No Partner Account Found" state uses this module to complete the registration.
 *
 * Marker (sessionStorage 'oq_partner_pending_registration' -- gh-2355: it holds name/phone/company, so it
 * must never persist in localStorage; a legacy localStorage copy is purged by the pages): email, ts (written),
 * termsAcceptedAt (the submit that followed the ticked terms checkbox) and
 * rpcArgs (the EXACT register_partner arguments the signup page built: agent
 * type, name, phone, company, recruit code, UTM fields, fbclid, li_fat_id,
 * funnel_id, ... -- so a dashboard-completed registration is attributed
 * identically to a page-completed one). No password. Expires after 24 hours (and with the tab).
 *
 * Terms-acceptance evidence: register_partner stamps partner_agreement_accepted_at
 * and the IP/UA attestation at CALL time. On this path that is later than the real
 * assent, so the true client-side time is passed in p_metadata (stored by the RPC in
 * referral_agents.metadata) as terms_accepted_at_client, with
 * completion_path = 'dashboard_marker'.
 *
 * Client-side only: register_partner is the existing anon/authenticated RPC.
 */
(function (root) {
  'use strict';
  var KEY = 'oq_partner_pending_registration';
  var TTL_MS = 24 * 60 * 60 * 1000;
  var TYPES = ['re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'];

  function norm(email) { return String(email || '').trim().toLowerCase(); }

  /** The marker for this exact email, or null (missing, malformed, other email, expired -- expired/malformed ones are removed). */
  function readMarker(storage, email, now) {
    var raw, m;
    try { raw = storage.getItem(KEY); } catch (e) { return null; }
    if (!raw) return null;
    try { m = JSON.parse(raw); } catch (e) { m = null; }
    var t = typeof now === 'number' ? now : Date.now();
    if (!m || typeof m !== 'object' || typeof m.ts !== 'number' || t - m.ts >= TTL_MS || m.ts > t + 60000) {
      try { storage.removeItem(KEY); } catch (e) { /* non-fatal */ }
      return null;
    }
    if (m.email !== norm(email)) return null;
    return m;
  }

  function clearMarker(storage) { try { storage.removeItem(KEY); } catch (e) { /* non-fatal */ } }

  /**
   * register_partner arguments for the signed-in user's OWN email, from a marker.
   * Null when the marker cannot satisfy the RPC (no args / type / name / terms time).
   */
  function buildParams(marker, ownEmail, isTest) {
    var a = marker && marker.rpcArgs;
    if (!a || typeof a !== 'object' || !norm(ownEmail)) return null;
    if (TYPES.indexOf(a.p_agent_type) === -1 || !String(a.p_first_name || '').trim() || !String(a.p_last_name || '').trim()) return null;
    if (typeof marker.termsAcceptedAt !== 'number' || !isFinite(marker.termsAcceptedAt)) return null;
    var p = {};
    Object.keys(a).forEach(function (k) { if (k.indexOf('p_') === 0) p[k] = a[k]; });
    p.p_email = norm(ownEmail);
    p.p_is_test = !!(isTest || a.p_is_test);
    var md = {};
    if (a.p_metadata && typeof a.p_metadata === 'object') Object.keys(a.p_metadata).forEach(function (k) { md[k] = a.p_metadata[k]; });
    md.terms_accepted_at_client = new Date(marker.termsAcceptedAt).toISOString();
    md.completion_path = 'dashboard_marker';
    p.p_metadata = md;
    return p;
  }

  /** Calls register_partner. status: 'created' | 'exists' (a row is already there; the dashboard's claim step links it) | 'error'. */
  async function complete(sb, params, storage) {
    var res;
    try { res = await sb.rpc('register_partner', params); } catch (e) { return { status: 'error', error: e }; }
    var err = res && res.error;
    if (!err) { clearMarker(storage); return { status: 'created' }; }
    if ((err.message || '').indexOf('partner_exists') !== -1) { clearMarker(storage); return { status: 'exists' }; }
    return { status: 'error', error: err };
  }


  /* ---------------------------------------------------------------------------------------------
   * gh-2355 re-collect recovery. The PII marker above is tab-scoped, so a partner who returns in a
   * NEW tab (confirmation / sign-in link) after a failed register_partner has no marker. The signup
   * pages therefore also leave a NON-PII context in localStorage (agent type + recruit code + UTM /
   * click-id / funnel attribution, no name/email/phone/company) and the dashboard re-collects the
   * rest (name, phone, company, a freshly ticked terms checkbox -> a NEW termsAcceptedAt).
   * Every string in FORMS is copied VERBATIM from the matching signup page (partner-re,
   * partner-insurance, partner-inspectors, partner-adjusters, partner-other); unknown type -> other.
   * ------------------------------------------------------------------------------------------- */
  var CTX_KEY = 'oq_partner_signup_ctx';
  var CTX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  var CTX_ATTR = ['p_recruit_code', 'p_utm_source', 'p_utm_medium', 'p_utm_campaign', 'p_utm_content', 'p_fbclid', 'p_li_fat_id', 'p_funnel_id'];
  var ERR_TEXT = 'Something went wrong. Please try again or email us at support@otterquote.com';
  var SUBMITTING = 'Setting up your account...';
  var TERMS_STD = [{ t: "I agree to Otter Quotes's " }, { a: 'partner-agreement.html', t: 'Partner Terms' }];
  var TERMS_ERR_STD = 'Please agree to the Partner Terms to continue.';
  var FORMS = {
    re_agent: { first: { label: 'First Name', ph: 'Jane' }, last: { label: 'Last Name', ph: 'Smith' }, phone: { label: 'Phone', ph: '(317) 555-1234' },
      company: { label: 'Brokerage / Agency Name', ph: 'Your Real Estate Company', required: true }, terms: TERMS_STD, termsError: TERMS_ERR_STD, submit: 'Create My Partner Account' },
    insurance_agent: { full: { label: 'Full Name', err: 'Please enter your first and last name.' }, phone: { label: 'Phone Number', ph: '' },
      company: { label: 'Brokerage / Agency Name', ph: '', required: true },
      terms: [{ t: 'I agree to the ' }, { a: '/partner-agreement.html', t: 'Partner Agreement' }, { t: ' and ' }, { a: '/terms.html', t: 'Terms' }],
      termsError: 'You must agree to the Partner Agreement and Terms.', submit: 'Create My Partner Account' },
    home_inspector: { first: { label: 'First Name', ph: 'John' }, last: { label: 'Last Name', ph: 'Doe' }, phone: { label: 'Phone', ph: '(555) 123-4567' },
      company: { label: 'Company Name', ph: 'ABC Home Inspections', required: true },
      terms: [{ t: "I agree to Otter Quotes's " }, { a: 'partner-agreement-inspector.html', t: 'Partner Terms' }], termsError: TERMS_ERR_STD, submit: 'Generate My Referral Link' },
    adjuster: { first: { label: 'First Name', ph: 'John' }, last: { label: 'Last Name', ph: 'Doe' }, phone: { label: 'Phone', ph: '(555) 123-4567' },
      company: { label: 'Employer / Adjusting Firm', ph: 'ABC Claims Adjusting', required: true }, terms: TERMS_STD, termsError: TERMS_ERR_STD, submit: 'Generate My Referral Link' },
    other: { first: { label: 'First Name', ph: 'John' }, last: { label: 'Last Name', ph: 'Doe' }, phone: { label: 'Phone', ph: '(555) 123-4567' },
      company: { label: 'Company / Business Name', ph: 'ABC Property Services', required: false, optional: '(optional)' }, terms: TERMS_STD, termsError: TERMS_ERR_STD, submit: 'Generate My Referral Link' }
  };

  /** The non-PII signup context ({agentType, attribution:{p_*}}) or null (missing / malformed / expired). */
  function readCtx(storage, now) {
    var raw, c;
    try { raw = storage.getItem(CTX_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try { c = JSON.parse(raw); } catch (e) { return null; }
    var t = typeof now === 'number' ? now : Date.now();
    if (!c || typeof c !== 'object' || typeof c.ts !== 'number' || t - c.ts >= CTX_TTL_MS || c.ts > t + 60000) return null;
    var attr = {};
    var a = c.attribution && typeof c.attribution === 'object' ? c.attribution : {};
    CTX_ATTR.forEach(function (k) { if (a[k] !== undefined && a[k] !== null && a[k] !== '') attr[k] = a[k]; });
    return { agentType: TYPES.indexOf(c.agentType) === -1 ? null : c.agentType, attribution: attr };
  }
  function clearCtx(storage) { try { storage.removeItem(CTX_KEY); } catch (e) { /* non-fatal */ } }
  function formFor(agentType) { return FORMS[agentType] || FORMS.other; }

  /** register_partner arguments from the re-collected values (v: {first,last,full,phone,company}), the ctx and the signed-in email. termsAcceptedAt = the fresh ticked submit. */
  function buildRecollectParams(agentType, v, ctx, ownEmail, isTest, termsAcceptedAt) {
    var type = TYPES.indexOf(agentType) === -1 ? 'other' : agentType;
    var form = formFor(type), first = String(v.first || '').trim(), last = String(v.last || '').trim();
    if (form.full) {
      var parts = String(v.full || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length < 2) return null;
      first = parts[0]; last = parts.slice(1).join(' ');
    }
    if (!first || !last || !String(v.phone || '').trim() || !norm(ownEmail)) return null;
    var company = String(v.company || '').trim();
    if (form.company.required && !company) return null;
    if (typeof termsAcceptedAt !== 'number' || !isFinite(termsAcceptedAt)) return null;
    var p = { p_agent_type: type, p_first_name: first, p_last_name: last, p_email: norm(ownEmail), p_phone: String(v.phone).trim(), p_company: company || null };
    var attr = (ctx && ctx.attribution) || {};
    CTX_ATTR.forEach(function (k) { p[k] = attr[k] !== undefined ? attr[k] : null; });
    p.p_is_test = !!isTest;
    p.p_metadata = { terms_accepted_at_client: new Date(termsAcceptedAt).toISOString(), completion_path: 'dashboard_recollect' };
    return p;
  }

  root.PartnerRegistration = { KEY: KEY, TTL_MS: TTL_MS, TYPES: TYPES, readMarker: readMarker, clearMarker: clearMarker, buildParams: buildParams, complete: complete,
    CTX_KEY: CTX_KEY, FORMS: FORMS, ERR_TEXT: ERR_TEXT, SUBMITTING: SUBMITTING, readCtx: readCtx, clearCtx: clearCtx, formFor: formFor, buildRecollectParams: buildRecollectParams };
})(typeof window !== 'undefined' ? window : this);
