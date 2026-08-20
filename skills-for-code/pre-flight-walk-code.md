---
name: pre-flight-walk-code
description: "Claude Code-native autonomous E2E launch-readiness walk for OtterQuote. Exercises the full contractor-to-contract-signing path: signup → 3-artifact pre-approval (D-210) → bid submission with fee acceptance (D-215 L1) → confirmation email (D-215 L2) → homeowner intake → bid accept → DocuSign envelope (D-186 dual-party initials) → contractor + homeowner signing → Stripe payment → invoice activity_log (D-215 L3). Verifies every stage via Chrome MCP + Supabase + Gmail + Stripe + DocuSign REST. Stage-by-stage pass/fail with concrete diff/error per failure. Trigger phrases: 'run pre-flight-walk', 'pre-flight walk', 'preflight walk', 'launch-readiness walk', 'E2E walk', 'walk the platform', 'autonomous E2E'. Invoke before any D-225 ship-decide, after changes to docusign-webhook / create-docusign-envelope / send-bid-confirmation / create-invoice / rescind-bid / contractor-bid-form / contract-signing flows, and as the final gate before promoting to prod."
version: "1.3"
tier: A
sentinel: pre-flight-walk-code-v1.3-2026-05-18
owner: "StellarEdge"
skill: "pre-flight-walk-code"
updated: "2026-05-26"
---

<!-- Claude Code port of pre-flight-walk-SKILL.md v1.3 (2026-05-17 / sentinel:pre-flight-walk-v1.3-halt-protocol) -->
<!-- Adaptations: Path constants added; python3→python; MCP tool names made explicit; bash tmp dir protocol; handoff file protocol; connector MCP IDs documented -->

# Pre-Flight Walk (Claude Code)

Autonomous end-to-end launch-readiness gate for OtterQuote. This skill is the canary walk: it exercises the full contractor-to-contract-signing path with a real contractor record, real DocuSign envelope, real Stripe charge, and real Mailgun emails — then verifies every persistence, every email, every payment, and every PDF artifact landed correctly. Stage-by-stage pass/fail. Fails noisy and early.

**Tier: A** (auto-trigger and on-demand). Master lives at `Claude Downloads/Skills Output/pre-flight-walk-code-SKILL.md`.

**Trigger phrases:** `run pre-flight-walk`, `pre-flight walk`, `preflight walk`, `launch-readiness walk`, `E2E walk`, `walk the platform`, `autonomous E2E`.

---

## Path Constants

```python
from pathlib import Path
import os, datetime, time

WORKSPACE = Path(r"Claude Downloads")  # workspace root — portable relative reference (see Claude's Memories/Skills/bridge/SKILL.md § 2 "Memory path convention")
HANDOFFS_DIR = WORKSPACE / "handoffs"
HANDOFFS_DIR.mkdir(exist_ok=True)

# Per-run working dir in /tmp (Linux sandbox)
TS = int(time.time())
RUN_ID = f"pfw-{TS}"
TMP_RUN_DIR = Path(f"/tmp/{RUN_ID}")
TMP_RUN_DIR.mkdir(parents=True, exist_ok=True)
```

---

## Required Connectors (Claude Code MCP IDs)

| Connector | Purpose | MCP Tool Prefix |
|-----------|---------|-----------------|
| Claude in Chrome | Browser automation | `mcp__Claude_in_Chrome__` |
| Supabase | execute_sql, get_logs | `mcp__dd6eed43-ceb7-4e5d-8818-e709abd589d2__` |
| Gmail | search_threads, get_thread | `mcp__c80ede65-ba2f-483c-bdfc-cc6848096f81__` |
| Stripe | list_customers, retrieve_payment_intent | `mcp__6451a33c-3d36-49d8-8b0d-42998d328ae5__` |
| DocuSign | REST via bash curl | N/A (bash) |
| ClickUp | Halt protocol task creation | `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__` |

If any required connector is missing, surface the gap to Dustin and abort.

**Tool names to use:**
- `mcp__Claude_in_Chrome__navigate` — page navigation
- `mcp__Claude_in_Chrome__javascript_tool` — inject JS into page
- `mcp__Claude_in_Chrome__find` — locate DOM elements
- `mcp__Claude_in_Chrome__form_input` — fill form fields
- `mcp__Claude_in_Chrome__get_page_text` — read page content
- `mcp__dd6eed43-ceb7-4e5d-8818-e709abd589d2__execute_sql` — all Supabase queries (project_id: `yeszghaspzwwstvsrioa`)
- `mcp__c80ede65-ba2f-483c-bdfc-cc6848096f81__search_threads` + `get_thread` — Gmail reads
- `mcp__6451a33c-3d36-49d8-8b0d-42998d328ae5__list_customers` + `fetch_stripe_resources` — Stripe reads
- `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_create_task` — halt protocol task creation

