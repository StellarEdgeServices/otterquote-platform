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
 * Marker (localStorage 'oq_partner_pending_registration'): email, agentType,
 * firstName, lastName, phone, company, ts. No password. Every field is read here
 * or by the signup pages' retry check; it expires after 7 days.
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

  /** register_partner arguments for the signed-in user's OWN email. Null when the input cannot satisfy the RPC. */
  function buildParams(input, ownEmail, isTest) {
    input = input || {};
    var first = String(input.firstName || '').trim();
    var last = String(input.lastName || '').trim();
    if (!norm(ownEmail) || !first || !last || TYPES.indexOf(input.agentType) === -1) return null;
    var phone = String(input.phone || '').trim();
    var company = String(input.company || '').trim();
    return {
      p_agent_type: input.agentType,
      p_first_name: first,
      p_last_name: last,
      p_email: norm(ownEmail),
      p_phone: phone || null,
      p_company: company || null,
      p_is_test: !!isTest,
    };
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
