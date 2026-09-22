# OtterQuote Synthetic UX Walkthroughs

Nightly automated checks run via Claude in Chrome. Edit this file to update flow definitions.
Last updated: 2026-09-21

---

## gh-2064 — internal-traffic opt-out

Every URL these flows navigate to must carry `?oq_internal=1` (or `&oq_internal=1`
if the URL already has a query string) on its first navigation of the run —
e.g. `https://otterquote.com/get-started.html?oq_internal=1`. This sets an
`oq_internal=1` cookie for one year on `.otterquote.com`, which every tag
loader on the site (`js/ga-gate.js`, `js/meta-pixel-gate.js`, the Clarity
snippet those files carry, and the React app's `GA4Gate`/`MetaPixelGate`)
checks before loading anything — GA4, Meta Pixel and Clarity never load for
the rest of that browser's session once the cookie is set, so this run is
not counted as a visitor in any of the three tools. Do not remove the param
from a flow's URL to "simplify" it; a walkthrough missed here shows up as a
polluted conversion rate in GA4/Meta and an extra recorded session in
Clarity, exactly the problem #2064 fixed.

---

## Flow 1 — Get-Started Homeowner Intake

**URL:** https://otterquote.com/get-started.html?oq_internal=1  
**Purpose:** Verify the homeowner intake form renders correctly and the first step is accessible.

**Steps:**
1. Navigate to https://otterquote.com/get-started.html?oq_internal=1
2. Wait for page to fully load (look for the multi-step form or intake UI)
3. Verify at least one form step is visible (name/email/address fields or equivalent)
4. Verify no JavaScript errors visible on page (check for error banners)

**Pass criteria:** Page returns HTTP 200 and the intake form renders with at least one visible input field.  
**Fail criteria:** Page blank, 4xx/5xx, form not visible, or error banner present.  
**Idempotency strategy:** Read-only structural check. Do NOT submit any form data. No records created.

---

## Flow 2 — Contractor Profile Page

**URL:** https://otterquote.com/contractor-profile.html?oq_internal=1  
**Purpose:** Verify the contractor profile page loads and key sections are accessible.

**Steps:**
1. Navigate to https://otterquote.com/contractor-profile.html?oq_internal=1
2. Wait for page to fully load
3. Verify profile form section is visible (look for inputs, document upload area, or the auth redirect)
4. Verify no crash-level errors (blank white screen = fail; auth redirect = pass)

**Pass criteria:** Page returns HTTP 200 and renders meaningful content (either the profile form or an auth redirect). A login redirect is acceptable — it means auth guard is working.  
**Fail criteria:** Blank white screen, JS exception making the page unusable, or HTTP error.  
**Idempotency strategy:** Read-only. No authentication attempted.

---

## Flow 3 — Contractor Login Page

**URL:** https://otterquote.com/contractor-login.html?oq_internal=1  
**Purpose:** Verify the login page renders with functional form elements.

**Steps:**
1. Navigate to https://otterquote.com/contractor-login.html?oq_internal=1
2. Wait for page to load
3. Verify an email input field is present
4. Verify a password input field is present
5. Verify a submit button is present

**Pass criteria:** All three form elements visible and page returns HTTP 200.  
**Fail criteria:** Missing any form element, blank page, HTTP error.  
**Idempotency strategy:** Read-only. Do NOT enter credentials or submit the form.

---

## Flow 4 — Contract Signing Page

**URL:** https://otterquote.com/contract-signing.html?oq_internal=1  
**Purpose:** Verify the signing page loads without a hard crash. A "no envelope" or auth-redirect state is acceptable.

**Steps:**
1. Navigate to https://otterquote.com/contract-signing.html?oq_internal=1
2. Wait for page to load
3. Verify page renders something meaningful — auth redirect, "no active contract" message, or the signing interface itself

**Pass criteria:** Page returns HTTP 200 and renders any non-blank content. Auth redirect or "no envelope" state = PASS.  
**Fail criteria:** Blank white screen, uncaught exception making the page unusable, HTTP error.  
**Idempotency strategy:** Read-only. No DocuSign interaction.

---

## Failure Routing

When any flow fails, the scheduled walkthrough task must:
1. Append a `FAILED` entry to `Stellar Edge Services/OtterQuote/Docs/executive-briefing.md`
2. Send a Mailgun alert to dustinstohler1@gmail.com with:
   - Subject: `OtterQuote Walkthrough Failure — [Flow Name] [Date]`
   - Body: Flow name, what was found, URL checked, timestamp
3. Read `Claude's Memories/otterquote-memory.md` for Mailgun API key before sending

## Scheduled Task Prompt Template

Once the scheduled task is created, it should use this prompt:
> Read the walkthrough definitions from `otterquote-deploy/Docs/synthetic-walkthroughs.md`. Run each of the 4 flows against the live site using Claude in Chrome (list_connected_browsers → navigate → get_page_text or find). Log results to `otterquote-deploy/Docs/walkthrough-log.md`. If any flow fails, update `executive-briefing.md` and send a Mailgun failure alert per the Failure Routing section of the walkthroughs file. Read `Claude's Memories/otterquote-memory.md` for Mailgun credentials.

*(Scheduled task creation is deferred until Chrome connection is available and baseline passes.)*

---

## Walkthrough Log Format

Each run appends to `Docs/walkthrough-log.md`:

```
## [DATE] — [Run type: Baseline | Nightly]
- Flow 1 (Get-started): PASS/FAIL — [note]
- Flow 2 (Contractor profile): PASS/FAIL — [note]  
- Flow 3 (Contractor login): PASS/FAIL — [note]
- Flow 4 (Contract signing): PASS/FAIL — [note]
```