---

## CLI Argument: `--pr <number>` (D-232 impl 3/6)

By default, the walk runs against production (`https://otterquote.com`). Under D-232, the walk may be targeted at a Netlify PR preview deploy instead:

**Usage:** append `--pr <pr-number>` to any trigger phrase. Example: `run pre-flight-walk --pr 48`

**URL resolution at startup (before Stage 1):**

If `--pr <N>` is provided:
1. Query Netlify API for the site's recent deploys via bash:
   ```bash
   curl -s "https://api.netlify.com/api/v1/sites/6748a414-1baa-4309-a5f9-f3a7f45e3d94/deploys?per_page=30" \
     -H "Authorization: Bearer $NETLIFY_TOKEN" \
     | python -c "
   import sys, json
   deploys = json.load(sys.stdin)
   pr_num = int(sys.argv[1]) if len(sys.argv) > 1 else None
   for d in deploys:
       if d.get('review_id') == pr_num and d.get('state') == 'ready':
           print(d['deploy_ssl_url'])
           break
   " "$N"
   ```
   NETLIFY_TOKEN = `[NETLIFY-PAT REDACTED 2026-08-17 — value scrubbed per gh-446/gh-874; live token revoked via Auto-Drive item 4; canonical storage: Doppler]`
2. Filter for `review_id == <N>` AND `state == "ready"`. Take first match's `deploy_ssl_url`.
3. If no `state=ready` deploy found: STOP — "No ready Netlify preview for PR #N. Check Netlify build status or use a different PR."
4. Set `BASE_URL = <deploy_ssl_url>`. All subsequent stage URLs use `BASE_URL` in place of `https://otterquote.com`.
5. Log resolved URL at top of result block: `Target: PR #N preview (BASE_URL)`.

If `--pr` is NOT provided:
- `BASE_URL = https://otterquote.com`

**Backward compatibility:** All existing trigger phrases without `--pr` behave exactly as before.

---

## When to Invoke

- **Before every D-225 ship-decide.** This is the canonical Friday-vs-Monday gate.
- **After any change to the contract-signing path:** `docusign-webhook`, `create-docusign-envelope`, `send-bid-confirmation`, `create-invoice`, `rescind-bid`, `contractor-bid-form.html`, `contract-signing.html`, `bids.html`, `contractor-pre-approval.html`.
- **After any payment-path change:** `create-payment-intent`, `process-dunning`, payment_status state machine.
- **After any DocuSign anchor change:** Exhibit A renderer, dual-party initials placement (D-186), contractor template validator (D-199).
- **As the final pre-revenue gate** before flipping any platform_settings flag that touches launch state.

---

## Pre-Flight Constraints (READ FIRST)

