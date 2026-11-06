# Runbook: Switch request - contractor fee refund (by hand)

**Type:** Manual money procedure (nothing here is automated)
**Owner:** Dustin, until contractors go live (Dustin, chat with Ben, 2026-11-04, answering "Do you own that email until contractors go live?": "Yes, I own it (Recommended)"; recorded on #3355, comment 6642594524)
**Applies to:** A homeowner's request to switch contractors after a contract is signed
**Sources:** Agreement 6.4 (`contractor-agreement.html`), Terms 8.4 and 8.5 (`terms.html`), D-410 (Central time), `supabase/functions/switch-contractor/cutoff.ts`, `supabase/functions/switch-contractor/index.ts`, `supabase/functions/_shared/stripe-key-select.ts`, `supabase/functions/process-dunning/retry-pass.ts`
**Last updated:** 2026-11-05 (gh-3355, revised after REVIEW 6643087597 and QUESTION 6643116510 on PR #3399, then for the "Fee only" ruling on #3403 and PR #3450)

**Who decides what.** You (Dustin) are the reader and the owner. Anything this runbook calls a "Tier C decision" (money, a contract term, a case 6.4 does not settle) is yours to decide. Ben and Marty can give a recommendation, but they do not rule on it for you.

**Where the SQL runs.** Every query below is a `select`. Run them in the Supabase dashboard SQL editor for the production project, signed in as the owner. Do not run anything else there while following this runbook except the one `update` in Step 6, and never edit `claims` or `quotes` rows by hand.

---

## What actually happens today

- The homeowner's "switch" form (React dashboard `submitSwitchSurvey`, legacy `dashboard.html`) only calls the `send-support-email` Edge Function. It emails **dustinstohler1@gmail.com** with the subject `[Otter Quotes Support] Switch Contractor Request` and inserts one `support_tickets` row (`source = 'form'`, `status = 'open'`). Body: `Job #<8 characters>`, `Reasons: ...`, `Notes: ...`.
- The form is **public**. The function stores `from_email` and the message exactly as typed. Nothing proves the sender owns the job reference they typed (Step 1 checks this).
- It changes **no** claim, quote or Stripe state. The `switch-contractor` Edge Function (the only code that refunds a contractor's platform fee) is not called by any page, and it must not be called for a hand refund: it refunds on the call with no confirmation step and no begun-work check, and, until PR #3450 is merged and deployed, it refunds the whole charge (#3450 changes it to refund the platform fee only). The amount to refund by hand is in Step 5.
- So the refund exists only if a person issues it. That person is you. The Agreement (6.4) and the FAQ promise it.

## When this fires

An email with subject `[Otter Quotes Support] Switch Contractor Request` arrives (or an open `support_tickets` row with subject `Switch Contractor Request`).

## The rule you are applying (Agreement 6.4, D-410)

Agreement 6.4, as approved (quoted so you can read exactly what it says):

> If a Homeowner requests a switch of contractors through the Platform at least three (3) days before the scheduled start date (days are counted in Central Time) and before Contractor has begun work, and Otter Quotes confirms the switch, Otter Quotes will refund Contractor's Platform Fee for that Job in full, excluding any card processing fee, and the project returns to open bidding. As a condition of participating on the Platform, Contractor agrees that if the Homeowner signs a contract with a replacement Otter Quotes contractor before Contractor has begun work, Contractor releases the Homeowner from the Contract with Contractor, effective on that signing, and will return any deposit the Homeowner paid. [...] If Contractor begins work under the Contract before any such signing, the Platform Fee is due again and Otter Quotes may charge it to Contractor's payment method on file. If a project is otherwise canceled after contract execution, fee refund eligibility shall be determined on a case-by-case basis by Otter Quotes.

The platform fee is refunded to the first contractor only if **all three** hold:

1. The homeowner **requested** the switch at least three days before the scheduled start date. The event is the request, not the second contract. Days are **calendar days in Central time (`America/Chicago`)**.
2. The contractor **has not begun work**.
3. Otter Quotes **confirms** the switch (you contact the homeowner, per the support notice: "please contact them directly to confirm their next contractor placement").

6.4 does **not** define "begun work", and it does not say what a contractor's silence means. Step 3 does not guess at either.

## Step 1 - Find the ticket, the claim, the owner check, the winning quote and the contacts (read-only)

The email carries only the job reference: the **last 8 characters of the claim id, upper-case**. The ticket's `claim_id` column is **not** filled by this form, so match on the job reference.

**1a. The ticket.** (This is also where you get the request time for Step 2.)

```sql
select t.id, t.created_at, t.status, t.from_email, t.user_id, t.subject, left(t.body, 200) as body_start
from support_tickets t
where t.subject = 'Switch Contractor Request'
  and t.body like '%Job #<JOB REF FROM EMAIL>%'
order by t.created_at asc;
```

- **Zero rows:** the ticket insert can fail while the email still goes out (the function logs the failure and carries on). Use the email's time for Step 2, as an instant with an explicit offset (see Step 2).
- **More than one row:** the homeowner sent it more than once. The request that counts is the first. Use the earliest `created_at`, and write on the ticket that there were several. If the first and a later one fall on opposite sides of the cutoff, stop: that is a Tier C decision for you.
- Keep the ticket `id`. Step 6 needs it.

**1b. The claim, and who owns it.**

```sql
select c.id, c.status, c.user_id, c.selected_contractor_id, c.is_test,
       c.live_charge_authorized_at, c.contractor_switch_count,
       p.email as account_email, p.phone as account_phone, p.full_name as account_name
from claims c
left join profiles p on p.id = c.user_id
where upper(right(c.id::text, 8)) = '<JOB REF FROM EMAIL>';
```

- **Stop unless exactly one row comes back.** Zero rows: the reference was mistyped or is not a claim; reply to the sender and write it on the ticket. More than one row: two claims share the last 8 characters; stop, identify the right one by `property_address` or with the homeowner, and note it.
- **Owner check.** Compare the ticket's `from_email` with `account_email`, ignoring case. **If they differ, or `account_email` is empty, stop.** Do not act on the Reply-To address or on anything in the message. Contact the address in `account_email`, say a switch request came in for their job, and ask whether they sent it. `from_email` and `support_tickets.user_id` come from a public form and prove nothing. (`user_id` is optional and caller-supplied.)
- **Claim status.** The claim should be `contract_signed` or `awarded`.
  - An earlier status (for example `bidding`): there is no signed contract to switch away from. Nothing to refund. Reply to the homeowner and note the ticket.
  - A later status (for example `completed`): this is not a switch within 6.4. Do not refund. Note the ticket; if the homeowner pushes back, that is a Tier C decision for you.
- **`selected_contractor_id` empty:** stop; there is no first contractor to refund. Tell Marty.

**1c. The winning quote** (the same rows `switch-contractor` considers: a live `selected`/`awarded` quote, or one that function already retired for a switch).

```sql
select q.id, q.created_at, q.status, q.bid_status, q.cancellation_reason,
       q.payment_status, q.payment_method_type, q.payment_intent_id,
       q.fee_amount, q.card_fee_cents,
       q.scope_summary::jsonb ->> 'estimated_start_date' as estimated_start_date
from quotes q
where q.claim_id = '<claim id>'
  and q.contractor_id = '<selected_contractor_id>'
  and (q.status in ('selected', 'awarded')
       or (q.status = 'declined' and q.bid_status = 'superseded'
           and q.cancellation_reason = 'homeowner_switched_contractor'))
order by q.created_at desc;
```

- **Stop unless exactly one row comes back.** Zero rows: no winning quote; tell Marty. More than one: the one-selected-bid index covers only `selected` plus `active`, so two rows are possible; stop and tell Marty which rows you see.
- **If the row is already retired** (`declined`, `superseded`, `homeowner_switched_contractor`): the switch was already processed. Stop; check Step 5's "already refunded" branch only to confirm the state, and go to Step 6.
- `scope_summary` is stored as JSON text or as JSON; if the cast fails, read the `estimated_start_date` key out of the column by eye.
- The refund amount in Step 5 is read from the payment's `metadata.platform_fee_cents` in Stripe (cents). `fee_amount` and `card_fee_cents` here are for cross-checking only; their units are unverified, so do not refund from them.

**1d. The contractor's contact details.**

```sql
select ct.company_name, ct.contact_name, ct.email, ct.phone
from contractors ct
where ct.id = '<selected_contractor_id>';
```

The homeowner's contact details are `account_email`, `account_phone` and `account_name` from 1b. Contact the homeowner at the address on file, not at the Reply-To.

## Step 2 - Central-time date check

Take the moment the homeowner **sent the request**, as an exact instant. Let S be `estimated_start_date`.

**The instant must carry its zone.** Use `support_tickets.created_at` straight from the table (Step 1a); it is a `timestamptz`, so the database handles the zone for you. Only if there is no ticket row, take the email's received time, and it must be written **in UTC with a trailing `Z`, or with an explicit offset** (for example `2026-12-08T05:59:59Z` or `2026-12-07T23:59:59-06:00`). **A time with no offset is not allowed.** Gmail shows your local time, not UTC: open "Show original" and read the `Date:` header with its offset, or use the ticket row. A Central time pasted without an offset into a UTC session gives the wrong answer: S = 2026-12-10, a request at 01:00 Central on 12-08 comes out "open" when the correct answer is "closed" (found by the reviewer on this runbook).

**S must be a plain date, `YYYY-MM-DD`.** Anything else (a timestamp, free text, a different format) is **unreadable** for this runbook; treat it as the "no start date" case below. (`cutoff.ts` reads a timestamp in Central time, which can differ from taking the date part, so do not guess.)

**Rule (mirrors `cutoff.ts`, `isWithinCutoff`):** the switch is open if the request's Central calendar date is on or before **S minus 3 days**. It closes at 00:00 Central on S minus 2. The hour of the day does not matter beyond which Central date it falls on.

From the ticket row:

```sql
select t.created_at at time zone 'UTC' as request_utc,
       (t.created_at at time zone 'America/Chicago')::date as request_central_date,
       ('<S, e.g. 2026-12-10>'::date - 3) as last_open_day,
       ((t.created_at at time zone 'America/Chicago')::date <= ('<S>'::date - 3)) as switch_open
from support_tickets t
where t.id = '<ticket id>';
```

If `request_utc` shows an offset or looks odd, stop and recheck the ticket row. From an email time, only as the fallback (the quoted instant must carry `Z` or an offset):

```sql
select (('<request instant with Z or offset, e.g. 2026-12-08T05:59:59Z>'::timestamptz at time zone 'America/Chicago')::date
        <= ('<S, e.g. 2026-12-10>'::date - 3)) as switch_open;
```

Worked examples, checked against the second expression:

| Start date S | Request instant (UTC) | Central | Result |
|---|---|---|---|
| 2026-10-29 | 2026-10-27T04:59:59Z | 23:59:59 on 10-26 (CDT) | open |
| 2026-10-29 | 2026-10-27T05:00:00Z | 00:00:00 on 10-27 (CDT) | closed |
| 2026-12-10 | 2026-12-08T05:59:59Z | 23:59:59 on 12-07 (CST) | open |
| 2026-12-10 | 2026-12-08T06:00:00Z | 00:00:00 on 12-08 (CST) | closed |

Local clock times at the close, for the homeowner conversation: 1:00 AM Eastern on S-2, midnight Central, 11 PM Mountain and 10 PM Pacific on S-3. These follow from D-410. Terms 8.5 and Agreement 6.4 both say "days are counted in Central Time" (PR #3400, merged 2026-11-05 at `7ab15ffe`).

- **Open:** go to Step 3.
- **Closed:** no switch refund under 6.4. Reply to the homeowner (the switch window has passed) and record per Step 6. 6.4 separately allows a refund as required by law or for documented platform error, and makes a project otherwise canceled after contract execution case-by-case. Any refund outside the switch rule is a Tier C money decision for you: do not issue it without making that decision on the record.
- **No start date on the quote, or an unreadable one:** `cutoff.ts` treats an absent date as "allow". Ask the contractor for the scheduled start date, in writing, before you decide, and note it on the ticket. If you cannot get one, hold (do not refund) and decide it yourself as a Tier C call.

## Step 3 - Confirm whether work has begun

**No field in the database records that work has begun.** `claims` and `quotes` have no work-started column (`claims.completion_date` exists, but it records completion, not a start). So this is a question you ask, and you write the answers down.

6.4 conditions the refund on the contractor not having "begun work" and does not define that phrase. The 6.4 text above is all there is; this runbook does not supply a definition. So ask three separate questions and record each answer separately:

1. **Work:** "Have you or your crew started any work on this job?" (on site, or off site for this job)
2. **Materials:** "Have materials for this job been ordered or delivered?"
3. **Permit:** "Has a permit been pulled for this job?"

Ask the **contractor** (details from Step 1d) and get the answers in writing (a reply email is enough). Ask the **homeowner** the same three questions in the confirmation contact (Step 4). Write who said what, when, and how, on the ticket.

Then:

- **Both say no to all three:** go on to Step 4.
- **Both agree work has begun:** under 6.4 there is no switch refund. Record it. Do not refund it as a switch. (The fee stays with Otter Quotes unless you decide otherwise under 6.4's other paths; see "Closed" in Step 2.)
- **The two disagree about whether work has begun:** hold. Do not refund. This is a question of fact between the parties and a Tier C decision for you.
- **Materials or a permit only, no work:** 6.4 does not say whether that counts as "begun work". Do not treat it as begun work and do not treat it as clear. Record exactly what each side said, hold the refund, and decide it yourself (Tier C). If you decide it counts, say so on the ticket; the same question will come back on every switch, so consider asking for a D-number.
- **Contractor silent:** 6.4 does not make the refund depend on the contractor replying, and it does not say that silence means work has begun, or that it does not. Do not treat silence as "no refund" and do not treat it as "no work". Record each attempt (date, channel, wording), keep the refund held, and decide it yourself (Tier C): whether silence after a stated number of attempts and days can be treated as "no work" is not settled anywhere I could find.
- **Homeowner says work has begun and the contractor says no, or does not answer:** hold, as for a disagreement.

Under 6.4, if the contractor begins work after the refund but before the homeowner signs with a replacement, the fee is due again (see "Fee falling due again" below).

## Step 4 - Confirm the switch with the homeowner

Contact the homeowner at the address on file (`account_email`, Step 1b). The homeowner stays bound to the first contract until they sign the second one (Terms 8.5), so tell them that. Do not tell them the first contract is released.

**Deposit.** Under 6.4, once the homeowner signs with a replacement before the first contractor has begun work, the first contractor "will return any deposit the Homeowner paid". Ask the homeowner whether they paid a deposit, to whom and how much, and write that on the ticket. Nothing in the platform records a deposit or its return, and nothing in this runbook collects it: the return is the contractor's obligation to the homeowner under the Agreement. Whether Otter Quotes follows up after the replacement signing is not in the Agreement; it is your call (see the open points).

## Step 5 - Refund in the Stripe dashboard

**Ruled on #3403 (Dustin, 2026-11-05, "Fee only (Recommended)", comment 6664114820): the by-hand refund is the platform fee only, never the card processing fee.** On a card payment of $180.54 the refund is $175.00. A bank-transfer payment has no card fee, so the refund equals the whole charge. Read the fee from `metadata.platform_fee_cents`.

Agreement 6.4 refunds the fee "in full, excluding any card processing fee", and the ruling follows it. PR #3450 changes `switch-contractor` to send `amount` = `metadata.platform_fee_cents` instead of refunding the whole charge, and changes `contractor-faq.html:320` to the 6.4 wording. Until it is live, the function would refund the whole charge on a card payment, which is another reason not to call it for a hand refund. The card fee uses the `create-payment-intent` formula, 2.9% + $0.30.

Here the fee is $175.00, the card charge is $180.54, and the card fee is $5.54. These are the reviewer's example figures, not a real payment; read the real fee from the payment (`metadata.platform_fee_cents`; `metadata.card_fee_cents` shows the card fee on a card payment).

A refund in Stripe cannot be taken back. A short refund can be topped up later; an over-refund cannot be recovered. A bank-transfer (ACH) charge carries no surcharge (Agreement: "ACH transfers incur no additional processing fee"), so on a bank payment the fee and the charge are the same amount and the refund equals the whole charge.

Only when Step 2 is open **and** Step 3 is a clear no **and** Step 4 is done:

**5.1 Check the payment state first.** Use the quote's `payment_status` and `payment_intent_id` from Step 1c. Do not refund unless it reads `succeeded` with a `payment_intent_id`. For every other state, stop and follow this table. A stopped case stays live: `quotes.payment_status` and the claim status do not change until Marty's reviewed write.

| `payment_status` / `payment_intent_id` | What it means | What to do |
|---|---|---|
| `succeeded`, with `payment_intent_id` | The fee was paid | Go to 5.2 |
| `payment_intent_id` empty, any status | No charge to refund | Stop. Do not assume nothing will be charged later. Tell Marty and note the ticket. |
| `no_method` | Contract signed but the contractor had no card or bank account on file, so nothing was billed | Stop. Nothing to refund. Tell Marty: the fee is unbilled and the quote should be retired by a reviewed write. |
| `pending` | A payment is in flight (for example a bank transfer not yet settled) | Stop. Money is in motion and the charge cannot be refunded as `succeeded`. Hold the refund, wait for it to settle or fail, and tell Marty. |
| `dunning` | The charge was attempted, failed, and the payment is in the dunning (retry) process | Stop. There is **nothing to refund**, and a bigger problem: `PAYMENT_HOLD_STATUSES` in `process-dunning/retry-pass.ts` does not include `dunning`, and the claim stays `contract_signed`, so reminders and retries can keep running and **could charge the contractor after a confirmed switch**. Tell Marty at once; Marty stops dunning with a reviewed write (retiring the quote and closing the dunning rows). Do not edit them by hand. The reviewer did not trace the retry pass's other gates, and neither has this runbook. |
| `failed` | The charge was declined and no money moved | Stop. Nothing to refund. Tell Marty so the quote and any dunning rows are closed. |
| `refunded` | Already refunded | Stop; go to Step 6. |
| Anything else | Not a state this runbook knows | Stop and tell Marty. |

**5.2 Choose the Stripe mode from the claim** (`is_test` and `live_charge_authorized_at` from Step 1b; the rule is in `_shared/stripe-key-select.ts`, `selectRefundKey`):

- **`is_test = false`: look in live mode.** A real claim's charge is live.
- **`is_test = true` and `live_charge_authorized_at` empty: look in test mode.** The charge is a test-mode charge and a refund moves no real money.
- **`is_test = true` and `live_charge_authorized_at` set: the claim may hold a LIVE charge.** The marker over-approximates (it does not prove a live charge was made), and the platform refuses to refund such a charge automatically. By the rule in `stripe-key-select.ts` it is refunded **only by hand, with Dustin's word** (Tier C). Look the payment up by its `pi_...` in test mode and then in live mode; it exists in only one. If it is in live mode, it is real money: write on the ticket that you decided to refund it and why, before you do. If it is in test mode, proceed as a test refund. Never issue a refund in a mode other than the one the payment is found in.

**5.3 Open the payment.** In the Stripe dashboard, in that mode, search for the quote's `payment_intent_id` (the `pi_...` value from Step 1c) and open the payment. Check it shows **Succeeded** and has no refund yet. If it already shows refunded, stop: the refund is done. Go to Step 6.

**5.4 Set the amount.** The refund is the platform fee only (`metadata.platform_fee_cents`, in cents: $175.00 is 17500), never the card processing fee. On a card payment (`payment_method_type` is a card, or the payment has `metadata.card_fee_cents`) that is less than the charge. On a bank payment the fee equals the charge, so the amount is the full charge. **If `metadata.platform_fee_cents` is missing or empty, stop: do not refund the whole charge. Tell Marty.**

**5.5 Refund.** Choose **Refund**, enter the amount from 5.4, pick the reason "Requested by customer", and add a note: `homeowner_switched_contractor, claim <job ref>`.

**5.6 Record the refund id.** Copy the refund id (`re_...`) shown after you confirm. Re-open the payment and check it now shows the refund, and for what amount.

Contractor-facing wording used by the function, for reference. Card payment, with that charge's amounts: "We refunded your $175.00 platform fee. The remaining $5.54 processing fee is not refundable. The refund will appear in your account within 5–10 business days." Bank payment: the same without the middle sentence. Use the same wording for a refund by hand. Do not say "refunded in full".

## Step 6 - Record it

Do both:

1. **Ticket:** set `status` to resolved, `resolved_at` to now, and write `resolution_notes`, for the ticket id from Step 1a. In the Supabase SQL editor:

   ```sql
   update support_tickets
   set status = 'resolved', resolved_at = now(), resolution_notes = '<notes>'
   where id = '<ticket id>';
   ```

   Check first what `status` values the table already uses (`select distinct status from support_tickets;`) and use the matching resolved value. If the case is **held** (Step 3, Step 5 stop, or a Tier C decision still open), leave the ticket `open` and put the reason in `resolution_notes` instead. The notes contain: the request time (UTC and Central), `estimated_start_date`, the date-check result, whether `from_email` matched the account email, who you asked about begun work and each answer (work, materials, permit), the deposit answer, the outcome (refunded / not refunded / held, and why), the amount refunded (the platform fee only, per the #3403 ruling), and the Stripe refund id and date.
2. **Tell Marty** the claim job ref and refund id (or the stop reason), in a comment on #3355 or a message to the CTO. Nothing in the repo updates the quote after a hand refund: `quotes.payment_status` stays `succeeded`, and the claim stays `contract_signed`/`awarded`. Marty files the reviewed write that marks the quote refunded and returns the claim to bidding. Do not edit those rows by hand.

## Not covered by this runbook (open points, with owners)

- **Code and FAQ follow-up for the "Fee only" ruling.** The amount is ruled (Dustin, #3403, comment 6664114820). The `switch-contractor` change (refund `metadata.platform_fee_cents`; the contractor email names the amounts) and `contractor-faq.html:320` are in PR #3450. Until it is merged and deployed, the function and the FAQ line do not match the ruling. Owner: Marty.
- **Fee falling due again.** 6.4 says that if the contractor begins work before the homeowner signs with a replacement, the fee is due again and Otter Quotes may charge it to the payment method on file. Nothing watches for this after a hand refund and no step charges it. A new charge is a money decision (Tier C) that needs its own reviewed path. Who watches, and for how long, is not assigned: Dustin to decide.
- **Deposit return.** The Agreement obliges the contractor to return any deposit once the homeowner signs with a replacement. Nothing records or enforces it. Whether Otter Quotes follows up is not in the Agreement; Dustin's call.
- **"Begun work".** 6.4 does not define it, and does not say what a contractor's silence means. Step 3 records the facts and holds; each such case is a Tier C decision for Dustin until a D-number settles it.
- **Returning the claim to open bidding and retiring the quote** are done only by `switch-contractor`, which no page calls. Until an admin path exists (Marty, #3350 follow-up), this is Marty's reviewed write per Step 6.
- **Notifying the first contractor** is also sent only by `switch-contractor`. Until then, email the contractor yourself with the outcome.
- **Stopping dunning on a `dunning` quote** has no hand path. Marty files the reviewed write.

## Resolution criteria

- The ticket is resolved (or held with the reason written down), with the notes above; the refund (if any) appears in Stripe against the payment for the platform fee amount (`metadata.platform_fee_cents`); and Marty has the job ref and refund id.

## Auto-resolve eligible: no

Every step moves money or a promise to a contractor, so a person does each one.
