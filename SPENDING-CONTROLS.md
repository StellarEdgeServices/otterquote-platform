# ClaimShield Spending Controls Guide

> **Budget:** $50/month total metered costs
> **Created:** March 18, 2026 (Session 8)
> **Status:** Code-level rate limiting COMPLETE. Dashboard caps need manual setup (5 min).

---

## What's Already Done (Code Layer)

All 5 Edge Functions now include database-backed rate limiting that:
- Checks a `rate_limit_config` table before every metered API call
- Refuses to fire if hourly/daily/monthly limits or budget caps are exceeded
- **Fails closed** — if the rate limit check itself fails, the function refuses to execute
- Logs every call (allowed and blocked) to `rate_limits` table for auditing
- Returns HTTP 429 with details when rate limited

### Current Rate Limits (editable in Supabase dashboard)

| Function | Per Hour | Per Day | Per Month | Est. Cost/Call | Monthly Budget Cap |
|----------|----------|---------|-----------|---------------|-------------------|
| send-sms | 10 | 50 | 500 | $0.0079 | $4.00 |
| send-adjuster-email | 20 | 100 | 1,000 | $0.00 (plan) | $0.00 |
| create-payment-intent | 5 | 10 | 100 | $0.00 (test) | $0.00 |
| create-hover-order | 1 | 2 | 10 | $30.00 | $10.00 |
| create-docusign-envelope | 2 | 5 | 50 | $0.00 (sandbox) | $0.00 |

### Extra Protections
- **Hover duplicate check:** Won't create a new order if an active order already exists for the same address
- **Stripe amount cap:** Refuses any single payment intent over $10,000
- **Kill switch:** Set `enabled = false` in `rate_limit_config` to instantly disable any function

### To Adjust Limits (no code changes needed):
```sql
-- Example: Increase SMS daily limit to 75
UPDATE rate_limit_config SET max_per_day = 75 WHERE function_name = 'send-sms';

-- Example: Emergency kill SMS function
UPDATE rate_limit_config SET enabled = false WHERE function_name = 'send-sms';

-- Example: Check current usage
SELECT function_name,
  COUNT(*) FILTER (WHERE called_at > now() - interval '1 hour' AND NOT blocked) as last_hour,
  COUNT(*) FILTER (WHERE called_at > now() - interval '1 day' AND NOT blocked) as last_day,
  COUNT(*) FILTER (WHERE called_at > now() - interval '1 month' AND NOT blocked) as last_month,
  COUNT(*) FILTER (WHERE blocked) as blocked_total
FROM rate_limits GROUP BY function_name;
```

---

## What You Need to Do (Dashboard Layer — 5 minutes)

These are hard caps at the service provider level. Even if our code completely fails, these caps prevent runaway spending.

### 1. Twilio — Set Usage Trigger ($15/month)

1. Go to: https://console.twilio.com/us1/billing/manage-billing/billing
2. Scroll to **"Usage Triggers"** section
3. Click **"Create new trigger"**
4. Set:
   - **Friendly Name:** "ClaimShield monthly cap"
   - **Usage Category:** "Programmable SMS" (or "Total Price" for all usage)
   - **Trigger Type:** "Recurring" → "Monthly"
   - **Trigger Value:** `15.00`
   - **Callback URL:** Leave blank (or your email for notifications)
   - **Callback Method:** POST
5. Click **Save**

**Also set a lower warning trigger:**
- Same steps, but set value to `10.00` and name it "ClaimShield monthly warning"

**Note:** Twilio usage triggers send notifications but DON'T automatically stop sending. For a true hard stop, you'd need to suspend the account. The code-level rate limiting is what actually prevents runaway sends.

### 2. Mailgun — Verify Plan Limits

1. Go to: https://app.mailgun.com/settings/billing
2. Confirm you're on the **Foundation 50k plan** ($35/month after trial)
3. This plan includes 50,000 emails/month. Overages are $0.80 per 1,000.
4. At our code-level cap of 1,000 emails/month, you'll never hit the plan limit.

**Optional — Set sending limit:**
1. Go to: https://app.mailgun.com/sending/domains/mail.stellaredgeservices.com
2. Look for **"Sending Limits"** or **"Rate Limits"** in domain settings
3. If available, set daily sending limit to 200 emails/day

### 3. Stripe — Verify Test Mode

