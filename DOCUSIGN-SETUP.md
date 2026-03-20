# DocuSign Integration Setup — ClaimShield

## Current Status
- **Account:** Developer sandbox (na3.docusign.net)
- **Integration Key:** 43f4a7d5-f1bf-45ec-8a97-264e3d473e42
- **Account ID:** 0b57b777-5c6e-4650-80d3-14152257ca82
- **Edge Function:** `create-docusign-envelope` — REBUILT with full JWT auth, anchor-based tabs, two-signer flow
- **Missing:** RSA key pair (Step 1 below)

## Step 1: Generate RSA Key Pair (5 minutes)

1. Go to https://admindemo.docusign.com (sandbox) → Settings → Apps and Keys
2. Find your integration "ClaimShield" (or create it if it's not there)
3. Under **Authentication**, select **Authorization Code Grant** AND **JWT Grant**
4. Click **"+ GENERATE RSA"**
5. **IMMEDIATELY COPY THE PRIVATE KEY** — DocuSign only shows it once
6. Save it to a file (e.g., `docusign-private-key.pem`)

## Step 2: Base64-Encode the Private Key

Open a terminal and run:
```bash
base64 -w 0 docusign-private-key.pem > docusign-private-key-b64.txt
```
(On Windows PowerShell: `[Convert]::ToBase64String([System.IO.File]::ReadAllBytes("docusign-private-key.pem"))`)

Copy the entire base64 string — you'll need it in Step 4.

## Step 3: Grant Consent

DocuSign requires a one-time consent flow:

1. Open this URL in a browser (replace YOUR_INTEGRATION_KEY):
```
https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=43f4a7d5-f1bf-45ec-8a97-264e3d473e42&redirect_uri=https://stellaredgeservices.com
```
2. Log in with your DocuSign developer account
3. Click **"Accept"** to grant consent
4. You'll be redirected to stellaredgeservices.com — that's fine, the consent is now recorded

## Step 4: Set Supabase Edge Function Secrets

Run these commands (you'll need the Supabase CLI and access token):

```bash
cd Projects/ClaimShield/Claimshield-v2

# Set the RSA private key (paste the base64 string from Step 2)
supabase secrets set DOCUSIGN_RSA_PRIVATE_KEY="<paste-base64-encoded-private-key>"

# Verify existing secrets are still set
supabase secrets list
```

You should see these DocuSign-related secrets:
- `DOCUSIGN_INTEGRATION_KEY` (should already be set)
- `DOCUSIGN_USER_ID` (should already be set)
- `DOCUSIGN_ACCOUNT_ID` (should already be set)
- `DOCUSIGN_RSA_PRIVATE_KEY` (NEW — from Step 2)

If any are missing, set them:
```bash
supabase secrets set DOCUSIGN_INTEGRATION_KEY="43f4a7d5-f1bf-45ec-8a97-264e3d473e42"
supabase secrets set DOCUSIGN_ACCOUNT_ID="0b57b777-5c6e-4650-80d3-14152257ca82"
supabase secrets set DOCUSIGN_USER_ID="<your-docusign-user-id>"
```

## Step 5: Redeploy the Edge Function

```bash
supabase functions deploy create-docusign-envelope
```

## Step 6: Create Supabase Storage Bucket

The Edge Function expects contractor templates in a `contractor-templates` bucket:

In Supabase Dashboard → Storage:
1. Create bucket: `contractor-templates`
2. Set as **private** (only accessible via service role key)
3. File structure: `{contractor_id}/contract.pdf` and `{contractor_id}/color_confirmation.pdf`

## Step 7: Test with Stohler Roofing

1. Upload the Stohler Insurance Proceeds Contingency Agreement PDF to:
   `contractor-templates/{stohler-contractor-id}/contract.pdf`

2. Upload the Stohler Color Confirmation PDF to:
   `contractor-templates/{stohler-contractor-id}/color_confirmation.pdf`

3. Call the Edge Function:
```bash
curl -X POST https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/create-docusign-envelope \
  -H "Authorization: Bearer <your-supabase-anon-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "claim_id": "test-claim-id",
    "document_type": "contract",
    "contractor_id": "stohler-contractor-id",
    "signer": {
      "email": "dustinstohler1@gmail.com",
      "name": "Test Homeowner"
    },
    "contractor_signer": {
      "email": "dustin@stohlerroof.com",
      "name": "Stohler Roofing"
    },
    "fields": {
      "customer_name": "Test Homeowner",
      "customer_address": "123 Test St",
      "customer_city_zip": "Indianapolis, IN 46208",
      "customer_phone": "317-555-0100",
      "customer_email": "test@example.com",
      "insurance_company": "State Farm",
      "claim_number": "SF-2026-TEST",
      "deductible": "$2,500"
    }
  }'
```

4. You should get back an `envelope_id` and `signing_url`
5. Open the `signing_url` to test the embedded signing experience

## How It Works — Field Mapping

The Edge Function uses **DocuSign anchor tags** to find field positions in the contractor's PDF:

| Field | Anchor Text | What Gets Filled |
|-------|------------|------------------|
| customer_name | "Name" | Homeowner's full name |
| customer_address | "Address:" | Street address |
| customer_city_zip | "City/Zip:" | City, State, ZIP |
| customer_phone | "Phone" | Phone number |
| customer_email | "Email:" | Email address |
| insurance_company | "Insurance Co" | Carrier name |
| claim_number | "Claim #" | Claim number |
| deductible | "DEDUCTIBLE:" | Deductible amount |
| shingle_manufacturer | "Single Manufacture" | Brand (GAF, OC, etc.) |
| shingle_type | "Shingle Type:" | Product line |
| shingle_color | "Shingle Color:" | Selected color |
| drip_edge_color | "Drip Edge Color:" | Drip edge color |

**Signatures:** The function looks for "Customer" and "Contractor" anchor text near signature lines.

## Production Checklist

Before going live:
- [ ] Generate RSA key pair (Step 1)
- [ ] Grant consent (Step 3)
- [ ] Set RSA private key secret (Step 4)
- [ ] Redeploy Edge Function (Step 5)
- [ ] Create contractor-templates storage bucket (Step 6)
- [ ] Test with Stohler contract (Step 7)
- [ ] Switch from sandbox to production DocuSign (change DOCUSIGN_BASE_URL)
- [ ] Go through DocuSign "Go Live" process (requires app review)
