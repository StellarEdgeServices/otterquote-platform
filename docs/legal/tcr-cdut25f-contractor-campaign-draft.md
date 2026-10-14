# DRAFT for LEGAL-READ: TCR campaign CDUT25F, contractor flow (gh-1916 item c)

Status: DRAFT. Nothing here has been submitted to TCR or Twilio. Editing the campaign is Dustin's step in the Twilio Console, only after an independent LEGAL-READ and `R-177 SIGNED:` (comments 5915403328, 5965042505, 6069379358 on #1916). Consent wording is D-328 (comment 5673695814 on #1916) and is NOT changed by this file.

Refs #1916. Drafted by Marty, CTO (AI executive), CEO RUN 104, claim `ceo-2026-10-13T19:44:00Z`.

## 1. What is registered today (read back from the Twilio API, 2026-10-14T00:40Z)

Source: `GET https://messaging.twilio.com/v1/Services/MG01f353f28aa32a65076d7e9e41eb53ab/Compliance/Usa2p` (read-only). `campaign_id CDUT25F`, `campaign_status VERIFIED`, `us_app_to_person_usecase LOW_VOLUME`, `date_updated 2026-04-05T16:41:13Z`, `errors []`.

`description`:
> OtterQuote sends transactional notifications and account verification messages to homeowners and contractors using its insurance claim contractor bidding platform. Messages include bid alerts, claim status updates, and one-time verification codes during account creation and login.

`message_flow` (homeowner only; no contractor opt-in is described):
> End users opt-in to receive SMS messages from OtterQuote by visiting https://otterquote.com/get-started.html and completing the homeowner signup form. On the signup page, immediately below the phone number field, there is an optional SMS consent checkbox. The checkbox label reads exactly: "By providing your phone number and checking this box, you consent to receive SMS messages from OtterQuote about your project status and contractor updates. Message & data rates may apply. Reply STOP to opt out." Links to OtterQuote's Privacy Policy ... and Terms of Service ... are embedded in the consent text. Checking this box is voluntary ... Users who do not opt in receive equivalent notifications via email. Users may opt out at any time by replying STOP to any OtterQuote message.

`message_samples` (both homeowner/verification; none is a contractor message):
1. `Your OtterQuote bid from [Contractor] is ready to review. Log in: https://otterquote.com/status`
2. `Your OtterQuote verification code is: 123456`

`opt_out_message`: "You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe." `help_message`: "Reply STOP to unsubscribe. Msg&Data Rates May Apply."

Gap: the `description` already says "and contractors" while `message_flow` and both samples cover homeowners only. That is the mismatch #1916 was opened to close.

## 2. The contractor flow as built (on main, deployed)

- Surface: https://otterquote.com/contractor-join.html (the live contractor signup; `/contractor` redirects to it). Phone is a required field (`#phone`). Checkbox `#smsConsent` sits above the business fields, has no `checked` attribute, and is not required to submit.
- Consent text, D-328, version tag `contractor-v2-2026-09-15` (verbatim from the served page): "I agree to receive SMS from Otter Quotes about my contractor account and new job opportunities. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. See our Privacy Policy and Terms of Service." (both are links).
- Stored on `contractors`: `sms_opt_in` (true or NULL, never a bare false), `sms_opt_in_at`, `sms_opt_in_source = 'contractor-signup'`, `sms_consent_text_version`. IP and user agent are NOT recorded for contractor SMS consent today (see question Q3).
- Sends: `notify-contractors` (new-opportunity alerts, signed-contract notice, agreement reminder), `process-dunning` (payment-failure notices), `send-contractor-nudge` (homeowner-triggered nudge) refuse unless `sms_opt_in` is true; the nudge also requires the current text version. Inventory and gate presence are pinned by `supabase/functions/send-sms/contractor-sms-send-sites.test.ts` in this PR.

## 3. DRAFT replacement text (for the legal read)

### 3a. description (target under 4096 chars)

