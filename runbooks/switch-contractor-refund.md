# Runbook: Switch request - contractor fee refund (by hand)

**Type:** Manual money procedure (nothing here is automated)
**Owner:** Dustin, until contractors go live (Dustin, chat with Ben, 2026-11-04, answering "Do you own that email until contractors go live?": "Yes, I own it (Recommended)"; recorded on #3355, comment 6642594524)
**Applies to:** A homeowner's request to switch contractors after a contract is signed
**Sources:** Agreement 6.4 (`contractor-agreement.html`), Terms 8.4 and 8.5 (`terms.html`), D-410 (Central time), `supabase/functions/switch-contractor/cutoff.ts`, `supabase/functions/switch-contractor/index.ts`
**Last updated:** 2026-11-04 (gh-3355)

---

## What actually happens today

- The homeowner's "switch" form (React dashboard `submitSwitchSurvey`, legacy `dashboard.html`) only calls the `send-support-email` Edge Function. It emails **dustinstohler1@gmail.com** with the subject `[Otter Quotes Support] Switch Contractor Request` and inserts one `support_tickets` row (`source = 'form'`, `status = 'open'`). Body: `Job #<8 characters>`, `Reasons: ...`, `Notes: ...`.
- It changes **no** claim, quote or Stripe state. The `switch-contractor` Edge Function (the only code that refunds a contractor's platform fee) is not called by any page, and it must not be called for a hand refund: it refunds on the call with no confirmation step and no begun-work check.
- So the refund exists only if a person issues it. That person is you. The Agreement (6.4) and the FAQ promise it.

## When this fires

An email with subject `[Otter Quotes Support] Switch Contractor Request` arrives (or an open `support_tickets` row with subject `Switch Contractor Request`).

## The rule you are applying (Agreement 6.4, D-410)

The platform fee is refunded in full to the first contractor only if **all three** hold:

1. The homeowner **requested** the switch at least three days before the scheduled start date. The event is the request, not the second contract. Days are **calendar days in Central time (`America/Chicago`)**.
2. The contractor **has not begun work**.
3. Otter Quotes **confirms** the switch (you contact the homeowner, per the support notice: "please contact them directly to confirm their next contractor placement").

If the contractor begins work before the homeowner signs with a replacement, the fee is due again (6.4).

## Step 1 - Find the claim and the winning quote (read-only)

The email carries only the job reference: the **last 8 characters of the claim id, upper-case**. The ticket's `from_email` is the homeowner's account email; the ticket's `claim_id` column is **not** filled by this form, so match on the job reference.

```sql
select c.id, c.status, c.user_id, c.property_address, c.selected_contractor_id,
       c.is_test, c.live_charge_authorized_at, c.contractor_switch_count
from claims c
where upper(right(c.id::text, 8)) = '<JOB REF FROM EMAIL>';
```

The claim should be `contract_signed` or `awarded`. If it is anything else, stop: there is nothing to refund yet; reply to the homeowner and close the ticket with a note.

Then the quote that was selected (the same row `switch-contractor` would pick):

```sql
select q.id, q.status, q.payment_status, q.payment_intent_id,
       q.scope_summary::jsonb ->> 'estimated_start_date' as estimated_start_date
from quotes q
where q.claim_id = '<claim id>'
  and q.contractor_id = '<selected_contractor_id>'
  and q.status in ('selected', 'awarded');
```

(`scope_summary` is stored as JSON text or as JSON; if the cast fails, read the value out of the column by eye. The start date is the `estimated_start_date` key.)

## Step 2 - Central-time date check

Take the moment the homeowner **sent the request**: the email's received time, or `support_tickets.created_at` (both are instants; convert to Central). Let S be `estimated_start_date`.

**Rule (mirrors `cutoff.ts`, `isWithinCutoff`):** the switch is open if the request's Central calendar date is on or before **S minus 3 days**. It closes at 00:00 Central on S minus 2. The hour of the day does not matter beyond which Central date it falls on.

```sql
select (('<request time, e.g. 2026-12-08T05:59:59Z>'::timestamptz at time zone 'America/Chicago')::date
        <= ('<S, e.g. 2026-12-10>'::date - 3)) as switch_open;
```

Worked examples, checked against this expression:

| Start date S | Request instant (UTC) | Central | Result |
|---|---|---|---|
| 2026-10-29 | 2026-10-27T04:59:59Z | 23:59:59 on 10-26 (CDT) | open |
| 2026-10-29 | 2026-10-27T05:00:00Z | 00:00:00 on 10-27 (CDT) | closed |
| 2026-12-10 | 2026-12-08T05:59:59Z | 23:59:59 on 12-07 (CST) | open |
| 2026-12-10 | 2026-12-08T06:00:00Z | 00:00:00 on 12-08 (CST) | closed |

Local clock times at the close, for the homeowner conversation: 1:00 AM Eastern on S-2, midnight Central, 11 PM Mountain and 10 PM Pacific on S-3 (D-410; Terms 8.5 and Agreement 6.4 name Central time).

- **Open:** go to Step 3.
- **Closed:** no refund under 6.4. Reply to the homeowner (the switch window has passed) and record per Step 6. A refund outside the rule is a Tier C money decision: do not issue it without a ruling.
- **No start date on the quote** (`estimated_start_date` empty or unreadable): `cutoff.ts` treats this as "allow". Ask the contractor for the scheduled start date before you decide, and note it on the ticket.

## Step 3 - Confirm whether work has begun

**No field in the database records that work has begun.** `claims` and `quotes` have no work-started column (`claims.completion_date` exists, but it records completion, not a start). So this is a question you ask, and you write the answer down:

1. Ask the **contractor** (email or phone from the contractor's profile): "Have you or your crew started any work, delivered materials, or pulled a permit on this job?" Get the answer in writing (a reply email is enough).
2. Ask the **homeowner** the same question in the confirmation contact.
3. If either says work has begun, or you cannot get a clear "no" from the contractor: **do not refund**. Note it on the ticket and take it to Ben (Tier C: money). Under 6.4 the fee stays with Otter Quotes if work began before the replacement signing.

## Step 4 - Confirm the switch with the homeowner

Contact the homeowner (the support notice asks for this directly). The homeowner stays bound to the first contract until they sign the second one (Terms 8.5), so tell them that. Do not tell them the first contract is released.

## Step 5 - Refund in the Stripe dashboard

Only when Step 2 is open **and** Step 3 is a clear no **and** Step 4 is done.

1. Choose the Stripe mode from the claim: `is_test = true` means the charge is a **test-mode** charge, look in test mode. If `live_charge_authorized_at` is also set on a test claim, the charge may be live: check live mode too. Never refund a test claim's charge with a live key by any other route.
2. In the Stripe dashboard, search for the quote's `payment_intent_id` (the `pi_...` value from Step 1). Open the payment.
3. Check the payment shows **Succeeded** and has no refund yet. If it already shows refunded, stop: the refund is done (Stripe refuses a second full refund of the same charge). Go to Step 6.
4. Choose **Refund**, refund the **full amount** (the function also refunds the whole charge), pick the reason "Requested by customer", and add a note: `homeowner_switched_contractor, claim <job ref>`.
5. Copy the refund id (`re_...`) shown after you confirm. Re-open the payment and check it now shows the refund.

Contractor-facing wording used by the function, for reference: "Your platform fee has been refunded in full and will appear in your account within 5-10 business days."

## Step 6 - Record it

Do both:

1. **Ticket:** in `support_tickets` for this request, set `status` to resolved, `resolved_at` to now, and write `resolution_notes` containing: the request time (UTC and Central), `estimated_start_date`, the date-check result, who you asked about begun work and their answer, the outcome (refunded / not refunded and why), and the Stripe refund id and date.
2. **Tell Marty** the claim job ref and refund id, in a comment on #3355 or a message to the CTO. Nothing in the repo updates the quote after a hand refund: `quotes.payment_status` stays `succeeded`, and the claim stays `contract_signed`/`awarded`. Marty files the reviewed write that marks the quote refunded and returns the claim to bidding. Do not edit those rows by hand.

## Not covered by this runbook (open points, with owners)

- **Returning the claim to open bidding and retiring the quote** are done only by `switch-contractor`, which no page calls. Until an admin path exists (Marty, #3350 follow-up), this is Marty's reviewed write per Step 6.
- **Notifying the first contractor** is also sent only by `switch-contractor`. Until then, email the contractor yourself with the outcome.
- **Card processing fee:** Agreement 6.4 says the refund excludes "any card processing fee"; the code and this runbook refund the whole charge. Ben to confirm which is intended.
- **Test accounts:** a refund on an `is_test` claim is a test-mode refund and moves no real money.

## Resolution criteria

- The ticket is resolved with the notes above, and the refund (if any) appears in Stripe against the payment, and Marty has the job ref and refund id.

## Auto-resolve eligible: no

Every step moves money or a promise to a contractor, so a person does each one.