1. **DocuSign envelope budget is the binding constraint.** Each full walk burns exactly **1 envelope**. Pre-walk, check `check-docusign-usage` EF for `envelopesUsed` against the 40/month limit. **Refuse to run if remaining budget < 5.**
2. **One walk per invocation.** Do NOT loop on failure. If a stage fails, dump diagnostics and stop. Never burn another envelope to "retry around" a bug.
3. **Tier 3 deploy gate.** This skill is read-only against production data — it CREATES test records but never modifies real customer records. If at any stage you'd need to modify production user data, STOP and surface to Dustin.
4. **Real Stripe charge.** This walk fires a real platform-fee payment-intent. Budget impact: 5% of $3,500 default test bid = **$175 charged**. Confirm Stripe is in **test mode** OR Dustin's accepted the live charge before starting.
5. **Idempotency:** Test contractor records are uniquely tagged with run ID (`pfw-{unix-ts}`). Old test records are NOT deleted (forensic preservation).
6. **is_test stamping (MANDATORY — CEO directive 2026-07-13, GitHub #543 item 4):** Every row the walk creates that has an `is_test` column (contractors, claims, quotes, any other artifact) MUST be stamped `is_test = true` immediately after creation and confirmed in that stage's verification SQL; set `admin_notes` with the run ID. A missed stamp is a stage FAIL — unstamped active test contractors receive real-claim notifications and are homeowner-selectable (#543 exposure).

---

## Test Account Plumbing

- **Test contractor email:** `pfw-contractor-{unix-ts}@otterquote.com` (catch-all to Dustin's Gmail)
- **Test homeowner email:** `pfw-homeowner-{unix-ts}@otterquote.com`
- **Stripe test card:** `4242 4242 4242 4242` (any future expiry, any CVC)
- **Test property address:** `1234 Pre-Flight Walk Ln, Indianapolis, IN 46201`
- **Test claim:** Roofing, retail (cash) — burns one envelope. Bid = `$3,500.00`.
- **Run ID:** Generate at startup as `pfw-{date +%s}` (bash) or `f"pfw-{int(time.time())}"` (python)
- **is_test stamp (per constraint #6):** after each created row is verified, `UPDATE contractors SET is_test = true WHERE email = '<walk email>'` / `UPDATE claims SET is_test = true WHERE id = '<claim id>'` (plus any other created row with the column), then re-select to confirm before the stage closes.

---

## Walk Protocol — 14 Stages

Each stage has a **Run** step and a **Verify** step. On any verify failure: dump diagnostic, mark stage FAIL, execute Halt Protocol, stop.

### Stage 1 — Pre-walk readiness gate

**Run:**
- Resolve `BASE_URL` per `--pr` logic above.
- **DocuSign JWT auth pre-check (run FIRST):**
  ```bash
  # Generate and POST JWT to DocuSign token endpoint
  INTEGRATION_KEY="$DOCUSIGN_INTEGRATION_KEY"
  echo "DocuSign iss (integration_key): $INTEGRATION_KEY"
  
  # Build JWT payload
  NOW=$(date +%s)
  EXP=$((NOW + 3600))
  HEADER='{"alg":"RS256","typ":"JWT"}'
  PAYLOAD="{\"iss\":\"$INTEGRATION_KEY\",\"sub\":\"dustinstohler1@gmail.com\",\"aud\":\"https://account.docusign.com/oauth/token\",\"iat\":$NOW,\"exp\":$EXP}"
  
  # Base64url encode and sign (requires openssl)
  B64_HEADER=$(echo -n "$HEADER" | base64 | tr '+/' '-_' | tr -d '=')
  B64_PAYLOAD=$(echo -n "$PAYLOAD" | base64 | tr '+/' '-_' | tr -d '=')
  SIGNING_INPUT="$B64_HEADER.$B64_PAYLOAD"
  SIGNATURE=$(echo -n "$SIGNING_INPUT" | openssl dgst -sha256 -sign <(echo "$DOCUSIGN_RSA_PRIVATE_KEY") | base64 | tr '+/' '-_' | tr -d '=')
  JWT="$SIGNING_INPUT.$SIGNATURE"
  
  # POST to DocuSign
  curl -s -w "\nHTTP_STATUS:%{http_code}" \
    -X POST "https://account.docusign.com/oauth/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=$JWT"
  ```
  **PASS:** HTTP 200, `access_token` present. Store token for Stage 10 REST calls.
  **FAIL:** Abort entire walk immediately with diagnostic block (integration_key, HTTP status, response body, 3-point checklist).

- Pull DocuSign envelope budget (reuse JWT access token).
- Site check: `curl -sI {BASE_URL}` returns 200; body contains "Stop chasing contractors".
  ```bash
  HTTP_STATUS=$(curl -sI "$BASE_URL" -o /dev/null -w "%{http_code}")
  BODY=$(curl -s "$BASE_URL" | head -c 5000)
  echo "HTTP: $HTTP_STATUS"
  echo "$BODY" | grep -c "Stop chasing contractors" && echo "CONTENT: PASS" || echo "CONTENT: FAIL"
  ```
- Stripe test-mode check OR Dustin override.
- Sentry baseline: snapshot current unresolved issue count.

**Verify:** All six gates pass.

---

### Stage 2 — Fresh contractor signup

**Sub-stage 2a — redirect_to override probe (per R-036/ADR-011):**
```bash
TS=$(date +%s)
curl -s -X POST "https://yeszghaspzwwstvsrioa.supabase.co/auth/v1/admin/generate_link" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"email\":\"dustinstohler1+pfw-redirprobe-$TS@gmail.com\",\"options\":{\"redirect_to\":\"https://otterquote.com/contractor-pre-approval.html\",\"data\":{\"role\":\"contractor\"}}}" \
  | python -c "import sys,json,urllib.parse; data=json.load(sys.stdin); link=data.get('action_link',''); params=urllib.parse.parse_qs(urllib.parse.urlparse(link).query); print(params.get('redirect_to',['NOT_FOUND'])[0])"
```
**PASS criterion:** result equals `https://otterquote.com/contractor-pre-approval.html` exactly.
**FAIL action:** Log "Supabase redirect_to override ACTIVE — see ADR-011". Check production for `<!-- D-225 launch-eve hotfix v2 -->` script block in index.html. If absent, HALT. Cleanup probe user before exiting.

**Sub-stage 2b — live signup flow:**
```
mcp__Claude_in_Chrome__navigate → {BASE_URL}/contractor-join.html
mcp__Claude_in_Chrome__form_input → email field: dustinstohler1+pfw-contractor-{ts}@gmail.com
mcp__Claude_in_Chrome__find + click → submit button
```
Wait for magic-link confirmation page.

**Verify (Gmail MCP):**
```
mcp__c80ede65-ba2f-483c-bdfc-cc6848096f81__search_threads
  query: "from:noreply@mail.otterquote.com to:dustinstohler1+pfw-contractor-{ts}@gmail.com"
  max_results: 1
```
Extract auth link. Click it via `mcp__Claude_in_Chrome__navigate`.

**Sub-stage 2c — landing URL assertion (per R-036/ADR-011):**
```
mcp__Claude_in_Chrome__javascript_tool → return window.location.href
```
**PASS criterion:** pathname starts with `/contractor-pre-approval.html`.
**FAIL action:** Capture console output for `[bounce]` log lines, capture localStorage `cs_auth_role`. HALT — this is the May 14 launch-eve failure mode.

**Verify (Supabase MCP):**
```sql
SELECT id, email, created_at FROM auth.users
WHERE email = 'dustinstohler1+pfw-contractor-{ts}@gmail.com'
ORDER BY created_at DESC LIMIT 1;
```
Expect one row created within the last 2 minutes.

---

### Stage 3 — Contractor pre-approval wizard (D-210 three-artifact gate)

**Run (Chrome MCP):**

Generate placeholder CGL PDF at startup:
```python
TMP_RUN_DIR = Path(f"/tmp/pfw-{TS}")
TMP_RUN_DIR.mkdir(parents=True, exist_ok=True)
cgl_pdf = TMP_RUN_DIR / f"pfw-cgl-{TS}.pdf"
# Write minimal PDF (5KB blank)
cgl_pdf.write_bytes(b'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n180\n%%EOF\n')
```

Navigate to `contractor-pre-approval.html`. Complete:
- Page 1: company info, phone, trades (Roofing), service counties (Marion County, IN)
- Page 2 (D-210 three artifacts):
  - CGL: Upload `pfw-cgl-{ts}.pdf` via `mcp__Claude_in_Chrome__file_upload`
  - W/C: Select "Sole-proprietor — IC 22-3-2-14.5 exemption" → check WCE-1 attestation
  - License: Select "Not provided — Indiana does not require state roofing license"
- Submit page 2.

**Verify (Supabase MCP):**
```sql
SELECT id, user_id, company_name, phone, trades, service_counties,
       coi_file_url, coi_expires_at, wc_cert_file_ref,
       license_path, status
FROM contractors
WHERE email = 'dustinstohler1+pfw-contractor-{ts}@gmail.com';
```
Expect: phone populated, trades includes 'roofing', service_counties contains '18097', coi_file_url populated, wc_cert_file_ref = 'WCE-1-EXEMPT', license_path = 'not_provided', status = 'pending_approval'.

**Verify (Supabase MCP) — HubSpot activity_log:**
```sql
SELECT event_type, metadata FROM activity_log
WHERE metadata->>'contractor_email' = 'dustinstohler1+pfw-contractor-{ts}@gmail.com'
  AND event_type = 'hubspot_contact_created'
ORDER BY created_at DESC LIMIT 1;
```

---

### Stage 4 — Admin approval

**Run (Chrome MCP):**
Switch to admin session (dustinstohler1@gmail.com). Navigate to `/admin-contractors.html`. Locate new pre-approval row. Click "Approve".

**Verify (Supabase MCP):**
```sql
SELECT status, approved_at FROM contractors
WHERE email = 'dustinstohler1+pfw-contractor-{ts}@gmail.com';
```
Expect `status = 'approved'`, `approved_at` not null.

---

### Stage 5 — Contractor payment method on file

**Run (Chrome MCP):**
Switch to contractor session. Open `/contractor-settings.html`. Add Stripe test card `4242 4242 4242 4242`, exp `12/30`, CVC `123`.

**Verify (Stripe MCP):**
```
mcp__6451a33c-3d36-49d8-8b0d-42998d328ae5__list_customers
  email: "dustinstohler1+pfw-contractor-{ts}@gmail.com"
```
Expect one customer with payment_method of type `card`, `last4 = '4242'`.

**Verify (Supabase MCP):**
```sql
SELECT stripe_customer_id, stripe_payment_method_id
FROM contractors WHERE email = 'dustinstohler1+pfw-contractor-{ts}@gmail.com';
```
Both columns populated.

---

### Stage 6 — Fresh homeowner intake

**Run (Chrome MCP):**
Open incognito context. Navigate to `{BASE_URL}/get-started.html`. Submit with `dustinstohler1+pfw-homeowner-{ts}@gmail.com`. Complete magic-link auth (Gmail MCP). Complete intake to `bids.html` waiting state.

**Verify (Supabase MCP):**
```sql
SELECT c.id, c.user_id, c.property_address, c.status, c.trades_requested,
       c.funding_source
FROM claims c
JOIN auth.users u ON c.user_id = u.id
WHERE u.email = 'dustinstohler1+pfw-homeowner-{ts}@gmail.com'
ORDER BY c.created_at DESC LIMIT 1;
```
Expect: property_address matches `1234 Pre-Flight Walk Ln`, funding_source = 'retail-cash', trades_requested = ['roofing']. Capture `claim_id`.

---

### Stage 7 — Contractor bid submission (D-215 Layer 1 + D-214 fee acceptance)

**Run (Chrome MCP):**
Switch to contractor session. Open `/contractor-opportunities.html`. Locate claim. Click "Bid". Complete 3-step wizard: total bid = `$3,500.00`, warranty (GAF Silver Pledge, 10yr), fee acceptance tick. Submit.

**Verify (Supabase MCP) — quote row:**
```sql
SELECT id, claim_id, contractor_id, total_price, status,
       fee_percentage, fee_amount, platform_fee_pct, platform_fee_basis,
       fee_accepted_at, warranty_option_id, warranty_snapshot,
       workmanship_warranty_years
FROM quotes
WHERE claim_id = '{claim_id}'
ORDER BY created_at DESC LIMIT 1;
```
Expect: status = 'submitted', total_price = 3500.00, fee_percentage = 5.0, fee_amount = 175.00, fee_accepted_at not null, warranty_snapshot JSONB with "GAF" and "Silver", workmanship_warranty_years = 10.

Internal-consistency check (python):
```python
fee_amount = float(quote_row['fee_amount'])
total_price = float(quote_row['total_price'])
fee_pct = float(quote_row['fee_percentage'])
expected = round(total_price * fee_pct / 100, 2)
assert fee_amount == expected, f"Fee mismatch: fee_amount={fee_amount} expected={expected}"
```

**Verify (Supabase MCP) — fee_acceptances row (D-215 Layer 1):**
```sql
SELECT id, quote_id, contractor_id, fee_pct, fee_text_displayed,
       ip_address, user_agent, accepted_at
FROM fee_acceptances
WHERE quote_id = '{quote_id}';
```
Expect: exactly one row, fee_pct = 5.0, ip_address valid (not null, not '0.0.0.0'), user_agent contains "Chrome", accepted_at within 60s of quotes.fee_accepted_at.

---

### Stage 8 — D-215 Layer 2 confirmation email

**Run:** Bid submission triggers `send-bid-confirmation` EF. Wait up to 30 seconds.

**Verify (Gmail MCP):**
```
mcp__c80ede65-ba2f-483c-bdfc-cc6848096f81__search_threads
  query: "to:dustinstohler1+pfw-contractor-{ts}@gmail.com subject:Bid confirmation OR subject:Job #"
```
Assert:
- Subject contains `Job #{last 8 of claim_id, uppercase}` (D-216)
- Body contains `$175.00`
- Body contains rescission link
- Body contains `1234 Pre-Flight Walk Ln`
- From name contains "Otter Quotes" (D-175)

**Verify (Supabase MCP):**
```sql
SELECT event_type, metadata FROM activity_log
WHERE event_type = 'bid_confirmation_email_sent'
  AND metadata->>'quote_id' = '{quote_id}'
ORDER BY created_at DESC LIMIT 1;
```
Expect: `mailgun_status = 200`.

---

### Stage 9 — Homeowner accepts the bid

**Run (Chrome MCP):**
Switch to homeowner session. Refresh `/bids.html`. Click "Accept this bid". Confirm in modal.

**Verify (Supabase MCP):**
```sql
SELECT status FROM quotes WHERE id = '{quote_id}';
SELECT selected_contractor_id FROM claims WHERE id = '{claim_id}';
```
Expect: quotes.status = 'awarded', claims.selected_contractor_id = {contractor_id}.

---

### Stage 10 — DocuSign envelope creation (D-186 dual-party initials)

**Run:** Acceptance triggers `create-docusign-envelope` EF. Wait up to 60 seconds.

**Verify (Supabase MCP):**
```sql
SELECT docusign_envelope_id FROM claims WHERE id = '{claim_id}';
```
Capture `envelope_id`.

**Verify (DocuSign REST — bash):**
```bash
curl -s \
  -H "Authorization: Bearer $DOCUSIGN_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  "https://na4.docusign.net/restapi/v2.1/accounts/{account_id}/envelopes/$ENVELOPE_ID" \
  | python -c "
import sys, json
data = json.load(sys.stdin)
print('status:', data.get('status'))
signers = data.get('recipients', {}).get('signers', [])
for s in signers:
    print(f'signer clientUserId={s.get(\"clientUserId\")} status={s.get(\"status\")} routingOrder={s.get(\"routingOrder\")}')
print('documents:', [d.get('documentId') for d in data.get('envelopeDocuments', [])])
"
```
Expect: status = 'sent', two signers (contractor clientUserId='contractor_1' routing=1, homeowner clientUserId='homeowner_1' routing=2), two documents.

---

### Stage 11 — Contractor signs first

**Run (Chrome MCP):**
Switch to contractor session. Navigate to `/contractor-dashboard.html`. Click "Sign this contract". Drive embedded DocuSign iframe: Adopt Signature → Sign → click each `/ContractorInitial/` anchor → Submit.

**Verify (Supabase MCP) — after 10s wait:**
```sql
SELECT id, status, contractor_signed_at FROM quotes WHERE id = '{quote_id}';
```
Expect: contractor_signed_at populated, status still 'awarded'.

**Verify (DocuSign REST):**
```bash
curl -s \
  -H "Authorization: Bearer $DOCUSIGN_ACCESS_TOKEN" \
  "https://na4.docusign.net/restapi/v2.1/accounts/{account_id}/envelopes/$ENVELOPE_ID/recipients" \
  | python -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('signers', []):
    print(f'clientUserId={s.get(\"clientUserId\")} status={s.get(\"status\")} signedDateTime={s.get(\"signedDateTime\")}')
"
```
Expect: contractor status = 'completed' with signedDateTime, homeowner still 'sent'.

---

### Stage 12 — Homeowner signs second + payment + claim update

**Run (Chrome MCP):**
Switch to homeowner session. Open `/contract-signing.html?claim_id={claim_id}`. Drive embedded DocuSign iframe: Adopt Signature → click each `/HomeownerInitial/` anchor → Submit. Wait up to 90 seconds for `docusign-webhook` completion.

**Verify (Supabase MCP):**
```sql
SELECT id, status, contract_signed_at, contract_signed_by
FROM claims WHERE id = '{claim_id}';
SELECT id, status, payment_status, payment_intent_id, contractor_signed_at
FROM quotes WHERE id = '{quote_id}';
```
Expect: claims.status = 'contract_signed', quotes.payment_status = 'paid', quotes.payment_intent_id populated.

**Verify (Stripe MCP):**
```
mcp__6451a33c-3d36-49d8-8b0d-42998d328ae5__fetch_stripe_resources
  resource_type: payment_intent
  resource_id: {payment_intent_id}
```
Expect: status = 'succeeded', amount = 17500 cents, metadata.claim_id = {claim_id}.

**Verify (DocuSign REST):** Envelope status = 'completed', both signers status = 'completed'.

---

### Stage 13 — D-186 dual-party initials verification on executed PDF

**Run (bash):**
```bash
# Download combined documents PDF
curl -s \
  -H "Authorization: Bearer $DOCUSIGN_ACCESS_TOKEN" \
  "https://na4.docusign.net/restapi/v2.1/accounts/{account_id}/envelopes/$ENVELOPE_ID/documents/combined" \
  -o "/tmp/$RUN_ID/executed-$ENVELOPE_ID.pdf"

# Extract text to verify initials
pdftotext "/tmp/$RUN_ID/executed-$ENVELOPE_ID.pdf" - 2>/dev/null | grep -i "initial" | head -20
```

**Verify:** PDF image stream count per Exhibit A page == 2× page count (one per party per page). "Initial here — Contractor / Homeowner" labels visible on page 1 of Exhibit A.

**FAIL action:** Save PDF to `WORKSPACE / "Skills Output" / f"forensic-{RUN_ID}.pdf"` for review. Dump expected vs. actual image counts per page.

---

### Stage 14 — Post-signing fan-outs (notify-contractors, homeowner Mailgun, D-215 L3 invoice)

**Run:** Wait 30 seconds after Stage 12 completion.

**Verify (Supabase MCP) — activity_log triple:**
```sql
SELECT event_type, created_at, metadata
FROM activity_log
WHERE metadata->>'claim_id' = '{claim_id}'
  AND created_at > NOW() - INTERVAL '5 minutes'
ORDER BY created_at;
```
Expect three rows in this order:
1. (Optional) contractor notification
2. `event_type = 'homeowner_contract_signed_email_sent'` with `mailgun_status = 200`
3. `event_type = 'invoice_created'` with `metadata.quote_id = {quote_id}` (D-215 Layer 3)

**Verify (Gmail MCP) — contractor invoice email:**
```
mcp__c80ede65-ba2f-483c-bdfc-cc6848096f81__search_threads
  query: "to:dustinstohler1+pfw-contractor-{ts}@gmail.com subject:OtterQuote Invoice"
```
Assert: body contains `$175.00`, body contains 5% fee disclosure language.

**Verify (Gmail MCP) — homeowner contract-signed email:**
```
mcp__c80ede65-ba2f-483c-bdfc-cc6848096f81__search_threads
  query: "to:dustinstohler1+pfw-homeowner-{ts}@gmail.com subject:Your Otter Quotes contract is signed"
```
Assert: body contains `Job #{last 8 of claim_id, uppercase}` (D-216), contractor company name, `1234 Pre-Flight Walk Ln`.

---

## Output Format

```
========== PRE-FLIGHT WALK RESULT — run pfw-{ts} ==========
Target: {BASE_URL}
Started: {ISO-8601 timestamp}
Finished: {ISO-8601 timestamp}
Wall clock: {N} minutes
Envelope burned: {envelope_id}
DocuSign budget remaining: {N}/40

Stage  1 — Pre-walk readiness gate                  ✅ PASS
Stage  2 — Fresh contractor signup                  ✅ PASS
Stage  3 — Contractor pre-approval wizard (D-210)   ✅ PASS
Stage  4 — Admin approval                           ✅ PASS
Stage  5 — Contractor payment method on file        ✅ PASS
Stage  6 — Fresh homeowner intake                   ✅ PASS
Stage  7 — Bid submission + fee_acceptance (D-215)  ✅ PASS
Stage  8 — D-215 Layer 2 confirmation email         ✅ PASS
Stage  9 — Homeowner accepts the bid                ✅ PASS
Stage 10 — DocuSign envelope creation (D-186)       ✅ PASS
Stage 11 — Contractor signs first                   ✅ PASS
Stage 12 — Homeowner signs + payment + claim update ✅ PASS
Stage 13 — D-186 dual-party initials on Exhibit A   ✅ PASS
Stage 14 — Post-signing fan-outs (Layer 3 invoice)  ✅ PASS

VERDICT: 🟢 LAUNCH-READY

Test contractor:  dustinstohler1+pfw-contractor-{ts}@gmail.com
Test homeowner:   dustinstohler1+pfw-homeowner-{ts}@gmail.com
Claim ID:         {uuid}
Quote ID:         {uuid}
Envelope ID:      {guid}
Payment Intent:   {pi_xxx}
==========================================================
```

On stage FAIL, end block at the failed stage with verdict 🔴 NOT LAUNCH-READY + Halt Protocol output.

---

## Stage Failure Halt Protocol

On every stage FAIL, execute these two steps automatically before the session ends.

### Step 1 — Create GitHub triage issue

```
mcp__github__issue_write
  method: create
  owner: StellarEdgeServices
  repo: otterquote-platform
  title: "[PFW FAIL] Stage {N} — {stage-name} | run pfw-{ts}"
  priority: high (Stages 1–5) / normal (Stages 6–14)   # note in body — GitHub has no native priority field
  labels: ["env:code", "pre-flight-walk-blocker", "bug"]
  body: |
    Pre-flight-walk stage failure — auto-created by halt protocol.

    Run ID: pfw-{ts}
    Stage: {N} — {stage-name}
    Failure summary: {one-sentence description}

    ## Evidence
    {exact diagnostic dump — expected value, actual value, SQL rows, API responses, EF log lines}

    ## Reproduction path
    {URL visited, action taken, test email used, contractor/homeowner IDs}

    ## Bug-killer invocation
    bug-killer: "Investigate [PFW FAIL] Stage {N} — {stage-name}, run pfw-{ts}.
    {failure-description}. Evidence: {compact one-paragraph summary}."
```

### Step 2 — Surface bug-killer handoff prompt to operator

```
============================================================
PRE-FLIGHT HALT — Stage {N}: {stage-name}
GitHub issue created: {issue_url}

Bug-killer invocation (paste into a new Cowork session):
  bug-killer: "Investigate [PFW FAIL] Stage {N} — {stage-name}, run pfw-{ts}.
  {one-sentence failure description}. Evidence: {compact summary}."
============================================================
```

---

## Handoff Protocol

If Claude Code session ends before walk completion:

```python
from pathlib import Path
import datetime

HANDOFFS_DIR = Path(r"handoffs")  # relative to Claude Downloads (workspace root)
HANDOFFS_DIR.mkdir(exist_ok=True)

handoff_path = HANDOFFS_DIR / f"pre-flight-walk-{RUN_ID}.md"
handoff_content = f"""# Pre-Flight Walk Handoff

run_id: {RUN_ID}
base_url: {BASE_URL}
status: interrupted
last_stage_completed: [N]
next_stage: [N+1]
claim_id: [if captured]
quote_id: [if captured]
envelope_id: [if captured]
docusign_access_token: [if captured — expires in 1hr]
contractor_email: pfw-contractor-{TS}@otterquote.com
homeowner_email: pfw-homeowner-{TS}@otterquote.com
interrupted_at: {datetime.datetime.utcnow().isoformat()}Z
"""
handoff_path.write_text(handoff_content, encoding='utf-8')
```

---

## Failure Modes (Known)

- **Magic-link delivery delay** — Retry Gmail MCP search up to 4× with 15s sleeps before failing.
- **DocuSign Connect webhook retry latency** — Wait up to 90s after each signing action.
- **Stripe PaymentIntent confirmation latency** — If > 10s, dump `process-dunning` activity.
- **HubSpot contact creation** — Non-blocking on build; mark as WARN not FAIL if activity_log row missing.
- **Hover skip in test mode** — Requires `platform_settings.skip_hover_in_test = true`. Set at Stage 1 or surface to Dustin.

---

## Post-Walk Cleanup (Default OFF)

Test records are LEFT IN PLACE. Filter in admin views via `email LIKE 'pfw-%'`.
`run pre-flight-walk cleanup` = separate operation to delete `pfw-%` records older than 7 days.

---

## Authority + Tier Interactions

- **Pre-flight-walk run = Tier A.** Claude can invoke autonomously on every trigger.
- **Real Stripe charge:** $175 is a Tier C side effect baked into the walk design. ASK Dustin before each invocation unless he typed a trigger phrase explicitly.
- **Stage failures requiring code change:** Auto-become P0 GitHub issues (`StellarEdgeServices/otterquote-platform`, label `env:code`) tagged `pre-flight-walk-blocker`.

---

## Bash Usage Registry

Approved bash for this skill:
- `curl -sI <url>` — site health checks
- `curl -sf -H "Authorization: Bearer $TOKEN" ...` — DocuSign REST + Netlify API
- `pdftotext` / `pdf2text` — PDF content extraction for Stage 13
- `python -c "..."` — JSON parsing, JWT assembly, signature verification
- `openssl dgst -sha256 -sign` — JWT RS256 signing

Prohibited bash for this skill:
- `git push` / `gh pr` — never modifies code; deploys route through D-221 separately
- `psql` / direct DB writes — all DB access through Supabase MCP only

---

<!-- v1.3 — 2026-05-18 — Claude Code port of pre-flight-walk-SKILL.md v1.3 -->
<!-- Adaptations: Path constants (Windows), python3→python, MCP tool names explicit (mcp__Claude_in_Chrome__, mcp__dd6eed43-*, mcp__c80ede65-*, mcp__6451a33c-*, mcp__bbfecab5-*), bash tmp dir /tmp/{RUN_ID}/, handoff file protocol added, JWT signing via openssl explicit in bash -->

## Changelog

**2026-08-13 — R-098 escalation repoint (Overdrive Bridge, GitHub #775):** engineering task creation moved from retired ClickUp list 901711730553 to GitHub Issues.
