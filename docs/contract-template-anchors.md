# Contract Template Anchor Requirements

Otter Quotes places DocuSign signature and data fields on **your** contract by
searching it for short marker strings called **anchors**. Your contract stays
your contract — we never rewrite its terms. We only need to know *where* to put
the signatures and the job details.

Upload one PDF per trade × funding type (e.g. Roofing / Insurance).

## Rules

1. **Every required anchor must appear in the PDF, spelled and capitalized exactly as shown.** Matching is case-sensitive.
2. **Each anchor must appear exactly once.** DocuSign places a field at *every* occurrence, so a second copy produces a duplicate signature box.
3. Anchors may be rendered in white or very light grey so they are invisible in print. They must still be selectable text — not an image, not a flattened scan.
4. Leave blank space (a rule or underscore run) to the right of each data anchor. Values are placed just past the end of the anchor text.

## Required anchors — Roofing / Insurance (14)

| Anchor | What we place there |
|---|---|
| `/Customer/` | Homeowner signature |
| `/Customer_Date/` | Homeowner sign date |
| `/Contractor/` | Contractor signature |
| `/Contractor_Date/` | Contractor sign date |
| `Name` | Homeowner name |
| `Address:` | Property address |
| `Contract Price:` | Total contract amount (RCV-based) |
| `Insurance Co` | Carrier |
| `Claim #` | Carrier claim number |
| `DEDUCTIBLE:` | Homeowner deductible |
| `Material:` | Shingle product / brand |
| `Manufacturer's Warranty:` | Auto-filled from the D-202 manifest |
| `Workmanship Warranty:` | Your workmanship warranty term |
| `Decking/Sheet:` | Per-sheet decking replacement price |

## Required anchors — Roofing / Retail (13)

Same as above, except: **no** `Insurance Co`, `Claim #`, or `DEDUCTIBLE:`; **add**
`Description:` (job description / "See Exhibit A") and `Start Date:` (estimated start).

## Optional anchors

If present, these are filled too: `City/Zip:`, `Phone`, `Email:`, `Shingle Type:`,
`Shingle Color:`, `Drip Edge Color:`, `Vents`, `Satellite`, `Skylights`,
`Full Redeck:`, `Permit Fee:`, `Dumpster Fee:`, `Contractor:`, `Contractor Phone:`,
`Contractor Email:`, `Contractor Address:`, `License #:`, `Structures:`,
`Structure Names:`, `Valley Type:`, `Bad Decking:`, `Project Notes:`.

## Common mistakes

- Using `Customer Name` where the anchor is `Name` — the extra word is fine only if the exact string `Name` still appears somewhere once.
- Writing `TOTAL CONTRACT PRICE ($)` instead of `Contract Price:` — capitalization and the colon matter.
- A scanned or flattened PDF. If you cannot select the text in a PDF reader, neither can we.
- Repeating an anchor in the body prose as well as the signature block.

## What happens after upload

The template is scanned automatically. `auto_validated` means every required
anchor was found and you can bid immediately. Anything else is shown on
**Settings → Contract Templates** with the specific anchors that are missing.

Reference implementations live in
`CEO/CTO/Architecture/Sample Walkthrough Packets/Contractors/` (workspace).

> Engineering note: `create-docusign-envelope` resolves anchors from the manifest in
> `supabase/functions/validate-contract-template/index.ts`. It does **not** consult
> `contractor_templates.manual_overrides` — see issue #508. Until that is resolved,
> canonical anchors are the only supported path to an executable contract.
