# Runbook: Netlify Cert Renewal Failure

**Type:** Certificate / TLS incident
**Applies to:** otterquote.com, app.otterquote.com (Netlify-hosted production domains)
**Last updated:** 2026-08-12 — Created per GitHub #551 (SSL/cert-expiry acceptance criterion)

---

## When This Fires

- A Netlify "certificate renewal failed" email notification to `dustinstohler1@gmail.com`. Netlify auto-provisions and renews Let's Encrypt certs starting ~30 days before expiry and retries for roughly three weeks; today this email is the earliest reliable signal — see Known Gap below.
- A `platform-health-check` Phase 3 public-path probe alert citing `invalid peer certificate`, `NotValidForName`, or `Expired` (logged to `platform_alerts_log`). This is the exact signature behind the 2026-06-21 ~20.5-hour production outage on otterquote.com (RCA in GitHub #527, hardening tracked in #551).
- A BetterStack uptime incident on any otterquote.com / app.otterquote.com monitor whose error text mentions "SSL", "certificate", or "peer certificate." SSL/TLS verification is **On** for these monitors, so a broken certificate already fails the HTTP check reactively today.

## Known Gap (as of 2026-08-12)

The BetterStack account (`uptime.betterstack.com`, team `t531148`) is on the **Free plan**. Proactive SSL-expiration and domain-expiration alerting ("alert N days before expiry") is gated behind a paid plan upgrade and is currently **off** on every monitor, including `otterquote.com` (monitor 4316257) and `OtterQuote App Production` / app.otterquote.com (monitor 4378036). Coverage today is reactive only: an alert fires after a certificate has already broken (via the probe/uptime paths above), not before it expires. Closing that gap requires a Dustin-approved BetterStack plan upgrade — Tier C (money), not something to select unilaterally.

## Tier A Steps (autonomous)

- Step 1: Confirm scope — check the TLS handshake against both domains (e.g. `curl -vI https://otterquote.com` and `https://app.otterquote.com`) and capture the exact error (expired / wrong hostname / self-signed / handshake failure).
- Step 2: In Netlify → Site → Domain management → HTTPS, note the certificate status shown for the affected site (e.g. "Renewal failed," "Provisioning," issuer, expiry date).
- Step 3: Check for recent DNS changes on the affected domain — Netlify's Let's Encrypt renewal fails if DNS no longer resolves to Netlify, or if a CAA record blocks Let's Encrypt.

## Tier B Steps (execute + notify Dustin)

- Step 1: In Netlify → HTTPS, trigger "Renew certificate" / "Verify DNS configuration" to force a retry.
- Step 2: If DNS is misconfigured, do not change DNS records unilaterally — that is a Tier C domain change. Notify Dustin with the exact record diff needed.
- Step 3: Re-check after ~10–15 minutes; if the certificate is valid, smoke-test both domains over HTTPS and notify Dustin of resolution.

## Tier C Steps (escalate)

- Step 1: If automatic renewal keeps failing after a forced retry (CAA record, registrar-level lock, Netlify-side issue), escalate to Dustin with the exact error from Netlify's HTTPS panel. This is a live customer-facing outage per the 2026-06-21 precedent and outranks other backlog work (R-072).
- Step 2: If closing the proactive-alerting gap (BetterStack SSL-expiry monitoring) is wanted, surface the plan-upgrade decision to Dustin same-turn as a Tier C money item (R-016) rather than deferring it.

## Resolution Criteria

- TLS handshake against both otterquote.com and app.otterquote.com returns a valid, non-expired certificate matching the hostname.
- Netlify's HTTPS panel shows an active Let's Encrypt certificate, not "Renewal failed" / "Provisioning."
- No new `invalid peer certificate` rows in `platform_alerts_log` for 15+ minutes post-fix.
- Any open BetterStack incident on the affected monitor is resolved (auto or manual).

## Auto-resolve eligible: no

Certificate issues are a customer-facing trust/security signal, and a flapping certificate can auto-resolve then fail again. A human should confirm resolution rather than relying on a single successful probe.

---

## See Also

- GitHub #527 — RCA for the 2026-07-12 public-path timeout investigation that surfaced the cert-monitoring gap
- GitHub #551 — hardening + SSL monitoring ask this runbook was created to satisfy
- `runbooks/README.md` — format and coverage policy
- BetterStack monitors: `otterquote.com` (id 4316257), `OtterQuote App Production` = app.otterquote.com (id 4378036), team `t531148`