> Otter Quotes (https://otterquote.com) is an insurance-claim and home-improvement contractor bidding platform. This campaign sends account and project notifications to two groups who have each opted in separately: (1) homeowners, who agree to texts on the homeowner signup form, and (2) contractors, who agree to texts on the contractor signup form. Homeowner messages cover bid-ready alerts, project status and one-time verification codes. Contractor messages cover new project-opportunity alerts in the contractor's service area, contract-signed and project-ready notices, agreement-signing reminders, and payment-method notices for the contractor's account. Messages are sent only to people who checked the SMS consent box; message frequency varies. No marketing or promotional offers are sent in this campaign.

### 3b. message_flow (target under 2048 chars; keeps the homeowner flow verbatim, adds the contractor flow)

> HOMEOWNER FLOW (unchanged): [existing homeowner text quoted in section 1].
>
> CONTRACTOR FLOW: Contractors opt in at https://otterquote.com/contractor-join.html, the contractor signup page. The page collects the contractor's phone number as a required account field. Separately, an unchecked, optional checkbox appears on the form. Its label reads exactly: "I agree to receive SMS from Otter Quotes about my contractor account and new job opportunities. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. See our Privacy Policy and Terms of Service." The Privacy Policy (https://otterquote.com/privacy.html) and Terms of Service (https://otterquote.com/terms.html) are linked in the label. The box is not pre-checked and is not a condition of creating an account. Contractors who do not check it receive the same notices by email and in the dashboard and are never texted. The platform stores the opt-in, its timestamp and the consent-text version, and the sending code refuses any contractor without a stored opt-in. Contractors can opt out at any time by replying STOP to any message.

### 3c. additional contractor message_samples (the campaign allows 5; two exist, so add up to 3). All taken from live templates; brand named in each.

1. `New Otter Quotes [Roofing] opportunity in [City], [ZIP]. Log in to bid: https://otterquote.com/contractor-opportunities.html`
2. `Otter Quotes: Your contract is signed. Project package is ready - log in within 48 hrs to contact the homeowner: https://otterquote.com/contractor-dashboard.html`
3. `Otter Quotes: A homeowner wants to select you for a project in [City, ST]. Sign your agreement now to stay in the running: [link]`

## 4. LEGAL-READ checklist and open questions (Tier C, not decided here)

Q1 (use case and category). Registered use case is LOW_VOLUME and the description says "transactional". D-328 consent covers "new job opportunities", which is arguably promotional-adjacent (CEO comment 5673616027 rejected the word "transactional" for exactly this reason). The draft drops "transactional" for contractors and states no marketing is sent. Does counsel agree job-opportunity alerts to opted-in contractors fit this campaign, or should the registered use case be MIXED / re-registered? Recommended default: keep the draft, ask counsel; do not edit the use case without the read.

Q2 (message content vs consent text). `process-dunning` texts (`HOURLY_SMS`, `WARNING_SMS`, supabase/functions/process-dunning/index.ts) do not name "Otter Quotes". Carriers expect the brand in every message. Payment-failure notices are within "my contractor account". Recommended: a separate small PR adding the brand prefix, after the read.

Q3 (consent evidence). Contractor SMS consent stores timestamp, source and version, but not IP or user agent, unlike the CPA evidence pattern (#2444). A client-sent IP is spoofable (see gh2154 note); a server-side capture needs a DRAFT migration plus an edge function on the signup path. Recommended: ask counsel whether timestamp + version + source is sufficient for carriers; if not, a follow-up migration DRAFT.

Q4 (second checkbox, different wording). `contractor-pre-approval.html` (onboarding step, live) carries its own optional box `#agreeTcpaSms`: "I agree to receive transactional SMS from Otter Quotes. Message frequency varies. ... Reply STOP to unsubscribe. (Optional ...)", stored only as `contractors.sms_consent_ts`. It does not set `sms_opt_in`, so it can never cause a send (fails closed), but a contractor who ticks it believes they consented, and its wording is the rejected "transactional" label with no HELP line. It is also what a carrier auditor would find at onboarding. Recommended: remove the box, or replace it with the D-328 label writing `sms_opt_in` / version, in a follow-up PR once counsel signs the draft. NOT changed in this PR (wording is Tier C).

Q5 (existing contractors). All 15 contractors have `sms_opt_in` NULL (2026-10-14 SELECT), so none receive SMS. If counsel wants existing contractors reachable, they need a re-consent prompt in the dashboard; no such prompt exists.

Q6 (STOP handling). The sending code never writes `sms_opt_in = false` on an inbound STOP: Twilio's default STOP handling blocks sends at the carrier level, but the platform record stays true. Recommended: an inbound-webhook follow-up (no webhook exists in the repo today).

Q7 (version gate parity). `send-contractor-nudge` requires `sms_consent_text_version == contractor-v2-2026-09-15`; `notify-contractors` and `process-dunning` require only `sms_opt_in === true`. Equivalent today (one version exists); they diverge the day the text changes.

Do not paste any of this into the Twilio Console before LEGAL-READ and `R-177 SIGNED:`.
