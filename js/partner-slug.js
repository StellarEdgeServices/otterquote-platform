/**
 * P18 (#3218) -- partner vanity slug picker helper.
 *
 * A partner picks a short, speakable address (otterquote.com/<slug>) that credits them exactly like /ref/<unique_code>.
 * This file is the client half of the data layer: it mirrors the server rules for instant feedback and calls the
 * set_partner_slug(p) RPC (SECURITY DEFINER, supabase/migrations_drafts/p18_vanity_slug_data.sql). The server is the
 * authority: every rule below is re-checked there, and a direct UPDATE of referral_agents.vanity_slug is refused by trigger.
 *
 * ROUTING_LIVE: the /<slug> routing edge function is a LATER PR. Until it ships and this flag is flipped to true, the
 * page must not present the short link as working or offer a copy button.
 */
(function (root) {
  'use strict';
  var MIN = 3, MAX = 30;
  var ROUTING_LIVE = false;
  var GENERIC_ERROR = 'Something went wrong. Please try again.';
  // Server RAISE texts are user-facing for these SQLSTATEs (22023 validation, 42501 not signed in / not active, P0002 no partner row).
  var SHOWN_CODES = { '22023': 1, '42501': 1, 'P0002': 1 };

  function normalize(raw) { return String(raw == null ? '' : raw).trim().toLowerCase(); }

  /** Same rules, same words as set_partner_slug(). The reserved / taken / blocklist checks are server-only. */
  function validate(raw) {
    var s = normalize(raw);
    if (!s) return { ok: false, slug: s, message: 'Enter a short link.' };
    if (s.length < MIN) return { ok: false, slug: s, message: 'Use at least 3 characters.' };
    if (s.length > MAX) return { ok: false, slug: s, message: 'Use 30 characters or fewer.' };
    if (!/^[a-z0-9-]+$/.test(s)) return { ok: false, slug: s, message: 'Use only letters, numbers and hyphens.' };
    if (s.charAt(0) === '-' || s.charAt(s.length - 1) === '-' || s.indexOf('--') !== -1)
      return { ok: false, slug: s, message: 'Hyphens cannot start or end the link or appear twice in a row.' };
    if (/^[0-9]+$/.test(s)) return { ok: false, slug: s, message: 'Include at least one letter.' };
    return { ok: true, slug: s, message: '' };
  }

  function shortUrl(siteUrl, slug) { return String(siteUrl || '').replace(/\/+$/, '') + '/' + slug; }
  function displayUrl(siteUrl, slug) { return shortUrl(siteUrl, slug).replace(/^https?:\/\//, ''); }

  /** A PostgREST error from the RPC -> the sentence to show the partner. */
  function messageForError(err) {
    if (err && SHOWN_CODES[err.code] && err.message) return String(err.message);
    return GENERIC_ERROR;
  }

  /** Validate, then call the RPC. Resolves { ok:true, slug, changed } or { ok:false, message }. Never throws. */
  async function save(sb, raw) {
    var v = validate(raw);
    if (!v.ok) return { ok: false, message: v.message };
    try {
      var res = await sb.rpc('set_partner_slug', { p: v.slug });
      if (res && res.error) return { ok: false, message: messageForError(res.error) };
      var d = res && res.data;
      if (!d || typeof d.slug !== 'string') return { ok: false, message: GENERIC_ERROR };
      return { ok: true, slug: d.slug, changed: d.changed !== false };
    } catch (e) {
      return { ok: false, message: GENERIC_ERROR };
    }
  }

  root.PartnerSlug = { MIN: MIN, MAX: MAX, ROUTING_LIVE: ROUTING_LIVE, GENERIC_ERROR: GENERIC_ERROR, normalize: normalize, validate: validate,
    shortUrl: shortUrl, displayUrl: displayUrl, messageForError: messageForError, save: save };
})(typeof window !== 'undefined' ? window : this);
