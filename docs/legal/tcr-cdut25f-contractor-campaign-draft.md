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

- Surface: https://otterquote.com/contractor-join.html (the live contractor signup; `/contractor` redirects to it). Phone is a required field (`#phone`). Checkbox `#smsConsent` (contractor-join.html:280-281) has no `checked` attribute and is not required to submit. The same sentence is also the optional box `#agreeTcpaSms` on contractor-pre-approval.html (onboarding step 3), aligned in this PR.
- Consent text, D-328, version tag `contractor-v2-2026-09-15` (verbatim from the served page): "I agree to receive SMS from Otter Quotes about my contractor account and new job opportunities. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. See our Privacy Policy and Terms of Service." (both are links).
- Stored on `contractors`: `sms_opt_in` (true or NULL, never a bare false), `sms_opt_in_at`, `sms_opt_in_source` (`contractor-signup` or `contractor-onboarding`), `sms_consent_text_version`. IP and user agent are NOT recorded for contractor SMS consent today (Q3).
- Send gates: `notify-contractors`, `process-dunning` and `send-contractor-nudge` refuse unless `sms_opt_in` is true; the nudge also requires the current text version. Inventory and gate presence (call-site gates only, before the send, not in comments) are pinned by `supabase/functions/send-sms/contractor-sms-send-sites.test.ts`.

### The five contractor message types, bodies quoted from the code (head of this PR)

1. New job opportunity (promotional), `supabase/functions/notify-contractors/index.ts:865`: `New Otter Quotes ${tradeCap} opportunity in ${claim_city}, ${claim_zip}. Log in to bid: ${OPPORTUNITIES_URL}`
2. Contract signed, `notify-contractors/index.ts:446`: `Otter Quotes: Your contract is signed. Project package is ready — log in within 48 hrs to contact the homeowner: ${DASHBOARD_URL}`
3. Agreement reminder, `notify-contractors/index.ts:1239`: `Otter Quotes: A homeowner wants to select you for a project in ${displayLocation}. Sign your agreement now to stay in the running: ${signingLink}`
4. Homeowner-follow-up nudge, `supabase/functions/send-contractor-nudge/index.ts:180`: `Otter Quotes: Hi ${contractorName} — your homeowner ${homeownerName} (${address}) signed their contract on ${signedDate} and hasn't heard from you yet. Please reach out as soon as possible. Questions? Call (844) 875-3412.`
5. Payment-method notices, `supabase/functions/process-dunning/index.ts`:
   - hourly, `HOURLY_SMS` (:467-468): `Otter Quotes: You have a signed contract waiting for you, but your payment method has been declined. Please visit ${SETTINGS_URL} to resolve the matter.`
   - 8 AM next-business-day warning, `WARNING_SMS` (:471-477): `Otter Quotes: You have a signed contract waiting for you, but your payment method has been declined. At 10 a.m. today we will inform the client of the payment failure and give them the option to choose another contractor. If they opt to move forward with you, you will receive their information and be liable for all fees, a $250 nonpayment fee, and any attorney's fees and costs associated with collecting this amount.`
   - homeowner proceeded, `proceedSMS` (:642): `Otter Quotes: The homeowner has chosen to move forward with you. You are liable for all fees including the $250 nonpayment fee. Update payment at ${SETTINGS_URL}`
   - homeowner chose another contractor, `lostSMS` (:726): `Otter Quotes: The homeowner on your pending project has selected a different contractor due to the unresolved payment issue. Visit ${SETTINGS_URL} to update your payment method.`

Dunning cadence (process-dunning/index.ts header, lines 6-15): hourly, quiet hours 9 PM to 6 AM contractor local time, an 8 AM next-business-day warning, the homeowner is told at 10 AM, and no messages between the warning and 10 AM.

## 3. DRAFT replacement text (for the legal read)

Brand spelling: the registered campaign text says "OtterQuote", so the prose below says "OtterQuote"; every quoted consent sentence and message body is verbatim from the code and says "Otter Quotes". The mismatch is raised as Q8.

### 3a. description (1282 characters; limit 4096)

