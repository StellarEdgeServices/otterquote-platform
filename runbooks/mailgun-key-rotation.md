# Runbook: Mailgun Key Rotation

**Type:** Credential rotation procedure  
**Applies to:** All environments  
**Last updated:** 2026-05-14 -- Created per Postmortem A4 (docusign-keypair-rotation-20260514)

---

## When to Run This

- Mailgun API key is suspected to be compromised
- Routine security rotation (recommended: every 90 days)
- Any team member with access to the key departs
- Mailgun account access is transferred or audited

---

## Env Vars Covered

| Supabase Secret Name | Description | Edge Functions |
|---|---|---|
| `MAILGUN_API_KEY` | Mailgun API key | **31 Edge Functions** -- see the enumeration below |
| `MAILGUN_DOMAIN` | Sending domain | the same 31 |

> **CORRECTED 2026-08-31 (CTO `cto-2026-08-31T18:43:39Z`, issue #1406).** This table named
> **two** Edge Functions until today. The real number is **31**, enumerated from a clean clone
> of `main` with `grep -rIl "MAILGUN_API_KEY" supabase/functions | wc -l`:
>
> `admin-contractor-action` `approve-payout` `approve-warranty-drift` `check-rate-limits`
> `counter-sig-reminders` `create-invoice` `docusign-webhook` `mark-job-complete`
> `mark-payout-paid` `notify-admin-new-contractor` `notify-contractors`
> `notify-feature-request` `notify-partner-w9` `notify-payout-pending`
> `platform-health-check` `process-auto-bids` `process-bid-expirations`
> `process-coi-reminders` `process-dunning` `process-payout-reminders`
> `refresh-warranty-manifest` `resend-hover-link` `send-adjuster-email`
> `send-bid-confirmation` `send-home-profile-prompt` `send-incomplete-onboarding-reminders`
> `send-message-notification` `send-partner-status-email` `send-support-email`
> `send-welcome-email` `switch-contractor`
>
> A rotation verified against two of these has verified 2/31 and signed off on the other 29
> untested -- including the DocuSign webhook's email leg and every payout notice.

### A SECOND CREDENTIAL RIDES THE SAME VENDOR AND IS NOT THIS ONE

Supabase Auth sends **magic links over Mailgun SMTP**, using `MAILGUN_SMTP_PASSWORD`
(`postmaster@mail.otterquote.com`) -- a different credential from `MAILGUN_API_KEY`.
**Rotating the API key does not rotate SMTP and does not break magic links.** Conversely,
nothing in this runbook covers an SMTP-password rotation. Do not conflate them.

> **Note on `MAILGUN_DOMAIN`:** This value is a domain name, not a secret, but it is stored as a Supabase secret for consistency. It typically does not need rotation unless the sending domain changes. The `process-dunning` EF falls back to `mail.otterquote.com` if this secret is absent.
>
> **DO NOT SET THIS TO THE SANDBOX DOMAIN. CORRECTED 2026-08-31 (CTO, #1406).** This note
> read *"Current value from Supabase: `sandboxd2b099fad357409b845e5f4c5e8bd74e.mailgun.org`"*
> and that was **false**. The live sending domain is **`mail.otterquote.com`**, measured
> rather than assumed:
>
> ```sql
> select created_at, is_test, metadata from activity_log
> where event_type='bid_confirmation_email_sent' order by created_at desc limit 3;
> -- metadata.mailgun_status : 200
> -- metadata.message_id     : <20260817225756.d80268b883d336b1@mail.otterquote.com>
> -- 367 rows on this event_type
> ```
>
> **Why this mattered more than a stale doc usually does:** a Mailgun *sandbox* domain
> delivers only to <=5 pre-authorized recipients. A rotator who "restored" the sandbox value
> named above would silently kill every customer-facing email on the platform -- and this
> runbook's own smoke test (one email to `dustinstohler1@gmail.com`, an authorized recipient)
> **would pass**. The same stale sandbox value still appears in `SUPABASE-SECRETS-SETUP.md`
> and `js/config.js`; both are cosmetic there, load-bearing here.

---

## Tier A Steps (autonomous)

- Step 1: Check Mailgun Dashboard -> Logs for recent delivery failures -- if failures are already present, diagnose before rotating
- Step 2: Verify the affected functions are currently healthy in Sentry. There are 31, not two -- derive the set with the `grep` in Step 4 rather than spot-checking the two this runbook used to name

## Tier B Steps (execute + notify Dustin)

- Step 1: Generate new API key in Mailgun, update Supabase secret, redeploy affected EFs
- Step 2: Run smoke test (send test email via EF); notify Dustin of result

## Tier C Steps (escalate)

- Step 1: If outbound email is failing in production and rollback does not restore delivery within 10 minutes, contact Mailgun support with the domain name and error details

---

## Full Rotation Procedure

### 1. Dunning-cycle timing check [!]

**Before starting:** Confirm that `process-dunning` is not mid-cycle.

`process-dunning` runs on a schedule and sends payment reminder emails. Rotating `MAILGUN_API_KEY` during an active dunning run will cause those emails to fail silently -- the EF will log an error but no retry is wired.

- Check the Supabase Edge Function logs for recent `process-dunning` invocations
- If a dunning run completed within the last 30 minutes, proceed
- If a dunning run appears to be in progress, wait for it to complete before rotating

### 2. Generate new API key in Mailgun

1. Go to **Mailgun Dashboard -> API Keys** (or Settings -> API Keys)
2. Click **Add new key**
3. Label it: `otterquote-main-YYYY-MM-DD`
4. Copy the key value -- it is shown only once

### 3. Update Supabase secrets

Go to **Supabase Dashboard -> Project Settings -> Edge Functions -> Secrets** and update:

| Secret Name | Value |
|---|---|
| `MAILGUN_API_KEY` | New Mailgun API key (`key-...`) |
| `MAILGUN_DOMAIN` | Only update if changing the sending domain; otherwise leave unchanged |

Click **Save**.

### 4. Redeploy affected Edge Functions

Supabase Edge Functions read secrets from the environment at invocation time, so a secret
change generally takes effect without a redeploy. Redeploy only if a function is observed
still using the old value.

**If you do redeploy, redeploy the affected set, not two of it.** The 31-function list is in
the Env Vars section above; derive it live rather than trusting any list, including that one:

```bash
grep -rIl "MAILGUN_API_KEY" supabase/functions | sed 's|supabase/functions/||;s|/index.ts||'
```

### 5. Smoke test -- send a test email via the EF

Invoke `send-adjuster-email` with a test payload to verify the new key is working:

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/send-adjuster-email \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "dustinstohler1@gmail.com",
    "subject": "Mailgun rotation smoke test",
    "body": "This is a post-rotation test email. If you received this, the Mailgun key rotation succeeded."
  }'
```

Expected: `{"success": true}` and an email delivered to the test address within 60 seconds.

If the EF returns a 500 or Mailgun auth error, the secret was not saved correctly or the EF was not redeployed -- initiate rollback (see below).

### 6. Revoke old key (only after smoke test passes)

1. Return to **Mailgun Dashboard -> API Keys**
2. Delete or revoke the previous key
3. Confirm it no longer appears as active

---

## Coordinated Rotation Notes

- **`process-dunning` timing:** See Step 1. Do not rotate mid-dunning-cycle. Dunning emails, adjuster notifications, and bid confirmation emails all route through Mailgun -- a failed rotation drops these silently.
- **`MAILGUN_DOMAIN` changes:** If the sending domain changes (e.g., moving from sandbox to `mail.otterquote.com`), also update the `From:` address expectations in any email templates and verify DNS records (SPF, DKIM, DMARC) are configured for the new domain before rotating.
- **Sandbox vs. production domain:** **The migration already happened.** Production sends from `mail.otterquote.com` (evidence in the `MAILGUN_DOMAIN` note above). This bullet previously read *"The current Supabase secret uses a Mailgun sandbox domain"* and was false as written; corrected 2026-08-31 (CTO, #1406). Treat any future domain change as a rotation of its own -- SPF/DKIM/DMARC verified before the secret moves.

---

## Resolution Criteria

- New Mailgun API key is active and listed in Mailgun Dashboard
- Supabase `MAILGUN_API_KEY` secret updated
- The affected-function set derived live (the `grep` above), not read from a stored list
- Smoke test: test email delivered successfully **to an address that is NOT a Mailgun
  authorized recipient** -- a sandbox misconfiguration passes a test sent to an authorized
  address, which is exactly how it would reach production unnoticed
- `MAILGUN_DOMAIN` confirmed as `mail.otterquote.com` after the change, by reading a fresh
  `activity_log.metadata.message_id`, not by reading the secret's label
- Old API key revoked in Mailgun Dashboard
- No Mailgun delivery errors in EF logs for 5 minutes post-rotation

## Auto-resolve eligible: no

Manual verification required -- Mailgun delivery failures are not always surfaced in Sentry immediately. Human sign-off on smoke test and email receipt is mandatory.

---

## Rollback

If rotation causes email delivery failures:

1. Re-add the old API key value to Supabase as `MAILGUN_API_KEY` (save it before rotation -- see Step 2 note)
2. Redeploy any function observed still using the new value (see Step 4 -- the set is 31, and a secret revert usually needs no redeploy at all)
3. Verify smoke test passes (test email delivered to a NON-authorized-recipient address)
4. Do **not** delete the old key from Mailgun until the root cause is diagnosed

> Mailgun allows multiple active API keys -- you can hold the old key active during transition for zero-downtime rotation.

---

## See Also

- `SUPABASE-SECRETS-SETUP.md` -- canonical Supabase secret names for Mailgun
- Postmortem: docusign-keypair-rotation-20260514 -- source of this runbook gap
- Task 86e1d1hk4 -- parent task for this runbook
- `runbooks/stripe-key-rotation.md` -- parallel rotation runbook (same postmortem)
