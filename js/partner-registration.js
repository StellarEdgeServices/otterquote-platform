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
 * Marker (localStorage 'oq_partner_pending_registration'): email, ts (written),
 * termsAcceptedAt (the submit that followed the ticked terms checkbox) and
 * rpcArgs (the EXACT register_partner arguments the signup page built: agent
 * type, name, phone, company, recruit code, UTM fields, fbclid, li_fat_id,
 * funnel_id, ... -- so a dashboard-completed registration is attributed
 * identically to a page-completed one). No password. Expires after 7 days.
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
  var TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

  root.PartnerRegistration = { KEY: KEY, TTL_MS: TTL_MS, TYPES: TYPES, readMarker: readMarker, clearMarker: clearMarker, buildParams: buildParams, complete: complete };
})(typeof window !== 'undefined' ? window : this);