1. Go to: https://dashboard.stripe.com/test/settings
2. Confirm the toggle at the top says **"Test mode"** (orange banner)
3. **While in test mode, no real charges occur.** No spending cap needed yet.
4. **BEFORE going live:** Set up Stripe Radar rules and spending alerts at https://dashboard.stripe.com/settings/billing/alerts

### 4. Supabase — Check Plan Limits

1. Go to: https://supabase.com/dashboard/project/yeszghaspzwwstvsrioa/settings/billing
2. If on **Free tier:** Hard limits apply automatically (500MB database, 1GB storage, 2GB bandwidth)
3. If/when you upgrade to **Pro ($25/month):** Set spend caps:
   - Go to Settings → Billing → "Spend Cap"
   - Enable spend cap to prevent overages beyond the $25 base

### 5. Hover — Not Active Yet

- API credentials not created yet (app.hover.to was down)
- When you do set up Hover API, check their dashboard for:
  - Monthly order limits
  - Spending alerts
  - Sandbox/test mode

### 6. DocuSign — Sandbox Is Free

- Currently using demo sandbox (no charges)
- Production pricing TBD. When you switch to production, review per-envelope pricing.

---

## Deployment Steps (Required)

The code-level rate limiting won't work until you:

1. **Run the SQL migration** in Supabase SQL Editor:
   - Open: https://supabase.com/dashboard/project/yeszghaspzwwstvsrioa/sql
   - Paste contents of `sql/v3-rate-limits.sql`
   - Click "Run"
   - Verify: You should see `rate_limits` and `rate_limit_config` tables in the Table Editor

2. **Redeploy the 5 Edge Functions** (they have updated code with rate limiting):
   ```bash
   cd Projects/ClaimShield/Claimshield-v2
   supabase functions deploy send-sms
   supabase functions deploy send-adjuster-email
   supabase functions deploy create-payment-intent
   supabase functions deploy create-hover-order
   supabase functions deploy create-docusign-envelope
   ```

3. **Verify** by checking the Edge Function logs after a test call:
   - https://supabase.com/dashboard/project/yeszghaspzwwstvsrioa/functions

---

## Monthly Cost Projection (worst case at cap limits)

| Service | Fixed Cost | Max Metered (at caps) | Total |
|---------|-----------|----------------------|-------|
| Mailgun | $35.00 | $0.00 (within plan) | $35.00 |
| Twilio | $0.00 | $3.95 (500 SMS) | $3.95 |
| Hover | $0.00 | $300.00 (10 orders) | $300.00* |
| Stripe | $0.00 | $0.00 (test mode) | $0.00 |
| DocuSign | $0.00 | $0.00 (sandbox) | $0.00 |
| Supabase | $0.00 | $0.00 (free tier) | $0.00 |
| **Total** | **$35.00** | **$3.95** | **$38.95** |

*Hover: $300 is the theoretical max if all 10 monthly orders fire at $30 each. The $10 budget cap in the code will cut it off after ~1 order. Realistically $0-30/month.

**Realistic monthly total: ~$35-40** (Mailgun plan + occasional SMS)

---

## Emergency Procedures

### "Something is sending too many messages"
```sql
-- Kill SMS immediately
UPDATE rate_limit_config SET enabled = false WHERE function_name = 'send-sms';

-- Kill emails immediately
UPDATE rate_limit_config SET enabled = false WHERE function_name = 'send-adjuster-email';

-- Kill EVERYTHING
UPDATE rate_limit_config SET enabled = false;

-- Re-enable after investigation
UPDATE rate_limit_config SET enabled = true WHERE function_name = 'send-sms';
```

### "I want to check what's been sent"
```sql
-- See all calls in the last 24 hours
SELECT function_name, called_at, blocked, metadata
FROM rate_limits
WHERE called_at > now() - interval '1 day'
ORDER BY called_at DESC;
```

### "I want to check estimated spend"
```sql
-- Monthly spend estimate per function
SELECT
  rl.function_name,
  COUNT(*) FILTER (WHERE NOT rl.blocked) as calls_this_month,
  rc.monthly_cost_estimate,
  (COUNT(*) FILTER (WHERE NOT rl.blocked) * rc.monthly_cost_estimate)::numeric(10,2) as estimated_spend,
  rc.monthly_budget_cap
FROM rate_limits rl
JOIN rate_limit_config rc ON rl.function_name = rc.function_name
WHERE rl.called_at > now() - interval '1 month'
GROUP BY rl.function_name, rc.monthly_cost_estimate, rc.monthly_budget_cap;
```
