// gh-1412 — D-317 / D-312 copy constraints on the two measurement emails,
// asserted against the shipped template source rather than described in a
// comment.
//
// The two decisions these emails must obey:
//
//   D-312 — "no third-party vendor named on any public-facing OtterQuote
//   surface". A homeowner email is such a surface.
//
//   D-317 cl. 6 — "Roof imagery comes from licensed map imagery at the
//   address ... the vendor's report is never shown to any party (its footer
//   prohibits reproduction)." So the homeowner email may say the report is
//   ready and must not carry the vendor's artifact or the vendor's identity.
//
//   D-317 cl. 3 — "The homeowner sees every bid as two lists — INCLUDED IN
//   YOUR PRICE and EXTRA CHARGES IF NEEDED with rates" (Dustin, verbatim:
//   "I don't want extra costs hiding in a list."). Prices belong in the bid
//   view, which is where that clause puts them. The report-ready email is a
//   delivery notice and quotes no money — and it must never quote what the
//   report COST US, which is what would turn an internal margin into
//   customer-facing copy.
//
// The admin email is deliberately held to a different bar: it goes to
// dustinstohler1@gmail.com only, so it MAY carry the price paid and the
// expected vendor cost — that is the whole point of an internal fulfilment
// notice — but it still must not name the vendor, because D-312 is about what
// we write down, and an admin template is the one most likely to be copied
// into a customer-facing one later.
//
// Run: deno test --allow-read supabase/functions/send-measurement-ready/measurement-email-copy.test.ts

import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const HOMEOWNER = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);
const ADMIN = await Deno.readTextFile(
  new URL("../notify-measurement-order/index.ts", import.meta.url),
);

/** Vendor names retired from every served byte by D-312 / D-275 / D-274. */
const VENDOR_NAMES = [
  "RoofScope",
  "Roof Scope",
  "BoldSign",
  "DocuSign",
  "Mapbox",
  "EagleView",
];

/**
 * `hover` is special: the identifiers `hover_orders`, `get-hover-pdf` and
 * `hover_job_id` are table/function names that survive a vendor swap by
 * D-312's own principle ("code identifiers survive a vendor swap"), so a bare
 * substring search over the whole file would be a false positive. What must
 * not appear is the vendor's name inside the copy the recipient READS.
 *
 * So "customer-facing copy" is defined narrowly and mechanically: the subject
 * line, the plain-text body array, and the HTML template — and nothing else.
 * A first draft of this test scanned every quoted string in the file instead,
 * and reported two failures that were a code comment mentioning "$150" and a
 * `.select("… report_url")` column list. Both were false. Scoping the
 * extractor is the difference between a test that measures the copy and a
 * test that measures the file.
 */
function region(src: string, startMarker: string, endMarker: string, label: string): string {
  const a = src.indexOf(startMarker);
  if (a === -1) throw new Error(`${label}: start marker not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  if (b === -1) throw new Error(`${label}: end marker not found: ${endMarker}`);
  return src.slice(a, b);
}

/** Strips `// …` line comments, which are not copy. */
function stripLineComments(s: string): string {
  return s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
}

function homeownerCopy(): string {
  return stripLineComments(
    region(HOMEOWNER, "const subject = ", "const htmlBody", "homeowner text") +
      "\n" +
      region(HOMEOWNER, "function buildEmailHtml", "\nserve(", "homeowner html"),
  );
}

function adminCopy(): string {
  return stripLineComments(
    region(ADMIN, "const textBody = [", '].join("\\n");', "admin text") +
      "\n" +
      region(ADMIN, "function buildEmailHtml", "\nserve(", "admin html"),
  );
}

Deno.test("gh-1412 / D-312: the homeowner email names no third-party vendor", () => {
  const prose = homeownerCopy();
  for (const v of VENDOR_NAMES) {
    assert(
      !new RegExp(v.replace(/\s/g, "\\s*"), "i").test(prose),
      `D-312: vendor name ${JSON.stringify(v)} appears in homeowner-facing copy`,
    );
  }
  assert(
    !/\bhover\b/i.test(prose),
    "D-312: the retired vendor's name appears in homeowner-facing copy " +
      "(code identifiers like hover_orders are fine; prose is not)",
  );
});

Deno.test("gh-1412 / D-312: the admin email names no third-party vendor either", () => {
  const prose = adminCopy();
  for (const v of VENDOR_NAMES) {
    assert(
      !new RegExp(v.replace(/\s/g, "\\s*"), "i").test(prose),
      `D-312: vendor name ${JSON.stringify(v)} appears in admin email copy`,
    );
  }
  assert(
    /measurement vendor/i.test(prose),
    "the admin email should refer to the fulfilment source generically " +
      "('measurement vendor'), which is what makes the D-312 assertion above " +
      "meaningful rather than vacuous",
  );
});

Deno.test("gh-1412 / D-317 cl. 3: the homeowner email quotes no money", () => {
  // Dustin: "I don't want extra costs hiding in a list." Prices live in the
  // bid view. A delivery notice that quoted a figure would be a second,
  // unreconciled place a homeowner reads a number.
  const prose = homeownerCopy();
  assert(
    !/\$\s*\d/.test(prose),
    "D-317: a dollar figure appears in the homeowner report-ready email",
  );
  assert(
    !/vendor[_ ]?cost|expected[_ ]?cost|homeowner_price/i.test(prose),
    "D-317 cl. 6 / cl. 4: the homeowner email must not surface what the " +
      "report cost us — that is the margin, not the customer's business",
  );
});

Deno.test("gh-1412 / D-317 cl. 6: the homeowner email links the project, never the vendor artifact", () => {
  const prose = homeownerCopy();
  assert(
    !/report_url|signedUrl|get-hover-pdf/i.test(prose),
    "D-317 cl. 6: the vendor's report is never shown to any party — the " +
      "email must not carry a path or link to it",
  );
  assert(
    /report_uploaded/.test(HOMEOWNER),
    "the email may report EXISTENCE (a boolean) — this assertion pins that " +
      "the code still sends the boolean rather than the path",
  );
});

Deno.test("gh-1412 / gh-1824: BOTH emails carry the postal address from the single constant", () => {
  for (const [name, src] of [["homeowner", HOMEOWNER], ["admin", ADMIN]] as const) {
    assert(
      src.includes('from "./email-footer.ts"'),
      `${name} email must take its postal address from the shared constant`,
    );
    assert(
      src.includes("footerPostalAddressText()"),
      `${name} email's PLAIN-TEXT body must carry the postal address`,
    );
    assert(
      src.includes("footerPostalAddressHtml()"),
      `${name} email's HTML body must carry the postal address`,
    );
  }
});

Deno.test("gh-1824: neither template hard-codes an address of its own", () => {
  // The whole point of the constant is that #1824's answer is one line. A
  // literal street address in either template would defeat that.
  for (const [name, prose] of [["homeowner", homeownerCopy()], ["admin", adminCopy()]] as const) {
    assert(
      !/\d{3,5}\s+[A-Z][a-z]+\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Suite|Ste|Boulevard|Blvd)\b/.test(
        prose,
      ),
      `${name} email appears to hard-code a street address; it must come from ` +
        `POSTAL_ADDRESS in email-footer.ts`,
    );
  }
});