> OtterQuote (https://otterquote.com; texts are signed "Otter Quotes") is an insurance-claim contractor bidding platform. This campaign sends account and project notifications to homeowners and to contractors, each of whom opted in separately on their own signup form. Homeowner messages: bid-ready alerts, project status updates and one-time verification codes. Contractor messages, sent only to contractors who opted in, are of five types: (1) alerts about new job opportunities in the contractor's service area, which are promotional because they invite the contractor to bid for paid work; (2) a notice that a homeowner's contract is signed and the project package is ready; (3) a reminder to sign the agreement when a homeowner wants to select the contractor; (4) a nudge when a homeowner who signed has not heard from the contractor; (5) payment-method notices for the contractor's account, including a fee and nonpayment warning and the homeowner's decision. Payment-method reminders repeat hourly between 6 AM and 9 PM contractor local time until the payment issue is resolved, with a warning at 8 AM on the next business day. This campaign therefore carries mixed content (informational and promotional) under the existing Low Volume Mixed use case. Message frequency varies.

### 3b. message_flow (combined homeowner + contractor = 1824 characters of the 2048 limit, 224 to spare)

The homeowner flow stays exactly as registered (933 characters, read back live by the independent reviewer in comment 6158771558). Append one space and then:

> CONTRACTOR FLOW: Contractors opt in at https://otterquote.com/contractor-join.html (also offered at onboarding step 3, same sentence). Phone number is a required account field. Separately, an unchecked, optional checkbox reads exactly: "I agree to receive SMS from Otter Quotes about my contractor account and new job opportunities. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. See our Privacy Policy and Terms of Service." Both are linked in the label (https://otterquote.com/privacy.html, https://otterquote.com/terms.html). The box is not a condition of creating an account. The platform stores the opt-in, its timestamp, source and consent-text version, and the sending code refuses any contractor without a stored opt-in. Contractors who do not opt in get notices by email and in the dashboard. Reply STOP to any message to opt out.

Length source: the contractor block is 890 characters by `len()` on this exact text in the script that wrote this file; 933 + 1 + 890 = 1824.

### 3c. message_samples (the campaign allows 5; two exist, so add up to 3; brand named in each)

1. `New Otter Quotes [Roofing] opportunity in [City], [ZIP]. Log in to bid: https://otterquote.com/contractor-opportunities.html Reply STOP to opt out.`
2. `Otter Quotes: Your contract is signed. Project package is ready - log in within 48 hrs to contact the homeowner: https://otterquote.com/contractor-dashboard.html`
3. `Otter Quotes: A homeowner wants to select you for a project in [City, ST]. Sign your agreement now to stay in the running: [link]`

Sample 1 carries STOP language, as carrier vetters look for it. The live body at notify-contractors/index.ts:865 does NOT currently end with "Reply STOP to opt out." (Q9): either add that suffix to the template in a follow-up PR before the campaign update, or use sample 2 and 3 only. Do not submit sample 1 as written until one of those is chosen.

## 4. LEGAL-READ checklist and open questions (Tier C, not decided here)

Q1 (use case, resolved in this draft per CEO point 1). Job-opportunity alerts are described as promotional (mixed) content and carried under the existing `LOW_VOLUME` campaign. No MIXED alternative is offered: per the independent reviewer (6158771558, defect 3) Twilio's `MIXED` is a Standard-brand use case and moving to it means re-registering the brand. The registered use case is NOT edited.

Q2 (sender name in dunning texts, fixed in this PR). `HOURLY_SMS` and `WARNING_SMS` now begin "Otter Quotes: " (process-dunning/index.ts:467, :471), pinned by `process-dunning/sms-sender-id.test.ts`.

Q3 (consent evidence). Timestamp, source and version are stored, not IP or user agent. Recommended: ask counsel whether that is sufficient for carriers; if not, a DRAFT migration plus a server-side capture on the signup path.

Q4 (second checkbox, resolved). `#agreeTcpaSms` on contractor-pre-approval.html now carries the D-328 sentence and writes `sms_opt_in`, `sms_opt_in_at`, `sms_opt_in_source = 'contractor-onboarding'` and `sms_consent_text_version`; unchecked writes nothing and cannot erase an opt-in captured at signup. Pinned by `tests/gh1916-pre-approval-sms-consent.mjs`. Effect to note: a ticked box now really is an opt-in (previously it could never cause a send).

Q5 (existing contractors). All 15 contractors have `sms_opt_in` NULL (2026-10-14 SELECT), so none receive SMS. A re-consent prompt would be a product choice for Dustin.

Q6 (STOP handling). No inbound webhook; the platform record stays true after a STOP while Twilio blocks the handset. Recommended follow-up: inbound webhook writing per-number opt-out.

Q7 (version gate parity). `send-contractor-nudge` requires the current text version; `notify-contractors` and `process-dunning` require only `sms_opt_in === true`. Equivalent today.

Q8 (brand spelling). Registered text and homeowner samples say "OtterQuote"; the D-328 consent sentence and every contractor body say "Otter Quotes". This draft keeps both verbatim. Counsel to say whether to align the registered prose on one spelling.

Q9 (STOP suffix on sample 1). See 3c.

DUSTIN'S TWO CHOICES (not made here; on his board): (a) texts go only to the phone that consented (recommended) or consent wording is added at the settings "add phone" field for `notification_phones` (today the gate is per contractor, not per number, so `message_flow` above says "contractors who opted in", not "this number opted in"); (b) the privacy.html mobile/SMS-data clause and a short SMS terms section (his wording).

Do not paste any of this into the Twilio Console before a fresh LEGAL-READ, `R-177 SIGNED:`, and Dustin's two answers.
